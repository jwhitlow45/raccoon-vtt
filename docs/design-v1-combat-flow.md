# raccoon-vtt v1: combat flow

Status: draft 4, after design review rounds 1 and 2, with the project owner's answers of 2026-10-15 and the review's defaults (section 10). Code is cited from the `bar-dock` tip at `d1acdaf0`, which this design builds on and never undoes (docs/design-v1-bar-dock.md).

After the group's first real session, the project owner asked for six changes to combat:

1. "The round counter header, as well as start/previous round buttons, should be a sticky header for the section that is the large list of combatants in initiative. Not once we have scrolled past that section though." (section 3.1)
2. "Auto initiative should come immediately after the round section that contains all of the combatants." (section 3.2)
3. "Show AC on tokens and in initiative tracker." This design covers the tracker. The token is docs/design-v1-token-panel.md's. (section 3.3)
4. "Healing a token should make them not dead automatically (or this should at least be a setting for the DM to set)." (section 3.4)
5. "When a character is dead, there should be an option in the pop up menu when clicking on them to revive them." (section 3.5)
6. "Add better support for spiritual weapons, familiars, and other non-PC, PC controlled entities (as examples I use a wildfire spirit and others in our party use spiritual weapon). Spiritual weapon should not show in initiative tracker, and wildfire spirit shares initiative with the player (as do many other familiars). Just those kinds of features." (section 3.6)

Two designs run beside this one: docs/design-v1-token-panel.md (the token panel, stat blocks, the token action bar, AC on tokens) and docs/design-v1-layout-hierarchy.md (landscape tool options, the collapsible sidebar, the handout viewer, and the hierarchy pass for every panel and bar the other two do not own). Section 6 lists every line where this design meets them.

## 1. Answers in short

- **Sticky round header.** The tracker's round header (round, timer, whose turn, Previous and Start or Next, or End turn) sticks to the top of the panel while the combatant list scrolls under it, inside the round section only, so once the list's end scrolls past, the header leaves with it. On a short panel it shrinks to one row, and on a very short one it scrolls with the list, so a row always shows under it.
- **Auto initiative next.** The DM's Auto initiative section moves to just after the round section, with the card that shows what it rolled. The rest of the tracker is ranked by how often each part is used.
- **AC in the tracker.** Each row shows the AC shield the token panel design defines, first on the row's second line, and a screen reader hears it as the row's description. The DM sees it on every row, a player on their own creatures (decided by the project owner).
- **Healing the dead.** A room setting, "Healing brings back the dead", on by default in every room, existing ones included (decided by the project owner). A heal, or a set of current HP, that leaves a dead creature above 0 HP brings it back with that HP. Off keeps the rules as written, and the HP entry says so before anything is sent.
- **Revive.** A dead creature's action bar (the menu a tap on a token opens) shows Revive beside its Dead tag, for the DM. So do the options of its tracker row. Revive gives exactly 1 HP, clears death saves and keeps every other condition.
- **Companions.** A token can belong to a character as its companion: a creature (a Wildfire Spirit, a familiar) or an effect with no HP (Spiritual Weapon). It takes one of three turns: its own turn (a row of its own), on its character's turn and listed under it, or on its character's turn and not listed. Whoever plays the character controls it. A player adds one from their character in the Characters panel, next to their character's token, and the DM is told in the log. The DM can make any token a companion in its panel.

## 2. Current behavior

### 2.1 The tracker panel

- `TrackerPanel` (`client/panels/TrackerPanel.tsx:74-95`) stacks, in order: one section with the turn controls, the DM's auto initiative card and the list (`:76-80`), "Several at once" (`:81`), "HP changes" (`:82-86`), then for the DM `DmTools` (`:87-88`) and for a player "Join the fight" (`:90`), then "This device" (`:92`).
- `DmTools` (`:422-507`) holds "Add to the fight" (`:444-448`), "Auto initiative" (`:449-451`), "Initiative" with Type several values, Fill monster scores and the scores switch (`:452-476`), "Turn timer" (`:477-485`) and "End" (`:486-504`). So Auto initiative sits four sections below the list, past Several at once, HP changes and Add to the fight.
- `TurnControls` (`:111-159`) is a plain flex row at the top of the first section. It scrolls away with everything else. The panel scrolls in the sheet's body (`client/components/Sheet.tsx:108`, padding 4 px on top and 16 px at the sides, under a 56 px header, `client/components/SheetHeader.tsx:84`) or, from 900 px up, in the side panel's tab body (`client/pages/Room.tsx:1333`, 16 px all round). Nothing in the tracker is sticky today.
- The DM's auto initiative card (`AutoInitiativeResult`, `client/features/encounter/AutoInitiative.tsx:120`) sits between the turn controls and the list (`TrackerPanel.tsx:78`).

### 2.2 AC in the tracker

A row shows `AC 15` as plain muted 13 px text on its second line, for the DM only (`client/features/encounter/Row.tsx:137`), between the HP readout and the tags. That line sits inside the row's button, whose `aria-label` names only the creature and its turn (`Row.tsx:99-103`), so a screen reader never reads the HP or AC there. A player's device holds AC only for creatures they own: other players' copies of a token or character carry `life`, effects and HP alone (`shared/project.ts:473-479`), while owners get the whole actor but the DM's notes (`:487-490`).

### 2.3 Death, dying and healing

All in `shared/rules/hp.ts` (design 9.6):

- **Reaching 0 HP** (`reachZero`, `:117-125`): an object just sits at 0. A monster or NPC becomes `dead` when `monstersDieAtZero` is on (the default, `shared/model.ts:167`). A PC, or a monster with the setting off, becomes `dying`, gains the Unconscious that 0 HP brings (id `unconscious@0`, `:12`) and starts death saves at 0 and 0. Falling Unconscious ends concentration.
- **Massive damage** (`:146`, `:165-168`): damage left over past 0 that is at least the HP maximum kills at once, for a PC too.
- **Death saves** (`applyDeathSaves`, `:248-261`): three successes make the creature `stable`, three failures `dead`. Damage at 0 adds failures (`:169-183`).
- **Becoming dead** (`setLife`, `:95-110`) removes the 0 HP Unconscious, keeps conditions applied by hand, and ends concentration.
- **Healing** (`applyHeal`, `:194-206`): from 0 while `dying` or `stable`, the creature becomes `alive`, loses the 0 HP Unconscious and its death saves clear, with an `hp` line and a `life` line ("is back on their feet", `shared/logText.ts:164`). On a `dead` creature it returns the actor unchanged (`:195`): no HP, no line, nothing. `actorHp` then writes nothing (`shared/reducer/actors.ts:32`), so the DM's heal on a dead goblin silently does nothing.
- **Setting HP** (`applyHpSet`, `:219-245`): rising from 0 revives a dying or stable creature. A dead one stays dead with whatever HP is set (`:232`), and the set still writes its `hp` line (`:242-244`). So a dead creature can hold HP above 0.
- **Revive** (`applyLife`, `:267-281`): the DM's `actor.life` op. `alive` sets HP to `Math.max(1, cur)` (`:269`), so a dead creature holding HP keeps it, clears death saves and removes the 0 HP Unconscious. It writes a `life` line only. Players may not send `actor.life` (`shared/permissions.ts:303`, design 8.1 "Owners, except actor.life").
- **Bloodied** is `cur <= floor(max / 2)` (`:39`), so a creature with 0 of 0 HP reads Bloodied.
- **The HP entry** parses what is typed before the chosen mode: `+5` heals and `-7` damages whatever mode is chosen (`client/features/tokens/hpInput.ts:75-78`), and its preview line says what it will send (`HpSection.tsx:115`).
- **Skip defeated** (`shared/rules/initiative.ts:146`): Next passes over `dead` rows, PCs included, when `skipDefeated` is on (the default).

SRD 5.2.1 (Playing the Game, Damage and Healing) agrees with the code: a creature at 0 HP that regains any Hit Points stops dying and is no longer Unconscious, a monster normally dies at 0 HP, and a dead creature comes back only through magic such as the Revivify spell, which returns it with 1 Hit Point.

### 2.4 Revive in the UI

The only Revive is in the token panel's Hit points section, for the DM (`LifeControls`, `client/features/tokens/HpSection.tsx:205`, `:274-288`), with Stabilize and Mark dead. The token action bar shows the HP line with a Dead tag (`client/canvas/TokenActionBar.tsx:122-126`, `:159-164`), death save pips only while dying (`:165-171`) and the HP entry (`:195`), and no Revive. The tracker row strikes a dead creature's name and dims its portrait (`Row.tsx:80`, `:120-131`), and its options (`:381-445`) have no Revive.

### 2.5 Creatures a player controls

There is no notion of a companion today. A familiar or a Wildfire Spirit is an ordinary token that the DM places and gives an owner (`TokenPanel.tsx:319-353`). Its kind is NPC or monster, so the DM's own rules apply:

- **Who makes it.** Only the DM. A player may create only a plain PC token of a character they own, and only with `playersCreateCharacters` on (`placeTokenCheck`, `shared/permissions.ts:922-952`), which checks the scene's bounds and nothing else about where it lands. `token.create` writes no log line (`shared/reducer/tokens.ts:41-83`).
- **What its owner may do.** Move it, change its HP (`actor.hp`, `:428-435`), conditions and the owner fields (`OWNER_TOKEN_FIELDS`, `:60`), but not rename it (`:422`, a PC only), not edit its stats (an inline actor is the DM's, `client/features/tokens/access.ts:20`), and not delete it (`token.delete` is the DM's, `:302`).
- **In the tracker.** "Everyone here" and "Visible to players" add every creature on the scene but objects and the dead (`client/features/encounter/logic.ts:416-431`), so a Spiritual Weapon token joins the fight. Its player's "Join the fight" lists it too (`:434-440`), as does the group bar's Add to the fight (`client/features/tokens/groupEdit.ts:197-200`). Each gets a row of its own, with its own value, which its player types (auto initiative skips tokens a player owns, `client/features/encounter/autoRoll.ts:108`). Nothing ties a Wildfire Spirit's turn to its druid's. Its Reaction is its row's `reactionUsed` (`shared/model.ts:1050`), which Next clears when its turn starts (`shared/reducer/encounter.ts:279`), and Ready and "It fired" work through that row (`client/features/encounter/ready.ts:41-58`, `client/features/tokens/EffectsSection.tsx:324`).
- **Durations** count the anchor creature's row (`shared/rules/durations.ts:27-36`, `:50-62`). A creature with no row has its durations paused. A duration bound to a row keeps only the row's id (`:115-126`).
- **Party sight.** A token a player owns lends the party its sight, ranked for the cap of 12 sources a scene (`shared/limits.ts:120`) as player characters, then other creatures players own, then creatures the DM marked (`shared/rules/vision.ts:173-190`, group at `:179`). An object lends none unless the DM marks it (`:182`).
- **Undo and Previous.** A restore writes each saved entity as it was (`restore`, `shared/reducer/misc.ts:56-92`), checked only for guards and for references that exist. Previous writes the saved encounter back whole (`encounterPrev`, `shared/reducer/encounter.ts:336`), rows included, without the checks `buildEntry` makes.
- **Numbering.** A new NPC or monster is numbered among the tokens of its name on its scene, hidden ones included (`autoNumber`, `shared/reducer/tokens.ts:24-39`), unless the op gives a number (`:79`), and an update may set one (`:147`).

## 3. New behavior

### 3.1 The round header sticks to its section

The point: "The round counter header, as well as start/previous round buttons, should be a sticky header for the section that is the large list of combatants in initiative. Not once we have scrolled past that section though."

- **What sticks.** `TurnControls` as it is: "Round N", the timer, the whose-turn line, and Previous with Start or Next for the DM, or End turn for a player on their turn. Nothing is added to it, so its names, roles and keyboard order stay.
- **Where.** It stays the first child of the round section, the `Section` that holds the list (`TrackerPanel.tsx:76`), and takes `position: sticky`. A sticky box never leaves its parent, so the header sticks while any part of the round section is in view and scrolls away with the section's end. That is the "not once we have scrolled past" rule, and it needs no script.
- **Flush with the top.** A sticky box keeps inside its scroller's padding (the lesson of `client/features/rolls/PlayerRolls.tsx:443-449`). So the two scrolling bodies, the sheet's (`Sheet.tsx:108`) and the side panel's (`Room.tsx:1333`), carry `data-pane-body` and publish their padding as CSS variables, `--pane-pad-top` (4 px and 16 px) and `--pane-pad-x` (16 px for both). The header takes `top: calc(-1 * var(--pane-pad-top))`, a matching negative margin, and padding that gives the room back, so at rest it sits where it does today and stuck it meets the scroller's top edge. Its opaque `surface` fill reaches across the side padding, so no row shows beside or above it. A 1 px `border` line under it separates it from the rows.
- **Above the rows.** A new token `theme.z.stickyHeader`, 3, above a row being dragged (2, `Row.tsx:91`), so a row dragged upward passes under the header. The style drift test allows no z-index above 2 outside `theme.z`.
- **Room for rows.** The section measures three things with a ResizeObserver, each with its borders: the scroller (`closest("[data-pane-body]")`, its `clientHeight`, padding included), the header, and a standard row with the gap after it. A standard row has no companions under it and its options closed (`data-standard-row`), and is 58 px: its 56 px line and two 1 px borders, with no gap between rows. The full header is 56 px in a sheet: the pane's 4 px top padding it takes back, the two-line heading beside the 44 px buttons, 7 px under them and its 1 px border line. In the side panel, whose top padding is 16 px, it is 68 px. The compact header is the same padding, one 44 px row and the border: 49 px in a sheet, 61 px in the side panel. The header takes one of three forms:
  - **Full and sticky** while the scroller holds the full header and two standard rows: 172 px in a sheet, 184 px in the side panel.
  - **Compact and sticky** while it holds the compact header and two standard rows: 165 px in a sheet, 177 px in the side panel. The compact header is one 44 px row, with "Round N" in bold, the timer and the whose-turn line on one line that ends in an ellipsis, beside the same buttons. The whole whose-turn text stays in the element, so a screen reader reads all of it.
  - **Full and not sticky** below that: it scrolls with the list, as today.

  **Notices that pass.** In the very short sheet, "Your turn" and a toast push the body down for a few seconds (docs/design-v1-layout-hierarchy.md 4.2), which is just when End turn or Next is wanted. So the scroller counts the room they take as its own (`modalSlot.tsx` `passingNoticesPx`), and the header keeps its form while they show. A notice that lasts, such as the offline banner or "Viewing as Pat", keeps its room taken.

  **The invariant.** With two standard rows of room under a stuck header, every scroll offset shows at least one whole standard row: the header hides at most part of one row, and the next row starts within one row interval of the header's bottom and ends within two. A taller row, one with companions under it or its options open, may not fit whole under the header at every offset. Its controls stay reachable, since focus scrolls them clear of the header (the scroll margin below).

  The sheet itself follows docs/design-v1-layout-hierarchy.md, including its very-short-sheet fallback (its 4.2): where a sideways sheet's body would be under 88 px below its header, the panel opens as a full-screen modal sheet over the bars. The form is always chosen from the measured sizes. The table gives the sizes the app is checked at, as docs/design-v1-layout-hierarchy.md 8.1 gives them: layout px rounded down, with the 52 px top bar, the 48 px turn band where it is one, the 60 px toolbar plus the home bar inset, the sheet's 56 px header, and a sideways sheet's two 1 px borders. The full-screen modal draws no border. A font, an inset or the room's name moves them by a few px. Rows marked "about" are worked out rather than measured, since the turn band shows on a phone held sideways only once the top bar's row has overflowed (`band.ts`). The last column is the room under a stuck header, and how many whole standard rows it shows at any scroll.

  | Layout | Sheet | Scroller | Form | Room under it |
  | --- | --- | --- | --- | --- |
  | 390 x 844, bottom sheet, 34 px home bar | Sheet | 448 | Full, sticky | 392 px, 5 rows |
  | 390 x 844 at 130% | Sheet | 332 | Full, sticky | 276 px, 3 rows |
  | 844 x 390 at 100%, right sheet, 47, 47 and 21 px insets | Sheet | 199 (390 − 52 − 81 − 56 − 2) | Full, sticky | 143 px, 1 row |
  | the same with the turn band | Sheet | about 151 | Not sticky | the list scrolls with it |
  | 844 x 390 at 130% (649 x 300) | Sheet | 109 | Not sticky | the list scrolls with it |
  | the same with the turn band | Modal (the sheet's body would be about 61) | about 223 | Full, sticky | about 167 px, 1 row |
  | 667 x 375, no insets | Sheet | 205 | Full, sticky | 149 px, 1 row |
  | 667 x 375 at 130% (513 x 288) | Sheet | 118 | Not sticky | the list scrolls with it |
  | the same with the turn band | Modal (the sheet's body would be about 70) | about 232 | Full, sticky | about 176 px, 2 rows |
  | 480 x 320, 47, 47 and 21 px insets, with the turn band its top bar overflows into | Modal (the sheet's body would be 81) | 243 | Full, sticky | 187 px, 2 rows |
  | 480 x 320 at 130% (369 x 246), band or not | Modal (always) | 169 | Compact, sticky | 120 px, 1 row |
  | the same while the modal's header stacks (five buttons: a token selected and an alert waiting) | Modal | 147 | Not sticky | the list scrolls with it |
  | 932 x 430, short side panel (docs/design-v1-layout-hierarchy.md 4.1) | Side panel | 243 for the DM, 348 for a player | Full, sticky | 175 px, 2 rows, for the DM |
  | 1280 x 800, side panel | Side panel | 436 for the DM, 693 for a player | Full, sticky | 368 px, 5 rows, for the DM |

  The modal's header stacks by how many buttons it holds (docs/design-v1-layout-hierarchy.md 4.2), not by a token being selected. At 480 x 320 at 130% its row is 275 px, the whole width inside the side insets, since the modal draws no border. The title and four buttons need 240 px and five need 288 px, so four buttons fit and five stack: All panels, Hide and Close with the bar's button ("Show Goblin 3 actions") stay on one row beside a shortened title, and the alerts summary as a fifth stacks the header.
- **Focus is never hidden under it** (WCAG 2.2 SC 2.4.11). The section sets `--round-header-h` on itself to the header's height while it sticks, else 0. One rule in `client/globals.css`, since inline styles cannot reach descendants, gives every focusable element inside the round section `scroll-margin-top: calc(var(--round-header-h) + 8px)`. A row reached by Tab or Shift+Tab scrolls into view below the header.
- **The other states.** With no fight there is no header. While the DM types several values, the form takes the list's place under the same header. Before Start it reads "Round 1" and "Press Start for the first turn" for the DM, and "The fight has not started yet" for a player (`logic.ts:289-294`).

### 3.2 The tracker's order

The point: "Auto initiative should come immediately after the round section that contains all of the combatants." The tracker is this design's, so the same pass ranks the rest of it by use (the layout design ranks every other panel).

How often each part is used in one fight, and where it goes:

| Part | DM uses it | Player uses it | Place |
| --- | --- | --- | --- |
| Next, Previous, round, whose turn, End turn | Every turn, dozens of times | Every own turn | Sticky header |
| The rows: HP, AC, conditions, a tap to open the bar | Every turn | Every turn, to read | Right under the header |
| A row's value box | Once per row | Once for their own | In the row |
| A row's options (hidden, reaction, lair, Ready, reminder, stat block, legendary pips, tie order, Revive, Remove) | A few times | Reaction and Ready, a few times | Behind the row's ⋯, as today |
| Auto initiative, with what it rolled | Once, and per reinforcement | Never | Right after the round section (the owner's point) |
| Initiative: Type several values, Fill monster scores, the scores switch | Once, or a setting | Never | After Auto initiative, since it does the same job of setting values |
| Add to the fight | At the start and per reinforcement | Never | Next |
| Join the fight | Never | Once, until they are in | Right after the round section, since it shows only until used |
| Several at once | Now and then, for an area | Rarely | Next |
| HP changes | Now and then, to read or take back | Now and then, to read | Next |
| Turn timer | A setting, once a session | Never | Low |
| End the fight | Once, and it is destructive | Never | Near the foot, armed as today |
| This device | Rarely | Rarely | Last |

So the DM's tracker reads: round section, Auto initiative (controls, then the result card), Initiative, Add to the fight, Several at once, HP changes, Turn timer, End, This device. A player's reads: round section, Join the fight, Several at once, HP changes, This device.

- **The result card moves.** `AutoInitiativeResult` leaves the round section (`TrackerPanel.tsx:78`) and sits in the Auto initiative section under its button, where the DM just pressed. The list then starts right under the sticky header, and the card still names each roll's dice, modifier and total. Its own rules (it lasts while one of its rows keeps the total it rolled, `client/features/encounter/autoState.ts:67`) do not change.
- **No section changes its name or contents** apart from that card. The DM's empty list still says "Add tokens below", which stays true.
- **Room for names in a narrow order.** A DM's tied row draws its drag handle in a 44 px slot before the row's button, and in a wide order an untied row keeps that slot empty so every name lines up. An order under 320 px wide, such as the very short sheet's 243 px, gives an untied row's slot to its name instead, and its options line up with the name the same way (`logic.ts` `keepsDragSlot`).

### 3.3 AC in the tracker

The point: "Show AC on tokens and in initiative tracker." Today only the DM sees AC there, as muted text among the tags, where it is easy to miss.

- **The badge.** Every row whose actor carries `ac` in the viewer's copy shows the shield badge the token and its panel use, `AcBadge` at its dense `sm` size (from the new `client/components/AcBadge.tsx`, docs/design-v1-token-panel.md 3.9, which sizes it to its number from 0 to 100), as the first item of the row's second line, before the HP readout. It replaces the `AC 15` text (`Row.tsx:137`). It is `role="img"` named "Armor Class 15".
- **Read aloud.** The row's second line gets an id, and the row's button points `aria-describedby` at it, so a screen reader reads "Armor Class 15", the HP and the tags as the button's description after its name. The button's name stays as it is (`Row.tsx:102`). Nested companion sub-rows (3.6.7) do the same.
- **Who sees which.** Decided by the project owner (section 10): the DM sees every row's AC, and a player sees AC on their own creatures' rows, companions included (3.6), which are the only AC values that reach their device (2.2). No projection changes for AC.
- **No badge** on a row whose creature's AC this viewer lacks, whose AC is 0 (an effect companion, 3.6.6), or whose creature is dead. A corpse's AC answers nothing, and the map's badge hides on the dead too (docs/design-v1-token-panel.md 3.9 and its Decided item 5). Revive brings it back on both.

### 3.4 Healing brings back the dead

The point: "Healing a token should make them not dead automatically (or this should at least be a setting for the DM to set)." The project owner decided: on by default, existing rooms included, with the setting to turn it off (section 10).

The silent no-op is the worst of both: the DM types a heal, nothing happens, and nothing says why. Tables bring creatures back by healing in practice: Revivify returns a creature with 1 HP, the same as a heal of 1, and a mistaken kill is fixed by healing. The rule as written stays one switch away.

- **The setting.** `RoomSettings.healRevives`, in Room settings under Combat after "Monsters die at 0 HP" (`client/features/settings/form.ts:88-93`): "Healing brings back the dead", help "Healing a dead creature, or setting its HP above 0, brings it back with that HP. Off follows the rules as written: healing does nothing to the dead, and only the DM's Revive brings a creature back." An absent value reads as on, so every existing room gets it without a migration (4.7 keeps replay exact). The switch shows an absent value as on, and every reader, the rules, the switch and the lines in 3.5, asks one helper (`healRevivesDead`, 4.3).
- **Heal, setting on.** On a `dead` creature the new current HP is `min(max, cur + amount)`. When that is above 0, the creature becomes `alive` with it, its death saves go to 0 and 0, and the 0 HP Unconscious goes if it is somehow there. Every other condition stays, and concentration ended at death stays ended. The log gets the `hp` heal line with the new label and the `life` line, as a heal from dying writes today. When the new HP is still 0, which only a maximum of 0 gives, the heal does nothing, as today.
- **Set, setting on.** A set that names a current HP, on a dead creature, clamps it as today (`min(max, max(0, cur))`). When the clamped HP is above 0 the creature comes back as a heal brings it back, and the `hp` set line comes first, as for a dying creature (`hp.ts:237-244`). A set of the maximum alone, of temporary HP alone, or of a current HP that clamps to 0 leaves it dead.
- **Heal, setting off.** As today: nothing changes and no line is written.
- **Set, setting off.** As today: the HP changes, the creature stays dead, and the `hp` set line is written.
- **Who.** Whoever may heal the creature now: the DM, its owners, and with `playersApplyDamage` any player who can see it. No permission changes. A player who owns a dead character can therefore bring it back by healing while the setting is on, as the table chose.
- **Several at once.** A heal sent to a group goes through `actor.hp` for each, so a dead creature in the group comes back too, when its result is above 0. The DM leaves it out of the selection to keep it dead. The HP entry's preview says so before it is sent (3.5).
- **Take back and undo** need nothing new: the HP line's `revert` holds the dead vitals (`shared/reducer/hpUndo.ts`), and the DM's undo restores the whole actor.
- **Rests** still need a living creature (`shared/rules/rest.ts`). Damage to the dead still does nothing (`hp.ts:134`).

### 3.5 Revive where a tap lands

The point: "When a character is dead, there should be an option in the pop up menu when clicking on them to revive them." The menu a tap on a token opens is its action bar.

- **In the action bar**, for the DM, while the creature is `dead`: a Revive button follows the Dead tag on the vitals line, which docs/design-v1-token-panel.md 3.3 places (it replaces today's HP line, `TokenActionBar.tsx:159-164`), so it shows only when it applies and moves no other button. Its name is its text. A visible line under the vitals, "Revive brings it back with 1 HP.", is its description (`aria-describedby`), so nothing depends on a tooltip. It sends `actor.life` `alive`, which the DM's device predicts at once.
- **In the tracker row's options**, for the DM, while the row's creature is dead: the same Revive and line, first in the options (`Row.tsx:381`). This covers a row whose token is on another scene, which has no bar in this view.
- **Focus after Revive.** Revive goes with the death it undoes, so focus would fall to the page. Once it is gone, focus moves to the bar's frame, which announces the bar, as the dock's Show does, or in the tracker to the row's own button (a companion's sub-row button for its options), the options staying open. The token panel's Revive, Stabilize and Mark dead each go with the state they change, and focus moves to the Hit points section's HP line (focusable from script alone) the same way. Never to the HP field: in a text field Ctrl+Z is the field's own and would not take the Revive back, and on a phone the field opens the keyboard. Focus moves only when the pressed button had it and nothing else took it meanwhile, so a tap on a phone moves nothing (`client/lib/handFocus.ts`).
- **Two Revive buttons** show from 900 px up when the token panel is open on a dead creature beside its bar: the bar's and the Hit points section's (`HpSection.tsx:279`). Each sits in its own named container, the bar's dialog ("Thorn actions", `role="dialog"`) and the Token tab's panel (`role="tabpanel"`, named by its tab, `Room.tsx:1333`), and both do the same thing to the same creature. The Hit points section is not made a region of its own. The first press revives it, and both go at once, since it is no longer dead.
- **What Revive sets.** Exactly 1 HP, as the project owner's answer and Revivify give (section 10). `applyLife` with `alive` (`hp.ts:267-271`) changes for ops at op version 5 and later: on a creature that is not alive, HP becomes 1 whatever it held, where today it keeps `Math.max(1, cur)`. On a creature already alive it changes nothing new (it keeps today's `Math.max(1, cur)`). Death saves go to 0 and 0, and the 0 HP Unconscious goes. Every condition applied by hand stays, since a revived creature is still Poisoned or Exhausted unless the DM removes it. It writes "is back on their feet." Ops stored before version 5 replay with `Math.max(1, cur)` (`reviveToOne`, 4.3). Ctrl+Z takes it back as any DM change. A larger heal, such as Resurrection's, is a heal after it.
- **Who.** The DM only, as `actor.life` is today. A player is not offered Revive. With the setting on, the owner heals instead.
- **What a player sees on a dead creature's bar.** A player who may heal it (its owner, or anyone under "Players can apply damage and healing", whose bar has the HP entry, `TokenActionBar.tsx:195`, `access.ts:99`) gets a line under the vitals in place of Revive's: with the setting on, "Healing brings Bree back." With it off, "Healing does nothing while Bree is dead. Only the DM's Revive brings Bree back." The DM gets only Revive's line.
- **What a viewer may not send shows at once.** Under `relative` access (a player under "Players can apply damage and healing"), typed math that asks for a set or temporary HP, such as `=12`, shows "You can only deal damage to or heal this creature." in the summary's place as soon as it parses, and Apply waits for something the player may send.
- **The HP entry's lines follow what will be sent**, not the chosen mode: the operation is the preview's (`preview.change.kind` when the typed text parses, `HpSection.tsx:55`), and the chosen mode only before anything parses. So `+5` typed under Damage counts as a heal, and `-7` under Heal as damage. The same logic serves one target and a group (`GroupHpEntry`), one helper in `client/features/tokens/groupHp.ts` over the targets' new `dead` flag and HP maximum:
  - **A heal, setting on**, with dead targets whose maximum is above 0 (or unknown to this viewer): the preview adds "Brings back 1 dead creature." or the count.
  - **A set of a current HP above 0, setting on**: the same count.
  - **A heal, setting off**, with a dead target: "Healing does nothing while Thorn is dead.", with "Revive Thorn first." for the DM. For a group, "Healing does nothing to the 2 dead among them."
  - **A set, setting off**, with a dead target: "Thorn stays dead at the new HP. Only Revive brings Thorn back." For a group, the same with the count.
  - Damage, temporary HP and a set of the maximum alone add no line.
- **Dying and stable** creatures are unchanged: their bar shows death save pips while dying and a "Stable" note while stable, with the HP entry, and a heal brings them back. Revive stays in the token panel for them (`HpSection.tsx:279`).

### 3.6 Companions

The point: "Add better support for spiritual weapons, familiars, and other non-PC, PC controlled entities (as examples I use a wildfire spirit and others in our party use spiritual weapon). Spiritual weapon should not show in initiative tracker, and wildfire spirit shares initiative with the player (as do many other familiars). Just those kinds of features."

#### 3.6.1 What a companion is

A token that belongs to a character: `Token.companion = { of: characterId, turn }`. It has its own stats (an inline actor, never a character's), so its HP and conditions are its own. It is never a PC token. It stands on a scene like any token, and its character may stand on the same scene or another. Only a character has companions: the DM's own creatures, such as a necromancer's skeletons, keep their own rows as today.

A companion is one of two things, by its kind:

- **A creature**, kind `npc` (or `monster`, for one the DM made from a stat block): a Wildfire Spirit, a familiar, a sidekick. It has HP and AC like any NPC.
- **An effect**, kind `object`: Spiritual Weapon, a spell's moving force. It has no HP and no AC (3.6.6) and lends no sight (3.6.5).

#### 3.6.2 Its turn

Tables run familiars both ways, as the project owner notes, so the turn is chosen per companion:

| `turn` | UI label | Help | For |
| --- | --- | --- | --- |
| `shared` | On Bree's turn, listed under Bree | It acts on Bree's turn and shows under Bree in the initiative order, like a summoned spirit. | Wildfire Spirit, most summons, a familiar the table runs that way |
| `none` | On Bree's turn, not listed | It acts on Bree's turn and stays out of the initiative order, like Spiritual Weapon. | Spiritual Weapon, a spell's moving effect |
| `own` | Its own turn | It rolls its own initiative and joins the fight as a row of its own. | A familiar or sidekick with its own turn |

The labels name the character. They are a Select with the chosen one's help under it, the pattern of the auto initiative modes (`AutoInitiative.tsx:62-64`). A creature starts at `shared`, the project owner's Wildfire Spirit, and an effect at `none`. The start follows what it is until the user picks a turn. A picked turn stays when what it is changes, except that an effect never takes its own turn, which goes to `none`.

**One eligibility rule**, the same for creation, turn changes and kind changes, enforced by the reducer for everyone: **an effect takes no turn of its own.** So `turn: "own"` needs a creature kind, and a companion with its own turn cannot become an effect. HP edits do not enter into it: a creature keeps its kind whatever its HP, so an own-turn companion is always a creature, and the tracker's creature filters (`logic.ts:438`) always let it join. The way to give an effect a turn of its own is to make it a creature first (3.6.9), which also brings back its HP fields.

#### 3.6.3 Who makes one, and how

- **A player, for a character they own**, from the Characters panel: the character's open card gets a Companions section (3.7.5) with "Add a companion". It replaces the panel with a short form, as New character does (`client/features/tokens/CharactersPanel.tsx:56-67`): name (required), what it is ("A creature" or "An effect", a Segmented control), turn (3.6.2, with "Its own turn" offered only for a creature), size (Small by default), and for a creature HP (required, at least 1: "A creature needs at least 1 HP.") and AC (may be left empty, stored as 0), and a picture through the same image field as a new character's (`ImageField`). An effect has no HP or AC fields.
- **The form's shape.** One column no wider than the pane, so a long turn label shortens its Select rather than widening the form. The Turn Select sits under its label at the pane's full width, since its choices name the character twice. The fields start empty, with no example values that read as defaults, and the form has one Cancel, by its heading, as New character has. Opening it moves focus to its heading, and Cancel, or Add and place while the panel stays in sight, moves focus back to "Add a companion". New character and the DM's Make a companion hand focus over the same way, Make a companion into its first field and, once done, to its section's label.
- **A late answer.** Add and place waits for the server's answer. An answer that comes after Cancel, or after another panel was opened, adds the token and nothing more: it selects nothing and closes nothing, and a refusal then says why in a toast.
- **Where it goes** (settled by default, section 10, D1): only next to the character's token on the players' scene. "Add and place" puts it at the first free spot whose footprint lies within 5 ft (one cell) of the character's token, at the character's elevation, using `spreadPositions` and `occupiedBoxes` as Duplicate does. On a scene where walls stop moves (`blockMovement`), the spot also needs a clear line from the character: the new token, standing where the character stands, could step there (`movementRules.legBlocker`, `shared/rules/movement.ts:372`). It then selects the new token, which opens its bar, and closes the sheet so the player can drag it on. The button is disabled with a reason under it when it cannot place: "Bree has no token on the map." when the character has no token on the players' scene, "No room next to Bree." when no spot qualifies, and "No map to place it on yet." while the players have no scene or a blackout is on. It is busy until the server answers, and a refusal keeps the form open with the reason (`useSendAnswered`, `client/features/encounter/hooks.ts:68-82`).
- **The server enforces it** (4.4): a player's companion must stand within 5 ft of a token of its character on the same scene, with a clear line on a scene that blocks moves. The DM is told: the reducer writes a `companion` log line, "Ana added Wildfire Spirit beside Bree.", that only the DM's projection carries, as the teleport line is (`shared/project.ts:1214`).
- **It needs no setting.** Summons arrive mid-turn, and waiting on the DM would stall the table (settled by default, section 10). The DM keeps every power over them (3.6.4). A character may have up to `LIMITS.companionsPerCharacter`, 10, on one scene: the cap counts its companions on the scene the new one goes to, so companions left on a scene the party has moved away from never block a new one (3.6.10).
- **The DM** uses the same form from any character's card, placing on the scene the DM views, next to the character's token when it stands there and in the middle of the DM's view otherwise. The DM's placement has no reach rule and writes no log line. The DM can also make any token that is not a PC a companion, with "Make a companion" in its panel's Token settings (3.6.9), such as an Owl placed from the Monsters panel with its full stat block. Making a token a companion also sets its ring to ally in the same patch when it was hostile.
- **Each new companion** from the form is an `npc` creature or an `object` effect, ally, on the creatures layer, alive and unhurt, with no conditions, DM notes, legendary actions or room monster. A creature's HP starts at its maximum. An effect's HP is 0 of 0 and its AC 0.
- **Companions carry no number.** Numbering looks at every token of the name on the scene, hidden ones included, so a player's new "Owl 2" would tell them a hidden Owl stands there. So a companion is never numbered, and numbering other tokens leaves companions out (`autoNumber`, `shared/reducer/tokens.ts:24-39`). Making a token a companion clears its inherited `number` first, in the same op, and only then checks the result, so a numbered Owl attaches. A number the op itself supplies is still refused with `invalid` ("a companion has no number"): a `token.create` with `companion` and `number`, or a `token.update` that names `number` while the token is or becomes a companion, for the DM too. Duplicate, `scene.duplicate` and an import copy companions without a number (4.3, 4.7). Two clerics' weapons are told apart by name, which their players may change.

#### 3.6.4 Ownership and control

- **A companion's owners are its character's owners.** The reducer writes the character's `ownerIds` onto the token when it becomes a companion, and keeps them in step: a `character.update` that changes the character's owners writes the same list onto each of its companions in the same op, walking tokens in id order so a replay writes the same keys in the same order. Ownership itself stays `token.ownerIds`, so every rule that reads owners (moving, HP, conditions, fog, party vision, End turn, roll requests, concentration prompts) treats a companion as any token its player owns, and no reader of ownership changes. An op that would give a companion other owners (`token.create` with a different list, or a `token.update` or `token.updateMany` that names `ownerIds` while the token stays a companion) is refused with `invalid`, "a companion is played by whoever plays its character". Detaching it (`companion: null`) leaves its owners as they were, for the DM to change.
- **Undo, redo and imports keep it so.** A restore writes saved values, so it could bring back a character's old owners while a companion made since keeps the new ones, or bring back a deleted companion with owners its character no longer has. This design reconciles rather than refuses, so an undo is never blocked by a companion: after a `sys.restore` applies, the reducer copies each affected character's owners onto every companion of it whose owners differ, in the same op, walking tokens in id order. The affected characters are those the restore wrote and those named by companion tokens it wrote. The same pass runs over an imported room (4.7). Stored restores from before companions find none and write nothing, so replay is unchanged.
- **Its owners may**, beyond what owners may do with any token: rename it, edit its stats (the actor fields an owner may edit on their own character, `OWNER_ACTOR_FIELDS`: HP, speeds, AC, initiative bonus, passive Perception, senses, notes, sheet link), change its `turn`, change its kind between creature (`npc`) and effect (`object`), mark its Reaction (3.6.8), and delete it ("Dismiss"). They may not change which character it belongs to, hide it, lock it, number it, or touch the DM's fields. A companion is to its player what their character is.
- **The DM may** do everything, as with any token, within the eligibility and numbering rules.
- **When the character's player leaves the roster**, `sys.memberRemove` already strips the member from every token and character (`shared/reducer/room.ts:82-93`), companions included, so the DM then runs them. A player made DM keeps their ids, as today.
- **When the character is deleted**, its companions are deleted with it, as its tokens are (`shared/reducer/tokens.ts:362-370`), rows included.

#### 3.6.5 What players see

- **The companion's owners** get the whole token, `companion` included, as owners do today.
- **Other players** get `companion` only while a member of kind player owns the token, the rule of the derived `party` flag (`playersToken`, `shared/project.ts:467-471`). Then the companion belongs to the party, and who plays which creature is no secret at the table. A companion of a character no player plays (a DM's NPC character) reaches players as a plain token, so no link between a DM creature and a character leaks. A table display, a player who owns nothing, follows the same rule.
- **HP.** A creature companion a player plays follows the party's rule for other players: exact when "Players see the party's HP" is on, else the label (`hpAccess`, `shared/project.ts:407-418`, gains this branch for a token with `companion` while `playersToken` holds). Its own `hpVisibility` then no longer applies, and the token panel says so (section 6). A token for which `hpLess` holds (3.6.6), an effect companion or any token at max HP 0, sends other players no HP at all, so 0 of 0 never reaches them as Bloodied. A companion no player plays keeps its own `hpVisibility`, as any DM creature does.
- **Sight** (settled by default, section 10, D2). A creature companion a player owns is a party member like any token a player owns (`isPartyMember`, `shared/project.ts:175-177`): above the fog, and lending its sight on a vision scene. An effect companion lends none, as the code already rules for objects (`shared/rules/vision.ts:182`). Under the cap of 12 sources a scene, companions rank last, after the creatures the DM marked: the ranking (`vision.ts:179`) gains a fourth group for tokens with `companion`, so a party's familiars never push out a DM's lantern bearer. Among companions, token id order decides, as within the other groups.
- Nothing about a companion reaches a player who cannot see the token, since the tracker's nesting reads only tokens in the viewer's copy, and the `companion` log line is the DM's alone.

#### 3.6.6 HP-less companions, and tokens at max HP 0

This design owns the rule, and the token panel, its bar and the map follow it (section 6). One shared predicate decides it, for both designs, in the same words as docs/design-v1-token-panel.md: `hpLess(actor, token?)`, in `shared/rules/hp.ts` beside `hpLabel`, is true for **a companion that is an effect, or any token with max HP 0**. It takes the resolved actor (a token's own, or its character's through `ref`, or a character card's with no token) and the token when there is one. It decides only from data the caller holds: the effect clause needs the token's `companion` and `kind`, and the max HP clause needs the actor's `hp`. Missing HP never counts as 0, so a creature whose HP this viewer may not see is not HP-less. It does not take every object, because an ordinary object may have HP of its own, such as a door or a chest the DM tracks, and keeps showing it. While `hpLess` holds:

- **The token panel's Hit points section** shows one line and nothing else: "No HP: it is an effect." for an effect companion, or "No HP yet." with the Max HP field for any other token at max HP 0, which is the way to give it HP. No current and maximum numbers, no life badge (so no Bloodied), no HP entry, no temporary HP field, no death saves and no life buttons.
- **The token action bar's vitals line** leaves HP out, and the bar has no HP entry.
- **The tracker** shows no HP readout and no AC badge for it.
- **The map** draws no HP bar or AC badge on it, and draws no dead or dying mark on any token of kind `object` (`client/canvas/TokenNode.tsx:239-290`). No HP rule moves an object from alive (`hp.ts:118`), but the DM's Mark dead can (`actor.life`, `HpSection.tsx:205`, `:274-288`). So the token panel's life buttons (Revive, Stabilize and Mark dead) are hidden on every token of kind `object`, companion or not, and so are the bar's and the row's Revive. An object then leaves alive only through an older stored state or a hand-made import, and the map shows nothing of it.
- **Other players** receive no HP for it (3.6.5). The server projects `life: "alive"` for an effect companion (kind `object` with `companion`) to every viewer who does not own it, the table display included, so no device without its `companion` field can be told it is dead.
- **Rules.** An effect never changes life state (`hp.ts:118`), and an area's damage leaves objects out by default (`client/features/areas/damage.ts:71-73`). A creature at 0 of 0 cannot reach 0 from above, so it never dies, and `hpLabel`'s Bloodied for 0 of 0 (`hp.ts:39`) is never shown, since nothing above draws it.

**Creature to effect, and back.** Making a creature an effect keeps its stored HP, AC, death saves and life as they are, and nothing shows them while it is an effect: no numbers, no life tag, no dead overlay, no Revive, no death saves, and no HP to other players. A living creature made an effect stays alive underneath. A dead one stays dead underneath, shows as an effect, reaches non-owners as alive, and lends no sight either way (3.6.5). Made a creature again, it shows them as they were, Dead and Revive included. So the change never writes the actor, and taking it back loses nothing.

A creature companion whose HP drops to 0 from above follows its kind's rule: an NPC dies there when "Monsters die at 0 HP" is on, which matches a summon that vanishes at 0 HP. Its owner dismisses the token, or heals it if the table says it lives.

#### 3.6.7 In the tracker

- **`own`**: an ordinary row in initiative order. Its second line gains a muted tag, "Companion of Bree", the words the token panel's name block uses (docs/design-v1-token-panel.md 3.10), for every viewer whose copy holds `companion`. Its player types its value. Auto initiative leaves it to them while a player owns it (`autoRoll.ts:108`).
- **`shared`**: no row of its own. It shows nested under its character's row, as a sub-row at least 44 px tall, indented past the drag handle: a button with portrait (28 px), name, and on its second line the AC badge, the HP readout, the condition chips and its "Reaction used" and "Readied" tags, struck through and dimmed when dead, as rows are. A tap does what a row tap does (`TrackerPanel.tsx:212-231`): it selects the companion and shows its bar on the map. Its button's name is "Wildfire Spirit, acts on Bree's turn. Show it on the map with its actions.", and its second line is its description (3.3). Beside the button, for the DM and the companion's owners, a ⋯ opens its options under it (3.6.8): "Reaction used", the Ready controls, and for the DM "Stat block" (through `openStatBlock`, docs/design-v1-token-panel.md 3.4) on a monster or NPC, and Revive while it is dead. It has no value box and no drag handle. For the DM, a companion hidden from players carries the Hidden tag. The sub-rows are a list inside the row's `li`, after the row's options when they are open, so the options stay under the ⋯ that opened them. The acting row's tint covers its companions too. Nested companions are the tokens in the viewer's copy with `turn` `shared` whose `companion.of` is the row's character, by the one parent resolver `rowCharacter(row)`: the character of the row's token when the row has a `tokenId` (its `actor.ref`, and none for a token with its own actor), and the row's `characterId` only for a row with no token, as the row's actor and name already resolve (`shared/rules/initiative.ts:31-38`, `client/features/encounter/logic.ts:185-194`). They are in name order. A companion on another scene, or one the viewer cannot see, is not nested.
- **`none`**: not in the tracker at all, nested or not, nor in the turn strip.
- **A `shared` companion whose character has no row** shows nowhere in the tracker. It joins the order when its character does.
- **Adding rows.** "Everyone here", "Visible to players" and "Selected token" (`logic.ts:416-431`), a player's "Join the fight" (`:434-440`) and the group bar's Add to the fight and Start a fight (`groupEdit.ts:197-200`) leave out companions whose turn is `shared` or `none`. The reducer refuses an `encounter.start` or `encounter.add` row for one with `invalid`, "it acts on its character's turn" (`buildEntry`, `shared/reducer/encounter.ts:49-73`), so no client can make one.
- **Changing a companion's turn** to `shared` or `none` takes its row out of the fight in the same op, as Remove from the fight would (`removeEntries`, `:146-173`, which passes an active row's turn on), and takes its rows out of the fight's history too (3.6.8). Changing it to `own` adds no row: its player joins it to the fight.

#### 3.6.8 Turn order effects

- **Whose turn.** A `shared` or `none` companion acts during its character's turn. The turn line, the timer, "Your turn" and End turn are the character's, and End turn ends the companion's part too.
- **Reaction.** A `shared` companion keeps a Reaction of its own, on its own token: `companion.reactionUsed`, present only while it is spent and only while its turn is `shared`. The sub-row's "Reaction used" switch sends its own minimal patch, `token.update { patch: { companionReaction: true | false } }`, which sets or clears only that flag and never touches `of` or `turn`. The reducer refuses it (`invalid`) unless the token is a `shared` companion as the op finds it, so a late press from a device that still showed the old turn changes nothing. So who may change it is the companion's own ownership (3.6.4), who sees it is whoever receives `companion` (owners always, other players while it is the party's, 3.6.5), and a device that holds the token predicts the change at once (4.6). Leaving `shared` drops the flag in the same op, detaching drops it with the `companion` object, and giving the companion to another character or deleting it takes the flag with the token. An import maps it with the token, with nothing to remap.
- **Reset.** Next clears it when the character's turn starts. The landing row's character is `rowCharacter(row)`, the same resolver nesting uses (3.6.7), so a row that names one player's token and another player's `characterId` resets only the token's character's companions. Next clears `reactionUsed` on every `shared` companion of that character standing on the row token's scene, or, for a row with no token, on the players' scene, in token id order, beside the row's own `reactionUsed` (`encounter.ts:279`). A companion on any other scene keeps its flag. Next records the ids it cleared in the saved encounter, `EncounterSnapshot.companionReactions`, as it records the tokens it revealed (`:291`). Previous sets the flag again on each of those tokens that is still a `shared` companion, and skips the rest, so a companion converted, detached or deleted since gets nothing back.
- **Ready, through one resolver.** `reactionTarget(view, target)`, a new pure helper in `client/features/encounter/ready.ts`, answers whose Reaction a creature spends and which row its Ready counts, as `{ kind, tokenId, entryId }`:
  - `kind: "row"` for a creature with its own row, `entryId` that row (and `tokenId` its token, if it has one),
  - `kind: "companion"` for a `shared` companion, `tokenId` the companion and `entryId` its character's row,
  - null outside the fight, and for a `none` companion, which has no Reaction controls since it is not listed.

  `readyOp` (`ready.ts:42-46`) anchors the `readied` effect to the answer's `entryId`, so a companion's Ready lasts until the start of Bree's next turn. `fireOps` (`:53-58`) takes the answer, removes the effect, and spends the Reaction it names, needing no other state: for `"row"`, `encounter.update { entryId, patch: { reactionUsed: true } }` as today, and for `"companion"`, `token.update { tokenId, patch: { companionReaction: true } }`, built from `tokenId` alone, never the character's Reaction. Both callers pass the resolver's answer: `ReadyControls` (`ReadyControls.tsx:22`, in a row's or a sub-row's options) and the token panel's "It fired: Reaction used" (`EffectsSection.tsx:324-327`, `:467`), which today passes the row `selfEntryId` finds (`ready.ts:36-39`) and so would spend Bree's Reaction for her spirit. The resolver replaces `selfEntryId`.
- **Durations** on a companion that acts on its character's turn count its character's row: `entryMatchesAnchor` (`durations.ts:27-36`) matches an anchor naming such a companion's token to its character's row, so "until the end of Wildfire Spirit's next turn" is stored against Bree's row and the chip reads "until the end of Bree's next turn". `anchorsForEntry` (`:149-163`) adds those companions' tokens to the character's anchors, so durations paused on a companion bind when its character joins the fight. When the character's row leaves, they pause on the character as Bree's own do (`pausedAnchorForEntry`), and bind again when it returns. The duration form's "itself" choice for such a companion reads "Wildfire Spirit (on Bree's turn)".
- **Durations when the companion changes.** A bound duration keeps only its row's id (2.5), so it cannot tell a duration that came from the companion from one chosen to count Bree. This design keeps every bound duration where it is:
  - **`own` to `shared` or `none`**: its row leaves, so durations on its row pause on the companion (`unbindFromEntry`, as Remove does) and the same op binds them to its character's row, if the fight has one.
  - **`shared` or `none` to `own`, detaching it, or giving it to another character**: durations already counting Bree's row keep counting it. Paused ones bind to its own row when it joins, or to its new character's row.
  - **Where the UI says so.** On the effect chips themselves, in the token's Conditions (and the tracker's chips): each chip names whose turn its duration counts ("until the end of Bree's next turn"), which stays true after the companion changes turn, is detached or is given to another character. No line is added to the Companion section, which a detached token no longer shows.
- **Previous never brings back a companion's row.** Previous writes a saved encounter and its saved effects back as they were (`encounter.ts:336-340`). So when a companion's turn becomes `shared` or `none`, or a companion is deleted (Dismiss, or its character's deletion), the same op rewrites every saved step in `encounterHistory`:
  - Its rows leave the saved encounter. Where the saved active row was one of them, its turn passes to the next row in that encounter's order, as `removeEntries` passes it, and that saved encounter's `turnStart` is dropped.
  - Every saved effect (the step's `effects`, keyed by holder) anchored to a removed row is rebound as the live ones were: to the character's row in that saved encounter, when the companion now acts on its character's turn and that row is there, else paused on the companion's token, as `removeEntries` pauses them (`pausedAnchorForEntry`). So an effect on another creature anchored to the companion's row never comes back counting a row that is gone.
  - Saved effects of a deleted token restore nothing, as today (`encounter.ts:370-380`), and its id in the saved `companionReactions` is skipped (above).

  So a DM who converts or dismisses a companion and then presses Previous gets the earlier turn without its row, and every duration counts a row that exists or waits paused.
- **A restore** that would write an encounter holding a row for a `shared` or `none` companion is refused with `invalid` ("could not undo …: a companion in it now acts on its character's turn"). The encounter's guard already refuses such a restore in practice, since removing the row changed the encounter. The undo of the conversion itself puts back the token and its row together, which passes.
- **Defeated characters.** With "Skip defeated creatures" on, Next passes over a dead character's row, and its companions with it, since they act on its turn. They stay listed under the struck-through row. A table that lets the spirit act on switches it to its own turn and adds it.
- **Not in this change** (settled by default, section 10): the turn start marker and the movement trail record only the acting row's token (`shared/rules/path.ts:22-33`), and an area's start and end of turn reminders only the acting row's token (`shared/reducer/areaTriggers.ts:127-151`). A companion moving on its character's turn draws no trail, and one standing in Spirit Guardians gets no reminder.

#### 3.6.9 The token bar and the token panel

- **Dismiss.** The bar of a companion, for its owners who are not the DM, has Dismiss in Delete's place in the bar's less-often row, armed as Delete is ("Dismiss Spiritual Weapon?" on the first tap), in the order docs/design-v1-token-panel.md 3.3 sets. It is busy until the server answers, since it can remove a row and pass a turn on. It removes the token, its rows and its attached areas, as `token.delete` does (`tokens.ts:176-189`). The DM keeps Delete and gets no second button.
- **The token panel's Companion section** shows only on companions, for the DM and the companion's owners: "Belongs to" (a Select of every character, the DM's alone, shown to owners as text: "Belongs to Bree. Whoever plays Bree controls it."), "What it is" ("A creature" or "An effect", 3.6.2), and the turn Select with its help, each change sending `{ of, turn }` (4.2). Making it an effect is disabled while its turn is "Its own turn", with "Choose one of Bree's turns first." under it. Making it a creature shows its HP fields again (3.6.6). For the DM, "Stop being a companion" detaches it (`companion: null`). A player's change waits on the server (4.6), and the control shows busy until the answer.
- **"Make a companion"**, in Token settings for the DM, on any token that is not a PC and not yet a companion: a button that opens "Belongs to" and the turn Select in place, with the turn starting at `shared`, and a "Make a companion" button under them that sends one `token.update` with `companion` (and the ally ring, 3.6.3). Nothing is sent until that button. docs/design-v1-token-panel.md describes the same control.
- **The Owners section**, for a companion, shows "Played by whoever plays Bree: Ana" in place of the checkboxes. "Players see HP as" shows "Follows Players see the party's HP" for a creature companion a player plays.

#### 3.6.10 When the effect ends, and other scenes

The app does not tie a companion to a spell or to concentration. When Spiritual Weapon ends, or concentration on it breaks, its player taps Dismiss. A Wildfire Spirit or a familiar stays until dismissed, across fights, on the scene where it stands: tokens do not follow `room.setPlayerScene` (`shared/reducer/room.ts:19-22`), so when the party moves to another scene, a companion stays behind, out of its player's view, and the player adds one next to their character there. The cap of 10 counts one scene, so the ones left behind never block it. The DM finds them in the outliner of that scene: a companion's row reads "Companion of Bree" in place of its kind word (`client/features/outliner/rows.ts:87`, `:130`), its mark reads "Away from Bree" when no token of Bree stands on that scene, and typing "companion" in the outliner's search lists them all. The DM deletes them there or in their bars.

### 3.7 Mockups

#### 3.7.1 The tracker on a phone held upright (390 x 844, the bottom sheet), DM, scrolled into the list

```
+--------------------------------------+
| Initiative                         X |  sheet header, never scrolls
+--------------------------------------+
| Round 3  0:42      [Previous] [Next] |  sticky round header
| Goblin 2's turn                      |
+--------------------------------------+
| :: (G2) Goblin 2            [14] ... |  rows scroll under the header
|        [AC 15] HP 7/7  (Prone)       |
| :: (B) Bree                 [12] ... |
|        [AC 16] HP 24/31              |
|      (W) Wildfire Spirit         ... |  nested: acts on Bree's turn
|          [AC 13] HP 12/15            |
| :: (O) Owl                  [ 9] ... |
|        [AC 11] HP 1/1                |
|        Companion of Bree             |
+--------------------------------------+
| AUTO INITIATIVE                      |  next section: the header is gone
| [By creature][One each][All at once] |  once the list has scrolled past
```

#### 3.7.2 The tracker on a small phone held sideways (480 x 320 at 130%, the full-screen modal sheet), player on their turn, so the header is compact

```
+-----------------------------------------------+
| (<) Initiative                         [|>] X |
+-----------------------------------------------+
| Round 3 Your turn               [ End turn ]  |  compact, sticky
+-----------------------------------------------+
| (B) Bree                           [12]  ...  |
|     [AC 16] HP 24/31                          |
|   (W) Wildfire Spirit                    ...  |
|       [AC 13] HP 12/15                        |
| (G2) Goblin 2                      [14]       |
+-----------------------------------------------+
```

The sheet's header is the layout design's, with All panels `(<)`, Hide `[|>]` (the collapse-panel icon) and Close. Its 169 px body holds the compact header (49 px) and two standard rows (116 px) but not the full header and two (172 px), so the round header is one row. Bree's row with Wildfire Spirit under it is taller than a standard row and may not show whole at every scroll, and focus scrolls its controls clear of the header. The player's own rows show AC. Goblin 2's row shows none, and its HP as its label. On a phone held sideways at 844 x 390 the right sheet's 199 px body holds the full header instead.

#### 3.7.3 The tracker from 900 px up (the side panel, 360 px), DM

```
+----------------------------------------+
| Token | Characters | Initiative | ...  |  tabs, outside the scroller
+----------------------------------------+
| Round 3   0:42       [Previous] [Next] |  sticky, flush with the tab bar
| Goblin 2's turn                        |
+----------------------------------------+
| :: (G2) Goblin 2              [14] ... |
|         [AC 15] HP 7/7                 |
| :: (T)  Thorn (dead, struck)  [10] ... |
|         Dead                           |
|   [Revive]  Revive brings it back      |  Thorn's options, open
|             with 1 HP.                 |
|   [ ] Hidden from players  ...         |
```

#### 3.7.4 The bar of a dead creature (phone held upright, DM, and the owner's view)

The vitals line and the rows are docs/design-v1-token-panel.md 3.3's. This design adds Revive and the lines under the vitals.

```
DM                                      Bree's player
+-------------------------------------+ +-------------------------------------+
| Thorn                            X  | | Bree                             X  |
| HP 0/31  [Dead]  [Revive]           | | HP 0/31  [Dead]                     |
| Revive brings it back with 1 HP.    | | Healing brings Bree back.           |
| [Damage][Heal][Set][Temp]           | | [Damage][Heal][Set][Temp]           |
| [            ]  [Apply]             | | [            ]  [Apply]             |
| [Details]                           | | [Details]                           |
| [Conditions] [Hidden]               | | [Conditions] [Select several]       |
| [Select several]                    | | [Move bar]                          |
| [Locked] [Duplicate] [Delete]       | |                                     |
+-------------------------------------+ +-------------------------------------+
```

#### 3.7.5 Companions in the Characters panel (phone), and the form

```
+--------------------------------------+   +--------------------------------------+
| v (B) Bree       HP 24/31, Ana       |   | Add a companion for Bree             |
|   [Place my token]                   |   | Name    [Wildfire Spirit         ]   |
|   COMPANIONS                         |   | It is   [A creature][An effect]      |
|   (W) Wildfire Spirit             >  |   | Turn    [On Bree's turn, listed v]   |
|       On Bree's turn, listed         |   |         It acts on Bree's turn and   |
|   (S) Spiritual Weapon            >  |   |         shows under Bree in the      |
|       On Bree's turn, not listed     |   |         initiative order.            |
|   [Add a companion]                  |   | Size    [Small v]                    |
|   ...the character's card...         |   | HP      [ 15 ]    AC [ 13 ]          |
+--------------------------------------+   | Picture [image field]                |
                                           | [Add and place]   [Cancel]           |
                                           | Goes next to Bree on the map.        |
                                           +--------------------------------------+
```

A companion's line in the list is a button that shows it on the map with its bar, as a party bar tap does. The section sits after "Place my token" and before the card: during play a player opens their card more often for companions than to edit stats. The list holds the companions on the scene this device holds, since a view holds one scene's tokens. With "An effect" chosen, the HP and AC row goes and the turn offers only the two turns on Bree's turn.

#### 3.7.6 The Companion section in a token's panel (from 900 px up), DM and owner

```
DM                                        Bree's player
+--------------------------------------+  +--------------------------------------+
| COMPANION                            |  | COMPANION                            |
| Belongs to  [Bree                v]  |  | Belongs to Bree. Whoever plays Bree  |
| It is       [A creature][An effect]  |  | controls it.                         |
| Turn        [On Bree's turn,     v]  |  | It is  [A creature][An effect]       |
|             [listed under Bree    ]  |  | Turn   [On Bree's turn, listed   v]  |
| It acts on Bree's turn and shows     |  | It acts on Bree's turn and shows     |
| under Bree in the initiative order.  |  | under Bree in the initiative order.  |
| [Stop being a companion]             |  |                                      |
| OWNERS                               |  |                                      |
| Played by whoever plays Bree: Ana    |  |                                      |
+--------------------------------------+  +--------------------------------------+
```

## 4. Data model and protocol

### 4.1 Model (`shared/model.ts`)

```ts
/** Whose turn a companion acts on (docs/design-v1-combat-flow.md 3.6.2). */
export type CompanionTurn = "own" | "shared" | "none";

/**
 * A creature or effect a character brings: a familiar, a summon, a spell's
 * weapon. Its owners are always its character's owners, and it has no number.
 * `reactionUsed` is a `shared` companion's own Reaction, present only while
 * spent, cleared when its character's turn starts.
 */
export type Companion = { of: CharacterId; turn: CompanionTurn; reactionUsed?: true };

// Token gains:
companion?: Companion;
// A token.update patch gains (protocol only, 4.2):
//   companionReaction?: boolean  (sets or clears companion.reactionUsed alone)

// EncounterSnapshot gains, DM only like the history:
/** The `shared` companions whose Reaction this `next` cleared, so `prev` can set them again. */
companionReactions?: TokenId[];

// RoomSettings gains:
/** Healing or setting HP above 0 brings a dead creature back. Absent reads as on (op version 5). */
healRevives?: boolean;

// LogEvent gains, DM only:
| { type: "companion"; tokenId: TokenId; characterId: CharacterId; memberId: MemberId; name: string }
```

`DEFAULT_SETTINGS` gains `healRevives: true`. `LIMITS` gains `companionsPerCharacter: 10`, a character's companions on one scene, which only a player's `token.create` counts. `theme.z` gains `stickyHeader: 3` (3.1).

### 4.2 Protocol (`shared/protocol.ts`)

- `companion = z.strictObject({ of: id, turn: z.enum(["own", "shared", "none"]) })`, the shape an op sends. The stored state's schema adds `reactionUsed: z.literal(true).optional()`, which only `companionReaction` and Next and Previous write.
- `tokenInput.companion: companion.optional()` and `tokenPatch.companion: companion.nullable().optional()`, null detaching it. `token.updateMany`'s patch does not take it.
- **Every op serializes `{ of, turn }` explicitly**, never the stored object: the form's create, Duplicate, "Make a companion" and every relationship edit in the Companion section (turn, character, detach). So a spent `reactionUsed` is never sent and never fails the strict schema. Stored-state copies are separate: `scene.duplicate` copies the stored token whole in the reducer.
- `tokenPatch.companionReaction: z.boolean().optional()`, the Reaction's own patch (3.6.8). `token.updateMany`'s patch does not take it.
- `settingsPatch.healRevives: z.boolean().optional()`.
- No new op.

### 4.3 Rules and reducer

- **`shared/migrate.ts`**: `OP_VERSION` becomes 5, this build's alone in this wave, with a step from 4 that returns the op unchanged, as the step from 3 does (`:174-188`). Beside `revealSeenAnywhere` (`:196-198`) go two answers by the op's stored version: `healRevivesDead(settings, opVersion)`, false for an op stored before version 5 and otherwise `settings.healRevives !== false`, and `reviveToOne(opVersion)`, false before version 5 and true otherwise. Live ops carry no version and take today's rule, on the server and in the client's prediction alike.
- **`shared/rules/hp.ts`** gains `hpLess(actor, token?)` (3.6.6), the one predicate both designs gate the HP-less state on. `applyHeal` and `applyHpSet` take the first answer and revive the dead only when the resulting, clamped HP is above 0 (3.4). With it false they behave exactly as today, Set's HP change and line included. `applyLife` takes the second answer and gives a creature that is not alive exactly 1 HP (3.5).
- **`shared/reducer/actors.ts`** (`actorHp` at `:20-38` and `actorLife` at `:76-81`) and **`shared/reducer/tokens.ts`** (`applyActorPatch`, `:85-108`) pass both answers from `tx.state.meta.settings` and `tx.env.opVersion`.
- **A new `shared/reducer/companions.ts`** holds the companion rules the reducers below call, so they live in one place:
  - `checkCompanion(tx, token)`, on the token as the op leaves it: the character exists (`gone`), the actor is inline and the kind not `pc` (`invalid`), an `own` turn has a creature kind (`invalid`, "an effect takes no turn of its own"), and no `number` (`invalid`).
  - `syncOwners(tx, characterIds)`: writes each character's owners onto its companions whose owners differ, tokens in id order.
  - `dropRows(tx, tokenId)`: removes the companion's rows (`removeEntries`), binds its paused durations to its character's row, and rewrites every saved step in `encounterHistory`: the rows leave the saved encounter, and saved effects anchored to them are rebound to the character's row there or paused on the companion (3.6.8).
  - `normalizeCompanionState(state)`: the same rules over a whole state, pure, for imports (4.7).
- **`tokenCreate`** (`tokens.ts:41-83`) with `companion`: a supplied `number` refused, `checkCompanion`, `ownerIds`, if given, equal to the character's in any order (`invalid`), the token stored with the character's owners, and no `autoNumber`. When a player made it, the reducer writes the `companion` log line. `autoNumber` (`:24-39`) also leaves companions out of the siblings it numbers.
- **`tokenUpdate`** (`:118-174`): a patch that sets `companion` refuses a `number` it names, then clears the token's inherited `number`, then runs `checkCompanion` on the result, writes the character's owners, keeps the token's `reactionUsed` while the turn stays `shared` and drops it otherwise, and when the turn becomes `shared` or `none` runs `dropRows`. A patch with `companionReaction` sets or clears `companion.reactionUsed` on the token as the rest of the patch leaves it, and is refused (`invalid`, "it does not act on its character's turn") unless that token is a `shared` companion. A patch naming `ownerIds` or `number` on a token that stays a companion is refused, and so are a kind of `pc` and a kind of `object` with an `own` turn. A kind change never writes the actor (3.6.6). `token.updateMany` refuses `ownerIds` or `number` when any of its tokens is a companion.
- **`deleteToken`** (`:176-189`) runs `dropRows` for a companion before removing it.
- **`characterUpdate`** (`:343-360`): new owners go through `syncOwners`. **`characterDelete`** (`:362-370`) also deletes every token whose `companion.of` is the character.
- **`restore`** (`shared/reducer/misc.ts:56-92`): after its writes and its reference checks, it refuses an encounter holding a row for a `shared` or `none` companion (3.6.8), then runs `syncOwners` for the characters it wrote and those named by companion tokens it wrote (3.6.4). `referencesOf` (`:182-212`) adds a token's `companion.of` as a character reference, and the character scan in `checkReferences` (`:164-168`) counts a companion as a use. So an undo never removes a character a companion still names, nor puts back a companion whose character is gone.
- **`buildEntry`** (`encounter.ts:49-73`) refuses a row for a `shared` or `none` companion. **`encounterNext`** (`:271-321`) clears `reactionUsed` on the `shared` companions of the landing row's character (`rowCharacter(row)`, a new helper beside `actorOfEntry` in `shared/rules/initiative.ts`, which the tracker's nesting also calls) standing on the row token's scene, or the players' scene for a row with no token, in token id order, with the row's own (`:279`), and saves their ids in the step's `companionReactions`. **`encounterPrev`** (`:324-358`) sets the flag again on each saved id that is still a `shared` companion. `encounterUpdate` is unchanged.
- **`shared/rules/durations.ts`**: `entryMatchesAnchor` and `anchorsForEntry` as 3.6.8 says.
- **`shared/rules/vision.ts`** (`:173-190`): the ranking's fourth group for companions (3.6.5).
- **Duplicate** gives the copy the source's `{ of, turn }`, built field by field (`client/features/tokens/factory.ts:163-183` gains it), without `reactionUsed` and without a number, so a fresh duplicate starts with its Reaction unspent. `scene.duplicate` with creatures (`shared/reducer/duplicate.ts:71`) is a stored-state copy: it copies the token whole, flag included, and carries no number since a companion has none. Both copies take the character's owners.

### 4.4 Permissions (`shared/permissions.ts`)

- **`token.create`** by a player (`:389-390`): either `placeTokenCheck` as today, or, for an input with `companion`, a new `companionCheck`:
  - The character is one the player owns (else `NOT_YOURS`, or `GONE` when it does not exist).
  - The scene is the one the player holds and the token lies inside its bounds.
  - A token of the character stands on that scene, and the new token's footprint is within 5 ft of it by the room's distance (`boxDistanceFt` of the two `tokenCellBox`es, `shared/rules/distance.ts:27`, `:96`, as door reach measures it, `shared/permissions.ts:879-882`). Else "Put it next to Bree." (`forbidden`), or "Bree has no token here." when none stands there.
  - On a scene with `blockMovement`, the new token standing where the character's token stands could step to its spot (`movementRules.legBlocker(state, { ...input, x: character.x, y: character.y, elevation: character.elevation }, spot)` is null). Else "A wall is in the way." or "A ledge is in the way.", the move refusals' words.
  - The kind is `npc` with an inline actor whose HP maximum is at least 1, or `object` with HP 0 of 0 and AC 0, and an `own` turn only for `npc`.
  - It is plain (visibility all, not fog exempt, unlocked, no hidden name, no public name, no number, `layer` given as the creatures layer, no light, no party mark, no `hpVisibility`), unhurt and bare (HP at its maximum, no temporary HP, alive, no death saves, no effects, no DM notes, no legendary actions, no room monster).
  - Its owners are absent or the character's, and its images are usable.
  - The character has fewer than `companionsPerCharacter` companions on that scene, else "Bree has 10 companions here. Ask the DM for more."

  The token panel and the form say each refusal in the same words. It does not need `playersCreateCharacters`.
- **`token.update`** by an owner (`:416-426`) of a companion: `OWNER_TOKEN_FIELDS`, with `name` allowed although it is not a PC (`:422` keeps `publicName` a PC owner's alone), plus `actor` limited to `OWNER_ACTOR_FIELDS`, plus `kind` between `npc` and `object` only, plus `companion` with the same `of`, plus `companionReaction`. Anything else stays "owners cannot change <field>". The reducer's own rules (eligibility, owners, numbers) then apply as for the DM.
- **`token.delete`** (`:302`): a player may delete a companion they own. Anything else stays the DM's.
- **`encounter.update`** is unchanged: a companion's Reaction is a `companionReaction` patch on its own token, which the owner rule above covers.
- **`encounter.add`** (`:530-548`) is unchanged: the reducer refuses `shared` and `none` rows for everyone.
- `client/features/tokens/access.ts` mirrors all of it, and `access.test.ts` checks it against `canApply`, as today.

### 4.5 Projection (`shared/project.ts`)

- Owners already get the whole token (`:508-518`), `companion` included.
- Other players' copies (`:519-561`) gain `companion` when `playersToken` holds.
- `hpAccess` (`:407-418`) gives a creature companion the party's rule for players who do not own it, while `playersToken` holds, and nothing (`none`) to any token for which `hpLess` holds, judged on the server's full actor and token.
- `projectActorPublic` (`:473-479`) sends `life: "alive"` for an effect companion (kind `object` with `companion`) to every viewer who does not own it. Owners and the DM get its stored life, and their devices hold `companion`, so `hpLess` hides it.
- A companion's `reactionUsed` travels inside `companion`, so it reaches exactly the viewers `companion` reaches: its owners, and other players while it is the party's. The encounter carries no companion ids, and the saved steps' `companionReactions` are in `encounterHistory`, which only the DM receives.
- The `companion` log line is the DM's alone, as the teleport line is (`:1214`).
- The fan-out needs nothing new: `companion` and its HP rule depend on the token itself, its owners, the members' kinds and the room settings, which the `party` flag and the HP rules already depend on. Next and Previous write the companions whose flag they change, so those tokens are touched keys.

### 4.6 Prediction (`shared/reads.ts`)

What each changed op reads, so a redacted view never predicts what it cannot (design 7.4):

- **`token.create` with `companion`**: `NEVER`. Its checks read the character's token and walls, and its log line is the DM's, so the form waits for the server, busy, as 3.6.3 says.
- **`token.update` with `companion` in the patch**: `NEVER`, since it may remove rows, rewrite the history and bind durations over every actor, and its controls wait for the server, busy.
- **`token.update` with `companionReaction` alone**: the token (its `companion` field), so the Reaction switch is predicted at once wherever the token is held. A refusal from the server (the turn changed meanwhile) snaps it back.
- **`token.update` on a companion naming `ownerIds`, `number` or `kind`**: the token as today. The reducer's refusal reads only the token.
- **`token.delete`**: today's reads (`:93-96`) plus `encounterHistory`, which `dropRows` rewrites.
- **`character.update` with `ownerIds`**: plus the `tokens` collection, since `syncOwners` writes companions on every scene. A DM's device predicts it only in a one-scene room viewed whole. Elsewhere the owner change waits for the server, which a rare edit can afford.
- **`encounter.next`**: plus the scene whose `shared` companions it clears, worked out with `nextTurn` from the view: the landing row token's scene, or the players' scene for a row with no token. A DM's view that holds every row's token, which the `encounter` read already demands (`:209-211`), holds the token's scene whole, so the DM's Next stays predicted there. For a character row it is predicted while the DM views the players' scene.
- **`encounter.prev`**: plus the tokens its saved `companionReactions` names.

### 4.7 Stored rooms, replay, imports, deploy and rollback

- **Snapshots** need no migration: every new field is optional, and absent reads as no companion, no spent companion Reaction, nothing for Previous to set again, and healing on (for new ops). `SNAPSHOT_VERSION` stays 8.
- **Replay** keeps every stored op's result. An `actor.hp` stored before op version 5 replays with today's heal and set rules on the dead, and an `actor.life` with `Math.max(1, cur)`, whatever the setting reads now, so a later restore's guard still matches. No stored op names a companion, so no older op meets the companion rules, the restore's owner pass, the history clean-up or the sight ranking.
- **Stored restores** carry no companion, so their reference checks and the owner pass find nothing.
- **Imports** (`server/rooms/remap.ts:255-265`): `companion.of` is mapped like a token's `actor.ref`, and a companion whose character did not come through loses the field. The `companion` log line maps its token, character and member ids, as the teleport line does (`:420`). Then `normalizeCompanionState` brings a hand-made or older file within the rules: each companion takes its character's owners, loses any `number`, and an `object` with an `own` turn becomes `shared`. Rows for `shared` or `none` companions leave the encounter and its history, with saved effects rebound as `dropRows` rebinds them. A companion's `reactionUsed` comes with its token and needs no mapping. A saved step's `companionReactions` is filtered and mapped like its `revealed` list (`:328`). `server/rooms/stateSchema.ts` accepts `companion` (with `reactionUsed`) on tokens (`:242` area), `companionReactions` on saved steps, `healRevives` in settings (`:55` area) and the `companion` log line (`:489` area), all optional.
- **Deploy.** Nothing to run. The first op after the deploy is stored at version 5. A clean shutdown writes snapshots, so no older op replays (`shared/migrate.ts:5-12`).
- **Rollback.** An older build cannot read an op stored at version 5: `runMigrations` refuses to migrate down (`shared/migrate.ts:203`), so the room would not load. Rolling back past this build therefore needs a snapshot taken after the last op, which a clean shutdown of this build writes, as rolling back past op version 4 did. A snapshot is not schema-checked on load (`server/rooms/persistence.ts:70`), so the older build loads one that holds the new fields and ignores them: companions act as plain tokens, `healRevives` does nothing, Revive keeps `Math.max(1, cur)`, and a party companion's HP follows its own `hpVisibility` again. Nothing new reaches other players there: the older token projection is an allowlist that leaves `companion` out, and saved steps are the DM's. Restoring a pre-deploy backup is the clean way back. An export from this build is refused by an older build's import, whose schema is strict (`server/rooms/stateSchema.ts:29-32`).

## 5. Edge cases and states

"Viewing as" is the DM's View as a player: the player's projection with every action refused and the banner's flash (`client/features/dm/PlayerPreview.tsx:16-22`).

| State | DM | Player | Viewing as a player |
| --- | --- | --- | --- |
| No fight | "No fight is running." and Start a fight with. No round header. Revive, healing and companions work as outside any fight: companions are tokens. | "No fight is running." Add a companion works next to their character's token. | As that player. Add a companion and Dismiss flash refused. |
| A fight, round 1 before Start | Header "Round 1", "Press Start for the first turn", Previous disabled, Start primary. Auto initiative right under the list. | Header "Round 1", "The fight has not started yet", no End turn. Join the fight right under the list. | As that player. |
| A fight running, long list | Header sticks while rows scroll under it, Next takes a tap at any scroll, and it leaves with the list's end. Tabbing up into a row never lands it under the header. | Same, with End turn in the header on their turn. | As that player. End turn flashes refused. |
| A sheet with room for the full header and two standard rows (172 px and up, 184 in the side panel): 390 x 844 at 100% and 130%, 844 x 390 and 667 x 375 at 100%, the side panels | The header is full and sticks. At any scroll at least one whole standard row shows under it. | The same, End turn in the header. | As that player. |
| Room for the compact header and two rows but not the full one (165 to 171 px, 177 to 183 in the side panel): 480 x 320 at 130%, 169 px | The header compacts to one 44 px row and sticks, with a whole standard row under it at any scroll. | The same, End turn in the compact row. | As that player. |
| Less room than that: 844 x 390 with the turn band, 844 x 390 and 667 x 375 at 130% without it, and 480 x 320 at 130% while the modal's header stacks with five buttons (147 px) | The header does not stick and scrolls with the list, and every row can show. | The same. | As that player. |
| A very short sheet: 844 x 390 and 667 x 375 at 130% with the turn band, 480 x 320 with it, and 480 x 320 at 130% always | The layout design's full-screen modal sheet opens. Its body of about 223 to 243 px holds the full header and two rows, so the header is full and sticky, except at 480 x 320 at 130%, whose 169 px body holds the compact one. "Your turn" and a toast take room from it for a few seconds without changing the header's form (above). | The same, End turn in the header. | As that player. |
| Companion, turn `own` | An ordinary row with "Companion of Bree". Auto initiative never rolls it while a player owns it. | Join the fight lists it. Their row, its options and its End turn. Other players see the row and the tag. | As that player. |
| Companion, turn `shared` | No row. Nested under Bree's row while both are in view, with its own Reaction (on its own token) and Ready in its options. Acts on Bree's turn. Durations count Bree's row. Add buttons leave it out, and the server refuses a row. | Same nesting, their own and other party members'. End turn on Bree's turn ends both. Their companion's Reaction switch is predicted at once. | As that player. |
| Companion, turn `none` | Not in the tracker or the strip, nested or not. Durations count Bree's row. On the map only. | Same. | Same. |
| A `shared` companion whose character has no row | Not in the tracker. It joins when Bree does. | Same. | Same. |
| A companion detached | It becomes a plain token: its owners stay as they were, for the DM to change. Its durations keep counting Bree's row, which their chips say ("until the end of Bree's next turn"). Its Reaction flag goes with the `companion` object. It can be added to the fight as any creature. | It loses its tag and its nesting. Its owners keep it until the DM changes them. | As that player. |
| Turn `own`, then `shared`, then `own` | Its row leaves and its durations move to Bree's row. Back on `own`, they stay on Bree's row, and its player adds a new row with a new value. | The same, with Join the fight offering it again. | As that player. |
| Turn changed or companion dismissed, then Previous | The earlier turn comes back without the companion's row. If that row was acting then, the turn passes to the next row. An effect on another creature that counted the companion's row comes back counting Bree's row, or paused on the companion. A companion Reaction Next had cleared is set again only on a companion still `shared`. | Sees the same order. | As that player. |
| Next clears a spent companion Reaction, then Previous | Next clears the spirit's flag with Bree's turn starting, on the scene of Bree's row token. Previous sets it again. | The same. | As that player. |
| A `shared` companion under a character row (a row with no token) | Nested by the row's character. Next clears its flag on the players' scene when the row's turn starts, and Previous sets it again. | The same. | As that player. |
| A mixed row: Ana's own Bree token with Cy's character id | The row is Bree's, as its actor and name already are. Only Bree's companions nest under it and reset on its turn. Cy's character's companions stay untouched. | The same. | As that player. |
| A Reaction press arriving after the companion's turn changed | The server refuses it, since the token is no longer a `shared` companion. Its turn, its row and the character's Reaction stay as they are. | Their switch snaps back. | Refused with the flash. |
| A `shared` companion's Reaction spent, then it is given to another character | The flag goes with the token. It clears when its new character's turn starts. | The same. | As that player. |
| A player who owns Bree's token but not Bree | They do not own Bree's companions, whose owners are Bree's. They see a party companion's Reaction, as other players do, and cannot change it. | The same. | As that player. |
| "It fired" from the token panel on a `shared` companion | The spirit's `readied` effect goes and its own Reaction is spent. Bree's Reaction is untouched. | The same for its owner. | Refused with the flash. |
| A creature companion made an effect, then a creature again | Its HP, AC, life and death saves stay stored and show nowhere while it is an effect. A dead one shows no Dead or Revive while an effect. Made a creature again, it shows them as they were. | The same for its owner. Other players, and the table display, get no HP and `life: "alive"` while it is an effect, so no dead mark shows. | As that player. |
| The owner's turn | Bree's row is tinted, its nested companions inside the tint. The turn marker and trail follow Bree's token only (3.6.8). | "Your turn" and End turn, as today. | As that player. |
| A companion's owner leaves the roster | The member leaves every owner list, the companion's too, so the DM runs it. An `own` row stays, and auto initiative now rolls it. The DM still sees it nested. | Other players stop receiving `companion`: its nesting and tag go, its HP follows its own `hpVisibility`, and under fog it hides like any DM creature. | As that player. |
| A character's owners changed, then undone, with a companion made between | The undo puts the character's old owners back and copies them onto the new companion in the same step. | The companion leaves the new owner and returns to the old one with the character. | As that player. |
| A companion deleted, the character's owners changed, then the delete undone | The companion comes back with the character's current owners. | Its current player gets it. | As that player. |
| A companion's owner at 0 HP, dying | Bree's row keeps its turn, since only the dead are skipped. Companions acting on Bree's turn act in it. | Death save pips in the bar, End turn. | As that player. |
| A companion's owner dead | With skip defeated on, Bree's row and its companions are passed over. They stay listed under the struck row. Revive in Bree's bar and row options. Concentration ended at death, and the app removes no companion: its owner or the DM dismisses it. | The bar says "Healing brings Bree back." or, with the setting off, that only the DM's Revive does. | As that player. |
| A player adds a companion | It lands next to Bree. The DM's log says "Ana added Wildfire Spirit beside Bree." | With no Bree token on the map, or no room next to it, the button is disabled with the reason. A crafted op far away or through a wall is refused. | Refused with the flash. |
| A companion left on another scene | In that scene's outliner, "Companion of Bree" and "Away from Bree", found by searching "companion". It does not count against the cap on the players' new scene. | Not in their view. They add one next to Bree on the new scene. | As that player. |
| Party sight with companions | A creature companion lends sight, ranked after the DM's marked sources under the cap of 12. An effect lends none. | Sees what the party sees. | As that player. |
| An effect companion (Spiritual Weapon) | No HP, no AC, no HP entry, no life controls, never Bloodied or Dead, and no life marks on the map. Area damage leaves it out by default. | Its owner sees the same. Other players receive no HP for it and see it alive, whether or not they receive `companion`. | As that player. |
| An ordinary object, such as a chest with HP | Its HP shows as today. Its panel has no Revive, Stabilize or Mark dead, and its bar no Revive. | The same where they see it. | As that player. |
| An ordinary creature whose HP players may not see | Unchanged: its HP is hidden from players, and `hpLess` is false for them, since missing HP never counts as 0. Its dead or dying marks show as today. | The same. | As that player. |
| A dead monster | Dead tag and Revive in its bar, and Revive in its row's options. With the setting on a heal brings it back (the heal line, then "is back on their feet"), and a group heal brings back any dead in the group, which the preview counts. Off, nothing happens, and the HP entry says so before sending. | Sees Dead as the token's HP rule allows. With "Players can apply damage and healing", their heal brings it back too while the setting is on, and they get the dead line. | As that player. |
| A dead creature healed with a maximum of 0 | The heal leaves it at 0, so it stays dead, as today. The preview counts no revival. | The same. | As that player. |
| Set while dead, setting on | A set of a current HP above 0 brings it back after the set line. A set that clamps to 0, or of the maximum alone, leaves it dead. | The same for an owner. | As that player. |
| Set while dead, setting off | The HP changes, it stays dead, and the set line is written, as today. The HP entry says "Thorn stays dead at the new HP." before sending. | The same for an owner. | As that player. |
| A group heal, setting off | The preview says "Healing does nothing to the 2 dead among them." The living are healed, the dead stay dead. | The same, where they may heal. | As that player. |
| `+5` typed with Damage chosen | It is a heal, so the heal's lines and count apply. | The same. | As that player. |
| A character at 0 HP making death saves (dying) | Unchanged: pips, and a heal brings it back. Revive is not in the bar or the row for a dying creature. The panel's Revive and Stabilize stay. | Their player fills the pips. A heal brings it back, setting or not. | As that player. Pips flash refused. |
| A character stable at 0 HP | A "Stable" note, no pips and no Revive in the bar or the row. A heal brings it back, setting or not. Damage makes it dying again, as today. | The same for its player. | As that player. |
| A character dead after three failed saves or massive damage | Dead tag, no pips (pips show only while dying), Revive in the bar and the row. Its failures stay stored until a heal (setting on) or Revive clears them. Skipped by Next with skip defeated on. | Their bar says healing brings it back, or that only the DM can. With the setting on their heal does. | As that player. A heal flashes refused. |
| Healing from 0 (dying or stable) | Unchanged, whatever the setting. | Unchanged. | Refused. |
| Revive | The DM's alone: in the bar and the row's options. Exactly 1 HP, saves cleared, 0 HP Unconscious off, other conditions kept, "is back on their feet". Ctrl+Z takes it back. | Not offered. With the setting on, the owner heals instead. | Not offered. |
| Revive on a dead creature holding 12 HP (set while the setting was off) | It comes back at exactly 1 HP. | The same, seen as allowed. | As that player. |
| Two Revive buttons from 900 px up | The bar's, in its dialog "Thorn actions", and the token panel's, in the Token tab's panel. Either revives once, and both go. | None. | None. |
| A hidden combatant | A hidden row is the DM's, as today. Its companions stay nested for the DM. A hidden companion token is still its owners'. | A hidden row and its nested companions are not in their copy. | Same as the player. |
| A reload mid-fight | The header and the nesting come back from the state, and the companions' Reactions from their tokens. A half-filled companion form is lost, as New character's is. | Same. | Same. |
| Older rooms replaying their events | No stored op names a companion. A heal or set stored before op version 5 replays with today's rules on the dead, and a Revive with `Math.max(1, cur)`. Ops after the deploy read the setting, absent as on. | Same projection as before for every stored state. | Same. |
| An import of a hand-made file | Companions take their character's owners and lose any number, an effect with its own turn becomes `shared`, and rows of `shared` or `none` companions leave the fight and its history, saved effects rebound. A spent companion Reaction comes with its token. | Same. | Same. |

## 6. Interfaces with the other two designs

- **docs/design-v1-token-panel.md, the AC badge** (its 3.9 and 3.10). The tracker row and its nested companions show `AcBadge` at `sm`, which that design sizes to its number from 0 to 100, for each row whose actor the viewer's copy holds AC for, as that design asks. The row, not the badge, leaves it out for AC 0 and for the dead, which matches the map's rule. The row's description carries the badge's name (3.3).
- **docs/design-v1-token-panel.md, the token action bar** (its 3.3). The bar's whole order, its button rows included, is that design's. This design's additions go into its order: Revive on the vitals line beside Dead, with its line under the vitals (3.5), the players' dead line in the same place, and Dismiss in Delete's place in the less-often row for a companion's owners who are not the DM (3.6.9). The vitals line's AC shield hides on the dead, as on the map. For an HP-less companion the vitals line leaves HP out and the bar has no HP entry (3.6.6).
- **docs/design-v1-token-panel.md, the HP entry.** The entry's lines and its preview's count (3.5) are this design's, driven by the parsed operation. They sit under the entry's field, in the bar and in the panel alike, and in the group entry.
- **docs/design-v1-token-panel.md, `hpLess`.** Both designs gate the HP-less state on one predicate, `hpLess(actor, token?)` in `shared/rules/hp.ts`, defined in the same words in both: a companion that is an effect, or any token with max HP 0 (3.6.6). It reads only what the caller holds and never takes missing HP as 0. The token panel (character cards included, with no token), its bar's vitals and HP entry, and the map's marks read it, and so do this design's tracker and projection. The map also skips life marks on every token of kind `object`.
- **docs/design-v1-token-panel.md, the token panel.** This design owns the HP-less state of the Hit points section (3.6.6), which that design's section follows, and hides its life buttons on every token of kind `object`. That design shows the Companion section only on companions and places it, with its fold in its shared fold contract, and puts "Make a companion" in Token settings, as one control in both designs: a button that opens "Belongs to" and the turn, starting at `shared`, then sends one update (3.6.9). After a companion is detached or changes turn, the explanation of where its durations count is the effect chips' own words in Conditions (3.6.8), so that design's Companion section promises no such line. Its name block's tag line names the link, "Companion of Bree" (its 3.10), and the tracker's tag uses the same words. Its "Players see HP as" control shows, for a creature companion a player plays, "Follows Players see the party's HP" in place of the Select. Its Hit points section keeps Revive, Stabilize and Mark dead where its 3.7 leaves them, and its Max HP field sends a set of the maximum alone, which never revives (3.4).
- **docs/design-v1-token-panel.md, "It fired".** Its Conditions' "It fired: Reaction used" (`EffectsSection.tsx:324-327`, `:467`) passes the answer of this design's `reactionTarget` to `fireOps` in place of `selfEntryId`'s row (3.6.8).
- **docs/design-v1-layout-hierarchy.md.** The tracker's order is this design's (3.2). Its very-short-sheet fallback, a full-screen modal sheet where a sheet's body would be under about 88 px, gives the tracker the scrollers in 3.1's table, and the round header picks its form from the measured scroller, header and standard row whatever the sheet. That design (its 6.5) keeps Initiative second in every list of panels and the side panel's default tab, and keeps a hidden sheet or side panel mounted with its scroll, so the sticky header needs nothing from it beyond the `data-pane-body` mark and the two CSS variables its scrolling bodies publish (3.1). The "Healing brings back the dead" switch goes in Room settings' Combat group after "Monsters die at 0 HP", which that design leaves as it is.
- **Shared files.** Whichever build lands second keeps the other's change in each:
  - `client/panels/TokenPanel.tsx`: the token panel build's order, folds and name block, and this build's Companion section, "Make a companion", the Owners text and the "Players see HP as" text (build step 6).
  - `client/features/encounter/Row.tsx`: the token panel build's `openStatBlock`, and this build's AC badge, row description, Revive, companion tag and sub-rows.
  - `client/features/tokens/HpSection.tsx`: the token panel build's Max and Temp HP row, and this build's HP-less state and the HP entry's lines.
  - `client/canvas/TokenActionBar.tsx`: the token panel build's summary and button rows, the layout build's extraction of the scroll fade, and this build's Revive, dead lines and Dismiss.
  - `client/features/tokens/CharactersPanel.tsx`: the layout build's move M8 and this build's Companions section and form.
  - `client/components/Sheet.tsx`: the layout build's `onHide` and modal fallback, and this build's `data-pane-body` and CSS variables.
  - `client/features/tokens/EffectsSection.tsx`: the token panel build's Conditions, and this build's `reactionTarget` call for "It fired".
  - `client/canvas/TokenNode.tsx`: the token panel build's AC mark, and this build's `hpLess` gate on the HP bar and AC mark, and no life marks on kind `object`.

## 7. FEATURES.md

Under "Combat and initiative":

- "The order runs high to low. Dragging rows settles ties. A round counter, Start, Next and Previous run the fight." gains: "The round counter and its buttons, or End turn, stay at the top while the order scrolls under them, and scroll away once the order has passed. On a short screen they shrink to one line, and on a very short one they scroll with the order."
- "Rows show HP, conditions and, for the DM, AC." becomes: "Rows show AC, HP and conditions. The DM sees every creature's AC, and a player their own creatures'."
- After the line on 0 HP: "Healing a dead creature brings it back with the HP healed ("Healing brings back the dead", on by default). Off, healing does nothing to the dead, and the HP entry says so. The DM's Revive is in a dead creature's action bar and its tracker row's options, and brings it back with 1 HP."
- The DM's Auto initiative line gains: "It sits right after the order, with what it rolled."

A new subsection, "### Companions", after "### Encounter builder":

- "A companion is a token that belongs to a character: a creature such as a familiar or a summoned spirit, or an effect with no HP such as Spiritual Weapon. Whoever plays the character controls it: moves it, changes its HP, conditions and stats, renames it and dismisses it."
- "Each companion takes its own turn with its own initiative, acts on its character's turn listed under it in the order, or acts on its character's turn and stays out of the order. Only a creature takes its own turn."
- "A player adds a companion from their character in the Characters panel. It goes right next to the character's token, up to 10 per character on a scene, and the DM's log says so. The DM can make any token a companion in its panel."
- "A companion listed under its character keeps its own Reaction and Ready action in the order."
- "Other players see a party member's companions, under the character in the order, with HP as "Players see the party's HP" allows. A creature companion lends the party its sight, an effect does not."
- "Effects on a companion that acts on its character's turn count that character's turns."
- "A companion stays on its scene when the party moves on. The DM finds the ones left behind by searching "companion" in that scene's outliner."

Under "Characters and monsters", the Characters panel line gains: "A character's card lists its companions and adds new ones."

## 8. Tests

Unit tests, `node:test`:

- `shared/rules/hp.test.ts`:
  - A heal on a dead creature with healing revives on gives `min(max, cur + amount)`, alive, saves cleared, and an `hp` then `life` event. With a maximum of 0 it changes nothing. With it off, a heal changes nothing.
  - With it on, a set of a current HP above 0 on the dead revives at that HP, and an over-cap set revives at the maximum it clamps to.
  - With it on, a set whose current HP clamps to 0, a set of the maximum alone and a set of temporary HP alone leave it dead.
  - With it off, a set on the dead changes the HP, keeps it dead and writes the set line, as today.
  - A dying or stable creature heals as today either way. Conditions applied by hand survive the revival.
  - `hpLess(actor, token?)`: true for an effect companion and for an actor at max HP 0 (a character-linked token through its character's actor, a character card with no token, a creature companion at 0), false for an ordinary object with HP, false for a partial projected actor with no `hp` and for an ordinary creature whose HP is hidden, and false for an effect token whose `companion` the caller does not hold.
  - `applyLife` with `alive` gives a dead creature holding 12 HP exactly 1 with `reviveToOne`, and keeps 12 without. A dying creature at 0 gets 1 either way. An alive creature keeps its HP either way.
- `shared/migrate.test.ts`: the step from 4 to 5 returns the op unchanged. `healRevivesDead` answers false at op version 4 with the setting on, true at 5 and with no version when absent or true, and false when off. `reviveToOne` answers false at 4 and true at 5 and with no version.
- `shared/reducer/opVersion4.test.ts`, new, after `opVersion3.test.ts`: a stored version 4 heal on a dead monster replays to a dead monster, a version 4 set on the dead replays to a dead monster holding the set HP, and a version 4 Revive of a dead creature holding 12 HP replays to 12. The same ops at version 5 bring them back, at the healed HP, the set HP and 1.
- `shared/reducer/companions.test.ts`, new:
  - Create stores the character's owners, refuses other owners, a PC kind, a character token, a number, and an effect with its own turn, and answers `gone` for a missing character. A player's create writes the DM-only `companion` line, and the DM's writes none.
  - Attaching a numbered Owl clears its inherited number before the check, so it attaches. A number the op supplies is refused on create, on the update that attaches, on a later update and on a group update. A new Owl beside a hidden Owl gets no number, and numbering a new Owl leaves the companion alone.
  - A turn change to `shared` or `none` removes the row, passes an active row's turn on with its turn line, binds paused durations to the character's row, and takes the rows out of every saved encounter. Previous after it brings back no row, and an active saved row passes to the next. The same after Dismiss and after the character's deletion.
  - Next, then a turn change to `shared` (and, apart, Dismiss), then Previous, with a `readied` effect on another creature anchored to the companion's row and saved by that Next: the restored effect counts Bree's row after the turn change, and is paused on the companion after Dismiss. It never names the removed row.
  - Kind changes: an own-turn companion cannot become an effect, an effect cannot take its own turn, and an effect made a creature can. A living creature and a dead one made an effect keep their HP, AC, death saves and life unwritten, and made a creature again show them as they were.
  - An `ownerIds` patch on a companion is refused, and detaching then setting owners in one patch passes. `token.updateMany` with `ownerIds` or `number` over a companion is refused. A character's new owners reach its companions in the same op, in token id order.
  - Deleting a character deletes its companions and their rows. `encounter.start` and `encounter.add` refuse `shared` and `none` rows and take `own`.
  - A `companionReaction` patch sets and clears a `shared` companion's flag and changes nothing else. It is refused on a token that is not a `shared` companion. A delayed press arriving after the DM changed the companion to `own` and added its row is refused, and the turn, the row and the character's Reaction are untouched. The flag is dropped by a turn change away from `shared` and by detaching. Given to another character, the companion keeps it.
  - Next clears the flag on the `shared` companions of the landing row's character, for a token-backed parent row on its token's scene and for a character-only parent row on the players' scene, in token id order, and on none elsewhere, and saves their ids. A mixed row, a player's own `tokenId` with another player's `characterId`, passes the schema and the permissions as today, and Next on it clears only the token's character's companions, leaving the other character's untouched. Previous sets it again on those still `shared`, and skips one converted, detached or deleted since.
  - `normalizeCompanionState` over a hand-made state: owners, numbers, an own-turn effect, and rows in the encounter and its history.
- `shared/rules/durations.test.ts`: "end of the companion's next turn" anchors to the character's row. The character's row joining binds a companion's paused duration. Its leaving pauses it on the character. `own` to `shared` moves its row's durations to the character's row, and `shared` to `own`, detaching and giving it to another character leave bound durations on the first character's row.
- `shared/rules/vision.test.ts`: with 12 sources already, a creature companion is capped after the DM's marked creatures, and an effect companion lends no sight.
- `shared/reducer/restore.test.ts`:
  - Bree's owner changed from Ana to Cy, Cy adds a companion, then the owner change is undone: the character and the companion are Ana's after the one restore.
  - A companion deleted, Bree's owners changed, then the delete undone: the companion comes back with the current owners.
  - A restore writing an encounter with a row for a `shared` companion is refused.
  - An undo that would remove a character a companion names is refused as depended on, and one that puts back a companion of a deleted character as its parent gone.
- `shared/permissions.wave6.test.ts`, new:
  - A player's companion create for their own character passes without `playersCreateCharacters`, next to the character's token.
  - It is refused for another's character, off their scene, outside the bounds, with no token of the character on the scene, more than 5 ft from it, through a wall on a scene that blocks moves (and passes through it on one that does not), with any plain-or-bare rule broken, with other owners, for an effect with HP or an own turn, and at 10 companions on that scene. A companion on another scene does not count.
  - An owner may rename it, edit its AC, speeds and HP maximum, change its turn and its kind between `npc` and `object`, and mark its Reaction. They may not change `of`, `visibility`, `locked`, `number`, `ownerIds` or a kind to `monster` or `pc`. A player who owns Bree's token but not Bree may not mark Bree's companion's Reaction.
  - An owner may delete it, and another player may not. The DM may do all of it.
- `shared/project.test.ts`:
  - Owners get `companion`. Another player gets it only while a player owns the token, and loses it when the owner leaves the roster.
  - A creature companion's HP follows `pcHpVisibleToParty` for other players while a player plays it, its own `hpVisibility` once none does. An effect or a maximum of 0 reaches no other player.
  - A companion's `reactionUsed` reaches its owners, and other players only while it is the party's, and never a player who cannot see the token. The encounter carries no companion ids, and saved steps' `companionReactions` reach only the DM.
  - The `companion` log line reaches only the DM.
  - `hpAccess` gives no HP for any token `hpLess` holds for, and a plain object with HP keeps its own rule.
  - An effect companion's actor reaches a non-owning player and the table display with `life: "alive"`, a dead one included. Its owner and the DM get its stored life. An ordinary creature with hidden HP keeps its real life for everyone, as the control case.
  - The random fan-out invariant (`shared/fanout.test.ts` through `shared/testutil.ts`) generates companions of random characters, kinds and turns, and spent companion Reactions.
- `shared/reads.test.ts`: the reads in 4.6.
- `client/state/store.test.ts`: through `replayPending`, a player's companion create and turn change are not predicted, and neither is a DM's character owner change in a two-scene room. A one-scene DM's is predicted. A `companionReaction` patch is predicted by a device that holds the token. The DM's Next onto a character-only row is predicted while the DM views the players' scene. The DM's Next with a companion Reaction spent is predicted when the view holds every row's token.
- `client/features/encounter/ready.test.ts`: `reactionTarget` answers `{ kind: "row", tokenId, entryId }` for a creature with its own row, `{ kind: "companion", tokenId, entryId }` with its character's row for a `shared` companion, and null for a `none` companion or outside the fight. `fireOps` with a companion answer removes the effect and sends `companionReaction: true` built from `tokenId` alone, never the character's `reactionUsed`. The ops both callers generate (`ReadyControls` and the token panel's "It fired") pass the protocol schema and apply through the reducer.
- `client/features/encounter/logic.test.ts`: the add candidates, own candidates and group fight candidates leave out `shared` and `none` companions. The nested companions of a row through `rowCharacter`: by its token's character when it has a token, by its `characterId` only when it has none, so a mixed row nests only its token's character's companions. Sorted, `shared` only, only those in the view. The sticky header's form at and around each threshold, for a sheet's and the side panel's headers and for taller standard rows, and a whole standard row under a stuck header at every scroll offset across one row interval, at the least room each form needs. An untied row keeps the drag handle's slot in an order 320 px wide or more, and gives it up in a narrower one.
- `client/features/tokens/companions.test.ts`, new: the form's token input (a creature as an NPC with HP, an effect as an object with 0 of 0 HP and AC 0, ally ring, the creatures layer, the character's owners, the character's elevation), its errors (no name, a creature under 1 HP, an effect with its own turn), the first free spot within 5 ft of the character with a clear line, and none when every spot is taken or walled off.
- `client/features/tokens/access.test.ts`: the companion owner's fields agree with `canApply`.
- `client/features/tokens/factory.test.ts`: duplicating a companion whose Reaction is spent gives a `TokenInput` with `companion` `{ of, turn }` and no `reactionUsed`, which passes the `token.create` schema. The Companion section's turn edit of a spent companion sends `{ of, turn }`, which passes the `token.update` schema.
- `client/features/settings/form.test.ts`: the healing switch reads an absent value as on.
- `client/features/tokens/groupHp.test.ts`: a target's `dead` flag and maximum. The lines and the count follow the parsed operation: `+5` under Damage is a heal, `-7` under Heal is damage, and the chosen mode decides only before anything parses. The count leaves out a maximum of 0, counts an unknown maximum, and is none with the setting off, where the off lines show for a heal and for a set apart.
- `client/features/outliner/rows.test.ts`: a companion's detail "Companion of Bree", "Away from Bree" with no Bree token on the scene, and a search for "companion" finding it.
- `server/rooms/remap.test.ts` and the state schema test: `companion.of` is remapped, dropped with its character, the companion log line's ids are remapped, `normalizeCompanionState` runs with saved effects rebound, a spent companion Reaction imports with its token, a saved step's `companionReactions` is filtered and mapped like `revealed`, and Previous after the import sets the flag on the mapped token. `healRevives` imports.

Integration, `*.itest.ts`:

- A case in `server/rooms/manager.itest.ts`: a room whose op log holds version 4 heal, set and Revive ops on dead tokens, loaded without a newer snapshot as after a crash, holds what they made then, and a new op is stored at version 5.

e2e, in `e2e/combat.e2e.ts`, new, on E2E_PORT plus 9 (the token panel's new file takes plus 10), run one after another with the other files as docs/design-v1-visual.md 5.3 says. Sizes 390 x 844, 844 x 390 and 1280 x 800 at 100% and 130%, and 480 x 320 at 130% with 47 px side and 21 px bottom insets:

1. With 14 combatants, scrolling the list keeps the header's box at the scroller's top while rows pass under it, and Next takes a click at any scroll. At each checked size where the header sticks, scrolling through one whole row interval 2 px at a time always leaves a whole standard row's box below the header inside the scroller. The form follows the measured room: full where the scroller holds the full header and two standard rows, compact where it holds the compact header and two, and not sticky below. A sheet sized to exactly the compact need sticks one 44 px row with a whole row at every offset, the full need sticks the full header the same way, and 2 px under the compact need the header scrolls with the list. At 844 x 390 at 130% it scrolls with the list. At 480 x 320 at 130% the panel opens as the layout design's modal sheet with a body of about 169 px, the header is compact and sticky with a whole row at every offset, and a row's value box under it takes a tap. With a token selected, the bar's button joins the modal's header as a fourth button without stacking it, and the round header still sticks. With the order scrolled, "Your turn" for a player and a toast for the DM leave the header stuck, End turn and Next in reach. In that sheet the DM's untied rows give the drag handle's empty slot to their names, which show whole, while the side panel keeps it. Scrolling to Auto initiative takes the header away with the list. Shift+Tab from Auto initiative into the last rows, and Tab down the list from the header, never leaves the focused element under the header.
2. The DM's section headings run Auto initiative, Initiative, Add to the fight, Several at once, HP changes, Turn timer, End, This device, and the roll card shows under Auto initiative after a roll. A player's run Join the fight, Several at once, HP changes, This device.
3. The DM sees an AC badge on every living row with an AC, none on a dead row. A player sees it on their own character and creature companion and on no monster. A row's button has the description "Armor Class 15, HP 7/7" (its accessible description, by role and name), and so does a sub-row.
4. Damage kills a goblin. Its bar shows Dead and Revive, Revive gives it exactly 1 HP and the Dead tag goes, and Ctrl+Z takes it back. A dead row's options show Revive. A chest object's panel shows its HP and no Revive, Stabilize or Mark dead.
5. A heal of 5 on a dead goblin brings it back at 5 with "is back on their feet" in the log. `+5` typed under Damage on a dead goblin shows the revival count. With the setting off, the bar's line and the HP entry's line say healing does nothing, a heal leaves it dead, and a set says it stays dead and leaves it dead at the set HP.
6. A player adds Spiritual Weapon (an effect, not listed) and Wildfire Spirit (a creature, listed) from the Characters panel without "Players can create their own characters". Both land within 5 ft of Bree, and the DM's log names each. With Bree's token on another scene the button is disabled with its reason. Neither is in Join the fight or the DM's Everyone here. Wildfire Spirit shows under Bree for the DM, the player and a second player, Spiritual Weapon nowhere in the tracker and with no HP in its panel. The player renames Wildfire Spirit, edits its AC, marks its Reaction and readies it, and on Bree's next turn both clear. Readied again, it fires from the token panel's "It fired: Reaction used": the spirit's Ready goes and its Reaction is spent, and Bree's row shows no Reaction used. On Bree's turn End turn moves past both. Switching Wildfire Spirit to its own turn lets the player join it and type its value. Dismiss takes Spiritual Weapon away for everyone, and Previous afterward brings back no row of it.
7. The DM views as the player: the nesting matches, and Add a companion and Dismiss flash refused.

`smoke`, `table`, `regress`, `tools`, `rolls`, `bardock` and the phone files run unchanged, since they find the tracker's controls by role and name. The e2e runs in Chrome only, so `scroll-margin` on focus and the sticky header are unchecked in Safari, where the build checks them by hand once.

## 9. Build plan

One part, in one workspace from the `bar-dock` tip or later, after the token panel build lands `AcBadge`. Commits:

1. `feat(rules): a room setting lets healing bring back the dead`. `shared/model.ts`, `shared/protocol.ts`, `shared/migrate.ts` (op version 5, `healRevivesDead`, `reviveToOne`), `shared/rules/hp.ts` (with `hpLess`, which the token panel build reads too, so this commit lands first or that build adds the same function), `shared/reducer/actors.ts`, `shared/reducer/tokens.ts` (`applyActorPatch`), `server/rooms/stateSchema.ts`, `client/features/settings/form.ts`, their tests and the version 4 replay tests.
2. `feat(ui): revive in a dead creature's action bar and tracker row`. `client/canvas/TokenActionBar.tsx`, `client/features/encounter/Row.tsx`, and the HP entry's lines in `client/features/tokens/HpSection.tsx` (`HpEntry`) and `GroupHpEntry.tsx` with `groupHp.ts`.
3. `feat(ui): the tracker's round header sticks to the order, and auto initiative follows it`. `client/panels/TrackerPanel.tsx`, `client/features/encounter/AutoInitiative.tsx` (the card's place), `client/components/Sheet.tsx` and `client/pages/Room.tsx` (`data-pane-body` and the two CSS variables), `client/lib/theme.ts` (`z.stickyHeader`), `client/globals.css` (the scroll margin).
4. `feat(ui): the AC badge on tracker rows`. `Row.tsx`, reusing the token panel build's badge, with the rows' description.
5. `feat(companions): companions in the model, rules and permissions`. `shared/model.ts`, `shared/protocol.ts`, `shared/limits.ts`, new `shared/reducer/companions.ts`, `shared/reducer/tokens.ts`, `shared/reducer/encounter.ts`, `shared/reducer/misc.ts`, `shared/rules/durations.ts`, `shared/rules/vision.ts`, `shared/permissions.ts`, `shared/project.ts`, `shared/reads.ts`, `shared/logText.ts` (the companion line), `shared/testutil.ts`, `server/rooms/stateSchema.ts`, `server/rooms/remap.ts`, and their tests.
6. `feat(companions): adding, listing and dismissing companions`. New `client/features/tokens/companions.ts` with its test and `CompanionsSection.tsx` (the Characters card section, the form, and the token panel's Companion section and "Make a companion" as components), `client/features/tokens/CharactersPanel.tsx`, `client/features/tokens/access.ts`, `client/features/tokens/factory.ts` (Duplicate's `{ of, turn }`), `client/features/tokens/GroupMoreSheet.tsx` (no Owners over a companion), `client/canvas/TokenActionBar.tsx` (Dismiss), `client/features/tokens/HpSection.tsx` (the HP-less state, and `LifeControls` hidden on kind `object`, 3.6.6), `client/canvas/TokenNode.tsx` (the `hpLess` gate on its HP bar and AC mark, and no life marks on kind `object`, beside the token panel build's AC mark), `client/features/outliner/rows.ts` (the companion's detail and mark), and in `client/panels/TokenPanel.tsx` by name: the Companion section shown only on companions, "Make a companion" in Token settings, the Owners section's text for a companion, and "Players see HP as" for a companion. The token panel build also edits `TokenPanel.tsx`, and whichever lands second keeps both.
7. `feat(companions): companions in the tracker`. `client/features/encounter/logic.ts` with its tests, `Row.tsx` (sub-rows with their options, the tag), `client/features/encounter/ready.ts` with its test (`reactionTarget`, and `readyOp` and `fireOps` taking its answer, in place of `selfEntryId`), both of its callers, `client/features/encounter/ReadyControls.tsx` and `client/features/tokens/EffectsSection.tsx` ("It fired", which the token panel build also edits, whichever lands second keeping both), `client/panels/TrackerPanel.tsx` (candidates), `client/features/tokens/groupEdit.ts`, and the duration form's "itself" wording in `client/features/tokens/durations.ts`.
8. `test(e2e): combat flow`. `e2e/combat.e2e.ts`.
9. `docs: combat flow in the feature list`. FEATURES.md as section 7, and design.md 9.6 and 8.1 pointing here for healing, Revive and companions.

Section 6 lists the files another build of this wave also edits, and whichever lands second keeps both changes.

## 10. Decided

The project owner answered on 2026-10-15. The design review's round 1 settled two more by default.

1. **Healing the dead.** Decided by the project owner: healing brings back the dead, on by default, existing rooms included, and "Healing brings back the dead" turns it off for the rules as written (3.4).
2. **AC in the tracker.** Decided by the project owner: the DM sees every creature's AC, and a player sees their own creatures' AC (3.3).
3. **Revive for players.** Settled by default: Revive stays the DM's. With the setting on, a player's heal brings their creature back (3.5).
4. **Who adds companions.** Settled by default: every player, for their own characters, up to 10 per character on a scene, with no setting. The DM edits or deletes any of them (3.6.3).
5. **Sight from companions** (D2, settled by default): a companion with no HP, an effect such as Spiritual Weapon, lends no sight, matching the code's rule for objects (`shared/rules/vision.ts:182`). A creature companion lends sight like any token a player owns, ranked after the DM's marked creatures (3.6.5).
6. **The trail and area reminders for a companion on its character's turn.** Settled by default: not in this change. They stay with the character's token (3.6.8).
7. **Revive's HP.** Settled by default: exactly 1, as Revivify gives. A larger heal follows it (3.5).
8. **Where a player's companion goes** (D1, settled by default): only next to that character's token on the same scene, its footprint within 5 ft (one cell) of the character's token, with a clear line on scenes that block movement. With no token of the character on the scene, the button is disabled with a reason. The server enforces it, and a `companion` log line tells the DM (3.6.3).

## 11. Addendum. Monsters' places in the initiative order stay secret until their turn (2026-10-17)

The project owner asked on 2026-10-17: "the initiative order of monsters should not be revealed until it is their turn, this can be a room setting". Asked which rows: "this should also be a setting, default should be the player knows other pc initiative rolls but nothing else". Asked the default: on for new rooms, and rooms from before it keep today's behavior until the DM turns it on. This addendum adds one room setting. It changes design.md 7.3 (the encounter and dice lines for a player) and docs/design-v1-dice.md 5.2.

### 11.1 The setting

`RoomSettings.playersSeeOrder`, one of three, in Room settings' Combat group right after "Reveal hidden combatants on their turn". Its label is "Initiative order players see", its help "Which creatures players see in the order before those creatures act. A creature you hide stays out of their order either way." Each choice has one line:

| `playersSeeOrder` | Its name | Its help |
| --- | --- | --- |
| `party` (new rooms) | Player characters, the rest on their turn | Players see the creatures players play from the start. Every other creature joins their order when its first turn comes, and stays for the fight. |
| `allies` | Player characters and allies, the rest on their turn | As above, and creatures with the Ally ring show from the start too. |
| `all` (rooms from before it) | Everyone | Players see the whole order from the start. |

- **Absent reads `all`** (`orderRevealOf`, shared/rules/initiative.ts), so every room from before the setting keeps today's order until its DM picks another. `DEFAULT_SETTINGS` sets `party`, so a new room starts with it. The import schema defaults an old backup's to `all`, as it defaults `playersCreateCharacters` to off.
- **`room.update`'s settings patch** gains it, one of the three. Only the DM sends `room.update`, and a settings change is `global` (shared/reducer/tx.ts), so every connection gets its encounter projected again.

### 11.2 The rule

A player's encounter holds a row when the existing rules hold it (not `hidden`, its creature in their projection, no blackout) and the order rule shows it (`orderShown`, shared/project.ts):

1. the setting reads `all`, or
2. the party plays the row's creature: its token is a player's (`playersToken`: a member of kind player owns it or its character) and is a player character (kind `pc`, or a character a player owns) or a companion (`partysOwn`), or, for a row with no token, a player owns its character, or
3. the viewer owns the row's token: a monster or NPC lent to a player shows from the start to that player alone, and to the others on its first turn (the project owner, 2026-10-17). Without a viewer, as for the turn line marks, the DM's tag and `initiativeHidden`, the rule is the one for players who own no part of the row. A hidden roll of such a creature still reaches its own players (`projectDiceCtx`), or
4. the setting reads `allies` and the row's token has the Ally ring, or
5. the row's turn has come in this fight: `InitEntry.hadTurn`, or the row is acting now.

- **When its turn comes** the row joins in its place and stays: later rounds, a drag among tied rows, a new value (the table's way to delay a turn) and Ready keep `hadTurn`. A row added mid-fight starts without it. Ending the fight drops the encounter and every flag with it. A row removed and added again is a new row.
- **The acting row always passes the order rule**, so the Hidden rules alone decide what players see of it on its turn, as today ("Another creature's turn" while it is hidden or out of sight).
- **Previous takes the reveal back** along with the turn: it puts back the encounter as the step found it, as it hides again a creature that turn revealed. So does undo. A row Skip defeated passes over never had its turn and stays out.
- **Changing the setting mid-fight** applies at once: rows that have had their turn stay, and every other row follows the new choice. A row that took its turns while ops ran before op version 8 has no flag (11.4), so it waits for its next turn after the DM turns the setting on.
- **A ring or owner change** applies at once too: an owner change is `global`, and a token change re-projects the encounter (`dependents`).
- **The DM** sees every row. "View as a player" projects the DM's state for that player through `projectState`, so the preview shows exactly this.
- **The DM's tracker** tags each row the rule keeps from players "Secret until its turn" (`secretUntilItsTurn`, client/features/encounter/logic.ts), a muted tag whose tooltip says the row joins their order when its first turn comes. It shows only while the rule hides the row, beside Hidden when both do, and says nothing for a row whose token stands on another scene, which the DM's view cannot judge. The icon pass may give it an eye-off icon later.

### 11.3 Every path the order reaches a player by

The rule lives in one place, `entryShown` and its state-level twin `rowSeenByNonOwners`, so every reader of a player's encounter follows it:

- **The encounter projection** (`projectEncounterCtx`): the row, its value and `tieOrder`. Numbering only the rows a player holds (design.md 7.3) already keeps a gap from counting hidden rows. `activeEntryId` and `started` are unchanged, since the acting row passes the rule. `round` counts every wrap, and a wrap starts the first row's turn, which shows it. `hadTurn` is the DM's: a player's copy drops it, so it never says which rows acted.
- **Turn lines** reach a player only while their encounter holds the row (`projectEventCtx`, `turn`), and are projected again whenever the encounter changes. Each is written at a turn's start or take-back, when its row passes the rule, so its `seen` mark is unchanged.
- **The turn's starting spot and the creature's path** reach a player only for the acting row their encounter holds.
- **Permissions** read the player's projected encounter (`visibleEntry`), so a row they may not see answers `gone`, as a row that does not exist does, and a guarded End turn while it acts is taken quietly as today (`activeRowShownTo`, `pressChangesNothing`).
- **Initiative rolls.** An initiative roll is a `dice.roll` the client marks with `initiative: true` on the roll: auto initiative and "Initiative for the 4 in the fight" (`initiativeRolls`), a row's Roll, and the Dice panel's Initiative (`d20` with the initiative test). When the reducer writes the line, a marked roll for a creature the order rule would keep from players now (`initiativeHidden`: no row of it has had its turn, and it is not shown from the start) gets `DiceRoll.hidden`. A player's dice line drops a hidden roll (`projectDiceCtx`), so an open roll sends no total and a secret one no bare line, and a line left with no roll is no line, hence no toast and nothing in Recent rolls. The mark is never rewritten, as `seen` is not: the roll stays out after the row is revealed, which by then shows its value anyway. Every marked roll keeps `DiceRoll.initiative` on its line, and every path that rolls again from a stored roll sends it marked again (Again on a Recent rolls row, `againInput`, which also reads `hidden` on a line from before the mark was kept; the sticky line's Again, which resends the inputs as sent; a row's Roll again and auto initiative's re-roll, which build a fresh initiative roll), so a repeat meets the rule as it stands then (B7B-ASTRA-01). The DM's log line and Recent rolls row say "hidden from players" on such a roll, as on other lines players never read, and no player's copy keeps the mark, its own player's included (B7B-P-5). Roll requests ask no initiative, so no ask of theirs rerolls one. A free formula the DM types is not an initiative roll. Auto initiative's shared roll names its first row's creature and always goes secret, so where players know that row's place and not another's in its group, they get the bare line alone, with no total and no count. The receipt goes to the roller alone, as before.
- **Up next.** A player has none (`turnStatus`, `stripRows`, client/features/encounter/logic.ts): the strip shows only the acting row, and no "Your turn soon" exists to name or skip a hidden row.
- **Snapshots and `ev`s** come from the same projection, and the fan-out sends a player nothing when only a hidden row changes, since their projected encounter (rev 0) is unchanged.
- **No log line names a place in the order.** Reorders, values and delays write none. Ready and other effects are lines about the creature, under the token rules. Area reminders are written on the creature's own turn or move.
- **Not the order.** A creature's token on the map follows Hidden and the fog, as the brief sets apart. An effect whose duration counts a row a player does not hold names "another creature" there (`anchorName`), as for a hidden row, and ticks only at that row's own turn boundaries, which come at or after its first turn. The one exception is a row Skip defeated passes over: its boundary still ticks, so a duration on it can end before it shows. Durations on a dead monster's turn are rare enough to leave.

### 11.4 Data and versions

```ts
type OrderReveal = 'party' | 'allies' | 'all'   // ORDER_REVEALS (shared/model.ts)
RoomSettings.playersSeeOrder?: OrderReveal      // absent reads 'all'. DEFAULT_SETTINGS sets 'party'
InitEntry.hadTurn?: true                        // the row's turn has started in this fight. The DM's
DiceRollInput.initiative?: true                 // the roll is a creature's initiative
DiceRoll.initiative?: true                      // the roll was a creature's initiative, so Again sends one
DiceRoll.hidden?: true                          // an initiative roll players may not have (11.3)
```

- **`hadTurn`** is set by `withTurn` (shared/reducer/encounter.ts) on the row whose turn starts, by Next and by a removal that passes the turn on. No op takes it as input. It rides in saved steps, so Previous and undo put it back with the encounter.
- **`OP_VERSION` moves to 8.** Ops stored before it ran without writing `hadTurn`. Replayed under a rule that writes it, a Next would leave the encounter and its history holding a field they did not hold then, and a later restore's guard hash would no longer match. So the reducer writes it only for live ops and ops stored at version 8 or later (`marksHadTurn`), as `answerProvenance` gates wave 7's rule, and the migration step is the identity. The new `initiative` field also makes a stored `sys.dice` that an older build's strict schema refuses, which the version makes that build refuse cleanly instead.
- **`SNAPSHOT_VERSION` moves to 12**, the identity step. Every new field is optional and reads as before when absent, so no snapshot changes. It moves so that an older build, which would ignore the setting and `DiceRoll.hidden` and send players every row and every hidden roll, refuses a snapshot from this build instead of publishing what the DM hid.
- **Schemas**: the import schema's settings (`playersSeeOrder`, default `all`), its encounter entry (`hadTurn`) and its dice roll (`hidden`). `remap` copies an entry whole, so `hadTurn` survives an import.
- **Deploy**: back up the database just before. The first op after it is stored at version 8, and the shutdown writes version 12 snapshots. **Rollback**: an older build refuses both, so going back restores that backup, losing the play since.

### 11.5 Tests

- **Projection** (`shared/project.order.test.ts`): each choice over a fight of a player character, a player's companion, a lent goblin, an Ally NPC, a hostile goblin, a DM NPC character row and a lair row. A player's encounter holds only what the choice shows, with no `hadTurn`, `tieOrder` 0 to n-1 and no total of a hidden row anywhere in their snapshot. The reveal on the row's turn, and its staying through a reorder, a new value, later rounds and a turn passed on by a removal. A row added mid-fight waiting for its turn. Previous taking the reveal back. Ending and starting a fight again. A ring change and a setting change mid-fight. The DM's projection and the preview's (`projectState` as the player) on the same state. Turn lines leaving and joining with their row.
- **Dice lines** (`shared/reducer/dice.order.test.ts`): a marked initiative roll for a hidden-order goblin, open and secret, reaching neither player nor a table display, as no line and no bare line, while the DM gets it whole. The same roll after the goblin's turn, for a player character, under `all`, and an unmarked free roll, reaching players as before. A mixed line keeping its shown rolls.
- **Randomized** (`shared/project.order.random.test.ts`): many random sequences of Next, Previous, reorders, new values, adds, removes, hides and unhides, ring changes, setting changes, initiative rolls, ending and starting the fight, applied through `applyOp`. The test keeps its own model of which rows had their turn. Invariants after every op: for each player and a table display, every row their encounter holds passes the model's rule, every row the rule shows and the older rules hold is there, `tieOrder` runs 0 to n-1, no `hadTurn` reaches them, no hidden roll's total or line reaches them, and the DM holds every row. The fan-out invariant (events applied to a snapshot equal the projection) keeps its own random test, whose ops gain the setting.
- **Versions**: an op stored at version 7 replaying with no `hadTurn` and its restore's guard matching, a live op writing it. The import schema defaulting an old backup to `all`, and reading `hadTurn` and `hidden`.
- **Client**: the settings field, its choices and its help. `initiativeRolls` and the d20 path marking initiative, and no other test.
- **e2e**: `combat.e2e.ts` gains one step: in a new room, a player's tracker shows their character and not the goblin before its turn, and the goblin's row once the DM's Next reaches it. Run `combat`, every other file that reads the order as a player, and `reach`.

### 11.6 Build

1. `docs: monsters' places in the initiative order stay secret until their turn` (this addendum).
2. `feat(settings): a room setting for which creatures players see in the initiative order`: the model, the protocol patch, the import schema, the form and their tests.
3. `feat(encounter): a row's place in the order reaches players on its first turn`: `hadTurn`, `withTurn`, the versions, `orderShown` in the projection and `rowSeenByNonOwners`, the fixtures and their tests.
4. `feat(dice): an initiative roll for a creature whose place is secret stays the dm's`: `initiative` on the roll, `DiceRoll.hidden`, the client's two marking paths and their tests.
5. The e2e step, then `docs:` commits for FEATURES.md and the DM guide's tracker section.
