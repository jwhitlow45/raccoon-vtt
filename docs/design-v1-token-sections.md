# raccoon-vtt v1: what each token section holds

Status: S1 built (the list and the tracker). S2 not built. Revised for design review rounds 1 and 2 (findings SEC-1 to SEC-15 and SEC-ASTRA-01 to 07, decided as D-261024-39 and D-261024-40). Code is cited from main at `1ca246d2`, the token bar from its stack (docs/design-v1-bar-compact.md, built and landing), the group icons from the second icon pass (docs/design-v1-icons-2.md, reviewed and not yet built) and the D&D Beyond class resources stack (docs/design-v1-ddb-resources.md, built and landing). Measured in the browser against short local prototypes that were not kept (section 5).

The project owner, 2026-10-24: "It feels a little weird that the token pop up has uses but the combat section doesn't. Up to ideas of what all should be included in the various sections"

Decided under guess mode as D-261024-38: the Token panel and a character's page hold everything about a creature. The token bar and the tracker row's options are quick subsets of it, so anything they offer is also in the panel, in the group of the same name. This note audits every surface against that rule and settles each group's contents.

## 1. The answer in short

- **Combat** holds, in order: Hit points, Conditions, **Uses**, **Reaction**, Range rings, Rest. On the Token panel and a character's page alike, which has no rings.
- **Uses** is the bar's Uses drawer and the tracker row's Uses group: one list, `CombatUses` in its `list` form. For a character it is also where class resources are edited and added, so the Class resources section goes. For the DM it holds the legendary pips, which wrap with 44 px targets and leave Stats. Its presence counts the turn's skipped prompts, so Reopen is always reachable.
- **Reaction** is new, shown while the creature has a row in the fight: the row's Reaction used switch alone, for the DM or the row's owner. Ready keeps its one editor, Conditions' Readied.
- **Range rings** stay in Combat, where the owner grouped them (D-261024-39).
- The panel gains what only the bar offered: **Duplicate** (the DM), **Dismiss** (a companion's player), **Attach** with Get off, Put down and Let go (whoever the bar offers them, on its play row or its group line), and **Size** for a player lent a character's token.
- **The tracker row's options** list the creature's things first, in Combat's order, then the row's own setup.
- **Exempt from the rule**, by name: map gestures (Undo move, Doesn't count, a door, Multi-select), links that open another panel (Roll, Details), the bar's frame (Expand, Collapse, Close, Scroll for more, the window's grip and resize), the alert cards' own buttons, the group line's names (each selects the token it names, which the header's link tags name too), and the surfaces for many creatures (the group bar, the party bar).

## 2. The audit

Every control and section on each surface, for the DM and a player, on a monster (the adult red dragon, a goblin), a character (Thorn, three class resources) and a companion (Skitter, a giant spider sharing Thorn's turn). "Strip" and "expanded" are the bar's states (docs/design-v1-bar-compact.md 3.3 and 5). Each row was checked against the code.

| Thing | Bar: strip / expanded | Tracker row options | Turn card | Token panel today | Character page today | Finding |
|---|---|---|---|---|---|---|
| Name, AC, HP, speed, PP | status line (AC, HP) / vitals line | AC and HP on the row's line | its title | header and quick numbers (AC, speed, PP, Init, elevation, Sheet), HP in Hit points | the same | ok |
| HP entry, Crit, "Use 9", Temp | the lead / the entry and its Temp mode | | | Hit points: the entry, Max HP and Temp HP | Hit points | ok |
| Death saves and their Roll | / while dying | | | Hit points | Hit points | ok |
| Revive, Stabilize, Mark dead | / Revive, the DM, dead | Revive, the DM, first | | Hit points, the DM | Hit points, the DM | ok |
| Conditions | Conditions, opening the drawer / chips and drawer | chips on the row's line | | Conditions: durations, concentration, Readied, rules text | the same | ok |
| **Uses** | Uses where it fits (after the HP lead only at 440 px) / Uses drawer, the DM and owners | Uses group | its card form | **missing**: a character's Class resources only | Class resources only | **gap: the owner's complaint** |
| Legendary counts used | | the DM's pips in Uses, one unwrapped row | counted | Stats: used steppers beside the maxima, the DM | | **misplaced**: play state in setup, two controls, and the row's pips run off a phone |
| Class resources | in Uses | in Uses | in the card | Class resources: Use, Restore, Edit, Update, Add | the same | **shown twice** once Uses joins Combat |
| Reaction used | | a switch: the DM, the row's owner, a shared companion's own | | **missing** | **missing** | **gap** |
| Ready: trigger, It fired | | `ReadyControls`: Trigger, Ready, Show the trigger to players, It fired: Reaction used, Drop it | | Conditions' Readied: Trigger, Show the trigger to players, It fired: Reaction used | the same | ok: one editor, Conditions' |
| A skipped prompt's Reopen | | | Reopen | **missing** | **missing** | **gap**: lost after the card's Dismiss |
| Range rings | | | | Combat | | ok (D-261024-39) |
| Rest | | | | Rest, not on an object | Rest | ok |
| Stat block, saves and defenses | / Stat block, the saves line where the viewer reads the block | Stat block | | Stat block group | Stat block | ok: links into the panel |
| The stat block's own: Add, Attach, Detach, Edit, Take a shape, End the shape, Re-sync | | | | Stat block group | Stat block | ok: the panel's alone |
| Elevation, facing, "Stand on it" | / −5 and +5, the ground notice | | | Position | | ok |
| Light | / Light | | | Position › Sight, "Light it carries" | | **name differs** |
| Attach, Get off, Put down, Let go | / the play row by `barSlots`, and the group line's Let go or Put down beside each carried token by `holderAction` and `detachAllowed`: the DM, a player who may move the carried token or its holder, or the carried token's owner | link tags on the line | | header tags and Steer, no controls. Position for the DM and owners only | | **gap**, for owners and non-owners both |
| Other images | / its row | | | Image | Image | ok |
| Size | / − and +, the DM or an owner of an unlocked token | | | Stats › Size, where Stats shows (not to a player lent only a character's token) | Stats › Size, the DM | **gap** for a lent token |
| Hidden from players | Hidden on a no-HP token / the eye, the DM | | | Token settings, the header's tag | | ok: "Hidden" with the eye where short |
| Locked | / the lock, the DM | | | Token settings | | ok |
| Duplicate | / the DM | | | **missing** | | **gap** |
| Delete, Dismiss | / Delete (the DM), Dismiss (a companion's player) | | | Remove: Delete, the DM | Remove | **gap**: Dismiss |
| The row's own: Hidden (the row), In lair, roll reminder, Roll Initiative, Auto Initiative, Move after, tie order, Remove from the fight | | the DM. A player: Roll again, Remove | | | | the row's, section 4 |
| Alert cards: death save, Regeneration, recharge, save-ends, with Roll, Apply, Skip, Dismiss | | | | | | prompts, homed in Hit points, Uses and Conditions |

What each viewer and kind changes:
- **The DM** sees every row above. **A player on their own character or companion** sees the same less the DM's: no pips, Revive, Hidden, Locked, Duplicate, Delete or row setup. **A player lent a character's token** owns the token but not the page: no Stats, no class resources, Size from the bar. **A player on another creature** gets the header, HP as the DM allows (the entry too with "players apply damage"), Conditions, rings and Notes for everyone. Uses never reach them (projection drops `uses`, `resources` and `turnRecord`). Their bar adds Multi-select, Details and any attach control: Attach where they may move it, Let go or Put down where they may move or own a token it holds or that holds it.
- **A monster's** Uses come from its block. **A character's** are its class resources, plus a shape's block uses while in a shape. **A companion's** come from its block, and a companion sharing its character's turn keeps a Reaction of its own (`companionReaction`). **An object's** Combat holds Hit points, Conditions and Range rings, with no Rest.
- **Three switches read "Hidden from players"**: the token's (Token settings), the row's (the tracker, "Players do not see this row") and a condition's (Conditions). The row's tag reads "Hidden", and the token's header tag will too after the second icon pass.
- At 320 x 568 at 130% today, Range rings' "Custom ft" field wraps alone under the presets (`measureAlignment` wrap-orphan, 62 px).

## 3. The proposal

The panel's order stays header, stat block, groups by use, setup (docs/design-v1-token-panel-groups.md 2). Group icons are the second icon pass's (its section 5). Section labels inside a group stay words (its 3.2).

| Part | Holds, in order | Who | Folded summary | Starts |
|---|---|---|---|---|
| Header, Stat block, Notes, Image, Companion, Owners | as today | as today | as today | as today |
| **Combat** | Hit points, Conditions, **Uses**, **Reaction**, Range rings, Rest | everyone, each section by its own rule | "HP 52/60 · 1 condition · Reaction used · rings 30 ft". "Reaction used" for every viewer while spent, as the row's tag shows it | open everywhere, as today |
| **Position** | Elevation and facing, **Attach**, Sight | the DM and owners, and any viewer the bar offers an attach control, who sees those controls alone | "On the ground, facing 90°", as today | folded, as today |
| **Stats** | Size, the card's fields, the legendary maxima only, Sheet link. **Size alone** for a player lent a character's token, on the bar's condition: unlocked, and a Custom size read only in the bar's words (`customWords`) | as today, and that player | | folded |
| **Token settings** | as today, then **Duplicate** (the DM) | as today | | folded |
| **Remove** | Delete this token (the DM), or **Dismiss** (a companion's player) | the DM, and now a companion's player (`access.dismiss`) | | |

**A character's page**: header, Place a token, Stat block, Combat (Hit points, Conditions, Uses, Reaction, Rest: no rings, as today), Companions, Notes, Image, Stats, Played by, Remove. Nothing of a token on a map, as today.

`panelSections` changes: `uses` and `reaction` join COMBAT before `rangeRings`, `resources` goes, `remove` shows for the DM or `dismiss`, Stats shows Size alone where the viewer owns the token, has no stat card and the token is unlocked (the bar's SizeRow condition, not `resize`, so a Custom size shows its read-only line), and Position's group draws for the DM and owners and for any attach control. That is a new `attachControls(view, viewer, token)` in attach/detach.ts: `barSlots` non-empty, or a token the group line lists as held whose `holderAction` the viewer may take by `detachAllowed`, the group line's own test.

### 3.1 Uses

- **The list**: `CombatUses` in its `list` form, the drawer's and the row group's. Legendary Resistance with Use, and Restore once one is spent. Legendary actions by name with their off reasons. Recharge and X/Day abilities, Other used, Regeneration's line, a character's class resources, and the turn's skipped prompts with Reopen (below). Its status line, busy buttons and loading line (`Loading the uses…`, or the inline reload) as built.
- **Who**: the DM and the creature's owners, where `useUsesPresence` is `yes` or `loading`, as the bar's button. For a character, the DM and its players always, so Add is reached with no resource yet. A player lent only a character's token gets no class resources, as today (`holdsClassResources`).
- **Skipped prompts** join the list form while their record is current (`usesRows`' card-only branch becomes both forms). `usesPresence` takes the creature's current record (`currentRecord`) in place of `null`, so a creature whose only rows are skipped prompts, such as a goblin whose death save was skipped, shows Uses on the panel, the bar and the row while the turn lasts. After Next the record is not current, and the rows and the presence go (D-261024-40).
- **Added in the panel and page only**:
  - **For a character**: Edit (the pencil alone, "Edit Rage") on each resource's button line, the level-up line ("Your level went up. Update Barbarian resources?" with Update), then "Add a class resource" or the limit's line. With nothing to list, the D&D Beyond stack's help line: "Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level, typed, or brought in with Re-sync from D&D Beyond." ResourceSheet opens from Edit, Update and Add unchanged, Remove included, and gives focus back to its opener. A re-sync writes `resources`, so its results show in Uses as they do today.
  - **For the DM**: the pips under the list, "Legendary Actions used" and "Legendary Resistances used today", each its words on a line, then its pips wrapping under them with fixed 44 px targets, in the panel and the tracker alike (D-261024-40, measures in 5). Stats keeps "Legendary Actions per round" and "Legendary Resistance per day".
- **Order inside Combat**: after Conditions, which everyone reads and which is short. Before Reaction, since a DM spends legendary actions after nearly every turn. Uses and Reaction go before Range rings, which keep their place just above Rest: both are spent turn by turn, while rings are set once and read on the map, and today's sections keep their order among themselves. Rejected: rings before Uses, which puts a control set once between Conditions and the list a fight spends from.

### 3.2 Reaction

- **When**: the creature has a row in the current fight, by `reactionTarget(view, self)` (encounter/ready.ts): its own row, or for a companion sharing its character's turn, its character's row with its own Reaction. A companion with no turn, or no fight, draws nothing.
- **Who**: the DM, or the row's owner by `ownsEntry`, as the server's `encounter.update` allows. A player lent a character's token whose row is the character's sees none. A shared companion's own switch goes to the DM and its owners (`companionReaction`), as its sub-row offers it. For everyone else, a spent Reaction is the row's "Reaction used" tag and Combat's summary.
- **Holds**: the row's switch alone, in the row's words: "Reaction used" with "Clears at the start of its turn" (the DM), "Clears at the start of your turn" (a player), or "Its own, which clears when its character's turn starts" (a shared companion). A player's switch is busy until the server answers, as the row's is.
- **Ready stays in Conditions** (D-261024-40): its Readied editor, with the trigger and Show the trigger to players, stays there in or out of a fight. Its It fired: Reaction used keeps today's rule, shown only where the creature has a Reaction to spend (`reactionTarget`), so only in a fight. The tracker's `ReadyControls` stays the row's quick form in the same words.
- On a character's page it is the character's row, by `reactionTarget(view, { characterId })`, with the same owner rule.

### 3.3 Position

- **Who**: the DM and owners see all of it. Any other viewer the bar offers an attach control sees Position with those controls alone (D-261024-40), by `attachControls`: a direct slot (`barSlots`: Attach for whoever may move the token, Get off, Let go or Put down on a carried token for whoever may move it or its holder, or owns it), or the group line's Let go or Put down beside a token it holds (`holderAction` with `detachAllowed`). So a player whose Thorn a goblin drags gets Position on the goblin's panel with Let go for Thorn. Its summary for them is the same.
- **Attach**: the bar's `AttachButton` (a popover from 900 px up, a sheet on a phone, as the class resource sheet opens over the panel's sheet today), the bar's group line with its names and Let go or Put down, and Get off with its note, each as the bar offers it: `barSlots` for the token's own, `holderAction` with `detachAllowed` for each token it holds. Steer stays under the header's tags, where it is read with "Riding Warhorse".
- **Sight** keeps its parts. Its light row reads **Light**, the bar's word.

### 3.4 One name, one control

| Thing | Everywhere it shows | Change |
|---|---|---|
| Uses | "Uses" in the strip, drawer, row group and the Combat section | the section is new |
| Class resources | rows in Uses, "Add a class resource" | the section's heading goes |
| Legendary counts used | pips "Legendary Actions used", "Legendary Resistances used today" | Stats' used steppers go, the pips wrap |
| Reaction used | the row's switch and help, the row's tag | the panel reuses the switch |
| Readied | Conditions' editor, the row's `ReadyControls`, the row's tag | none |
| Light | "Light" | the panel's "Light it carries" becomes "Light" |
| The row's hidden switch | "Row hidden from players", help unchanged | renamed. The token's and the condition's switches keep "Hidden from players", which their place makes plain, and the tags keep "Hidden" |
| Dismiss | "Dismiss" then "Dismiss {name}?" | the panel reuses the bar's button |
| Duplicate | "Duplicate" | the panel gets a worded button |

## 4. The tracker row's options

The creature's things first, in Combat's order, then the row's own setup, then Remove. No new label between them.

| | The DM | A player, own row | A companion's sub-row |
|---|---|---|---|
| The creature's | Revive (dead), **Uses** with the pips, Reaction used, Ready, Stat block | **Uses**, Reaction used, Ready, Stat block | Revive (the DM), **Uses**, Reaction used (its own), Ready, Stat block |
| The row's own | Roll or Roll again, **Row hidden from players**, In lair, Initiative roll reminder, Initiative modifier with Roll Initiative and Auto Initiative's group, Move after {rider}, Move up and Move down | Roll again | |
| Last | Remove | Remove | |

Today the DM's Uses group comes tenth, after the row's Roll, Hidden, In lair, roll reminder and Auto Initiative controls. In lair stays the row's: it is set as the creature joins (`joinEntry`), and its switch waits on the row's block. The row's pips wrap as the panel's do.

## 5. Measures

Seeded room: Thorn level 7 with Rage 2 of 3, Lay on Hands and Channel Divinity. The dragon has Fire Breath used and legendary counts of 3 and 3. Skitter, a goblin, and a fight under way. Each was opened by a tap on its tracker row, as the DM and as Pat. Heights are the Combat group's in screen px, open, today and as proposed. The round 1 prototype drew the proposal directly: Uses with the DM's wrapping pips, Reaction as the switch alone, the rings kept. Only Edit was not drawn.

| Creature, viewer | 1280 x 800 | 390 x 844 at 130% | 320 x 568 at 130% |
|---|---|---|---|
| Adult red dragon, DM | 698 to 1223 | 933 to 1613 | 1015 to 1824 |
| Thorn, DM | 1070 to 1165 | 1463 to 1587 | 1571 to 1718 |
| Thorn, Pat | 1018 to 1113 | 1396 to 1519 | 1503 to 1650 |
| Skitter, DM | 627 to 826 | 842 to 1101 | 904 to 1187 |
| Goblin, DM | 627 to 722 | 842 to 966 | 904 to 1052 |
| Thorn's page, DM | 910 to 1005 | 1255 to 1379 | 1300 to 1447 |
| Thorn's page, Pat | 858 to 953 | 1188 to 1311 | 1233 to 1380 |
| The scroller's view | 647 (Pat 755) | 328 | 159 |
| Combat folded | 49 | 63.4 | 63.4 |

- **Parts, at the three sizes**:
  - The dragon's Uses: 414, 536 and 641 with its pips at 3 and 3, and 274, 356 and 440 without them.
  - Thorn's Uses: 356, 510 and 510, the same as today's Class resources section.
  - Skitter's Uses: 88, 115 and 115.
  - Reaction: 79, 103 and 126.
  - Range rings, kept: 144, 187 and 250 with a ring on, and 116, 150 and 213 with none.
- **The pips**, both counts set to each maximum from 1 to 10, drawn in the panel's Uses and the tracker row's group:

| Pip rows by maximum | 1 row | 2 rows | 3 rows |
|---|---|---|---|
| 320 x 568 at 130%, panel (212 layout px) and tracker (195), 4 a row | 1 to 4 | 5 to 8 | 9 and 10 |
| 390 x 844 at 130%, panel (266), 6 a row | 1 to 6 | 7 to 10 | |
| 390 x 844 at 130%, tracker (249), 5 a row | 1 to 5 | 6 to 10 | |

  - **Heights**: a pip block is 80, 137 and 194 px for one, two and three rows of pips, with its words on one line. It is 20 px more where the words take two lines. That happens for "Legendary Resistances used today" at 320 and in the tracker at 390, and for "Legendary Actions used" at a maximum of 10 in the tracker at 320.
  - **Overflow**: no pip runs past its row at any maximum. At a maximum of 10, today's unwrapped row runs 6 pips past the tracker's room at 320 and 5 at 390, before its words beside them are counted.
- **Folded**: Combat's row is unchanged in height. Its summary keeps "rings" last and gains "Reaction used" before it while spent. At 390 and 320 at 130% it was cut before and is after ("HP 200/256 · 1 condition · rings 60 ft").
- **What scrolls**: one scroller per panel, the side panel's body at 1280 and the sheet's body on a phone. Nothing in it is sticky.
  - On a phone Combat starts 150 to 310 px down. At 320 x 568 at 130% that is below the first view, as today.
  - Open, Combat is 2.9 to 4.9 views of the sheet at 390 x 844 at 130% (2.6 to 4.5 today) and 6.6 to 11.5 at 320 x 568 at 130% (5.7 to 9.9 today). At 1280 it is 1.1 to 1.9 views (1.0 to 1.7 today).
  - At 1280 the dragon's stat block, open by default there, puts Combat 1725 px down, as today.
- **Default folds**: unchanged. Combat opens everywhere, since Hit points leads it and is the first thing wanted. No section inside it folds on its own.
- **Shots**: today's are in `screenshots/sections/audit2/`. The first prototype's are in `screenshots/sections/proposal2/`, named `token-{viewer}-{creature}-{top|combat-end}-{size}` and `page-{viewer}-thorn-…`. The round 1 prototype's are in `screenshots/sections/r1/`. They show the DM on the dragon, Thorn, Skitter and the goblin, Pat on Thorn and Skitter, and both on Thorn's page. A player on another creature was read from the code, because Pat's tracker lists only his rows.

## 6. Decisions, with rejected options

1. **Uses is a section of Combat, after Conditions**, the bar's list. Rejected: a Uses group of its own, folded, which hides the owner's ask behind a tap, and D-261024-38 puts it in Combat. Rejected: a second, panel-only view (D-261024-38).
2. **Class resources fold into Uses for a character**, with Edit, Update and Add there. Rejected: a Class resources section beside Uses, which shows Rage twice in one group. Rejected: Uses without class resources in the panel, which then differs from the bar's.
3. **Range rings stay in Combat** (D-261024-39), after Reaction and before Rest. The owner grouped them there on 2026-10-17 ("the hp/conditions/range rings/rest should probably have their own drop down"), and they are read in a fight for reach and range. Rejected: Position, since it reverses the owner's own grouping and folds them away mid-fight.
4. **Reaction is a section while the creature is in the fight, holding Reaction used alone, for the DM or the row's owner** (D-261024-40). Rejected: leaving it in the tracker alone, which breaks D-261024-38's rule. Rejected: a Turn section with the initiative value and Roll, a second place to reorder the fight, which W7B-P-6 kept a stray tap from doing. Rejected: showing it to every full-access viewer, which offers a lent player a switch the server refuses.
5. **Initiative**: the bonus stays a quick number ("Init +2") and a Stats field, the value and its Roll stay the row's. Rejected: the value in the panel.
6. **Death saves stay in Hit points**, beside the 0 HP that brings them. Rejected: a section of their own. The turn-start card stays a prompt, not their home.
7. **Effects, durations, concentration and Readied stay in Conditions**, Ready's one editor (D-261024-40). Rejected: a Concentration section. Rejected: a second Ready editor in Reaction. Rejected: moving the trigger between sections as a fight starts and ends.
8. **One control for the legendary counts used**: the pips, wrapping with fixed 44 px targets, in Uses on the panel and the row (D-261024-40). Rejected: Stats' steppers beside the row's pips. Rejected: the pips' one unwrapped row, which runs off a phone.
9. **The row's options lead with the creature's things in Combat's order.** Rejected: today's order. Rejected: a label between the parts, a line more on a phone.
10. **Exempt by name**: map gestures, links to other panels, the bar's frame, the alert cards' buttons, and the surfaces for many creatures. A drag never starts in the panel, the top bar holds Undo, the Dice panel is a tab away, and a card's Skip answers one prompt. Rejected: copies in the panel.
11. **The panel gains Duplicate, Dismiss and Attach, and Size for a lent token** (D-261024-40). Rejected: leaving them in the bar, against the rule. Rejected: exempting Size.
12. **Position draws for any viewer the bar offers an attach control**, a direct slot or the group line's Let go or Put down, with those controls alone for one who is neither the DM nor an owner (D-261024-40). Rejected: a separate place for Attach. Rejected: leaving non-owners' controls in the bar alone. Rejected: gating on `barSlots` alone, which hides a holder's Let go from the held token's player.
13. **"Light" and "Row hidden from players".** Rejected: "Light it carries" on the bar's shared line. Rejected: one name for the token's switch and the row's.
14. **Skipped prompts' Reopen stays in Uses, and Uses' presence counts them** (D-261024-40). Rejected: on the card alone, where a local Dismiss leaves no way back until Next. Rejected: a death save's Reopen beside the death saves in Hit points, a second home while Regeneration and recharge prompts stay in Uses. Save-ends cards settle their effect, not a prompt, so they stay with Conditions.

## 7. UI checklist

- **Loading**: Uses keeps the list's own: counts at once, rows that need the block under the shared Loading ("Loading the uses…", after 200 ms), the inline reload on failure, and each button busy until the server answers. Reaction used is busy for a player until answered. Duplicate and Dismiss as the bar's.
- **Keys and focus**: no new keys. Edit, Update and Add hand ResourceSheet their button for focus to return to. Escape in a pool's amount field closes only the field, never the sheet. Dismiss's second tap is a new name on the same focused button. **Duplicate** passes `opens` as the bar does, which counts only while the bar shows (selection.ts `selectToken`), so a closed bar moves nothing. The panel remounts for the copy, keyed by the selection, and focus goes to the copy's name heading (CreatureHeader's `focusable`, as a character's page has it).
- **Screen readers**: headings "Uses" and "Reaction" (h4) in Combat. The list is named "{name}'s uses". An off button keeps its focus and reads why. Each pip group keeps its name, and each pip "{n} used" with its pressed state.
- **Large sizes**: every new section was drawn at 130% (section 5). Edit shares the resource's button line. By an estimate, Use…, Restore… and Edit take about 196 of 212 layout px at 320 x 568 at 130%, so the builder measures it. Rings' orphan field (section 2) is fixed or allowed in S2, which redraws Combat.
- **The exact words**:
  - Uses and Reaction: "Uses", "Reaction", and "Reaction used" with the three help lines of 3.2.
  - Class resources: "Add a class resource", and the D&D Beyond help line of 3.1.
  - Legendary counts: "Legendary Actions used", "Legendary Resistances used today", "{n} used", "Legendary Actions per round" and "Legendary Resistance per day".
  - Other controls: "Light", "Row hidden from players", "Duplicate", "Dismiss", "Dismiss {name}?".
  - The summary: Combat's "rings 30 ft".

## 8. Cases

| Case | Expected | Test |
|---|---|---|
| The DM on the dragon, off its turn | Combat: Hit points, Conditions, Uses with Fiery Rays live and the pips, Reaction, Range rings, Rest | tokenpanel |
| Fiery Rays from the panel | A pip spent, the row's LA chip and the bar's drawer show it | combatuses |
| Legendary counts of 10 at 320 x 568 at 130% | Three rows of four, four and two pips, nothing past the row, in the panel and the row | alignment |
| Pat on Thorn | Uses: Rage 2 of 3 with Use, Restore and Edit, Add. No Class resources heading | classresources |
| Pat adds a resource from the panel's Uses | The sheet opens, and focus returns to "Add a class resource" | classresources |
| Thorn's level rises | "Your level went up…" with Update in Uses, on the panel and the page | classresources |
| Thorn with no resources | Uses shows the D&D Beyond help line and Add | classresources |
| A goblin with no uses, in the fight | No Uses section. Reaction shows for the DM | tokenpanel |
| That goblin's death save skipped, its turn card dismissed | Uses with "Death save skipped" and Reopen on the panel, the bar and the row, all gone after Next | combatuses, logic.test |
| No fight | No Reaction section | panelOrder.test |
| A player lent Thorn's token, Thorn's row keyed by the character | No Reaction switch, Stats with Size alone, Size changes it. On a Custom size, the bar's read-only words. Locked, no Stats | tokenpanel |
| Skitter sharing Thorn's turn | Reaction is its own switch with its help line, for the DM and Pat | tokenpanel |
| Reaction used toggled in the panel | The row's "Reaction used" tag and switch follow. Combat's summary shows it to every viewer | combat |
| Pat readies an action from Conditions in a fight | Readied with its trigger, and It fired spends the row's Reaction | tokenpanel |
| Pat on the dragon | HP as allowed, Conditions and the rings' line. No Uses, no Reaction, no Position | tokenpanel |
| Pat may move any token, on a goblin | Position with Attach alone | attach |
| Pat's Thorn drags a goblin, Pat on the goblin | Position with Let go alone | attach |
| A goblin drags Pat's Thorn, Pat on the goblin | Position with the group line's Let go for Thorn alone | attach |
| A monster whose block loads | Uses holds the list's loading line, then its rows | combatuses |
| The DM's row options | Uses before Row hidden from players | combat |
| Duplicate from Token settings | A copy beside it, selected, the panel showing it, focus on its name | tokenpanel |
| Pat dismisses Skitter from Remove | Two taps, the token goes | companions |
| Attach from Position on a phone | The attach sheet over the panel's sheet, the link made, Get off then offered | attach |
| Stats for the DM on the dragon | The maxima, no used steppers | tokenpanel |

## 9. Tests

- `panelOrder.test.ts`:
  - Combat's order for the DM, an owner, another player, a lent player, a character, a companion and an object.
  - Uses shows only with presence, or with a character's resources for the DM and its players.
  - Reaction shows only with a row and the DM or `ownsEntry`.
  - Remove shows for the DM or `dismiss`. Stats with Size alone for a lent player on an unlocked token, Custom size included.
  - Position for a direct slot alone, and for a group line's Let go alone (`attachControls`).
  - Every section once.
- `logic.test.ts`: `usesRows` lists skipped rows in the list form while the record is current, and none after Next. `usesPresence` is `yes` for a creature whose only rows are skipped prompts.
- `UsesSection.test.ts`, moved from the D&D Beyond stack's `ClassResourcesSection.test.ts`: the help line, rows with Restore and Edit, Add or the limit, and the level-up line.
- `usesSurfaces.test.ts`: lines 82 and 88 match "Row hidden from players".
- e2e, the touched files plus `reach`: `tokenpanel`, `classresources`, `combatuses`, `combat`, `characters`, `companions`, `attach` and `alignment`. The alignment sweep takes the Uses section with pips at maxima 3 and 10, and the Reaction section, as roots at its sizes.
- **Mutation**:
  - COMBAT in today's order fails panelOrder.test.
  - Skipped rows card-only, or `usesPresence` back on `record: null`, fails logic.test and combatuses.
  - The pips without wrapping fail the alignment step at a maximum of 10.
  - The old menu order fails combat's order step.
  - Stats' used steppers back fail tokenpanel.
  - Position gated on owners again fails attach. Position on `barSlots` alone fails panelOrder.test for the goblin dragging Thorn.

## 10. Lane plan

It builds after three stacks land:
- **The bar stack** edits CharacterCard.tsx, and the tokenpanel, classresources and combatuses e2e files.
- **The second icon pass** edits TokenPanel.tsx, CharacterCard.tsx and Panel.tsx's group headers.
- **The D&D Beyond stack** edits ClassResourcesSection.tsx and its new test, the classresources and resync e2e files, FEATURES.md 375 and docs/dm-guide.md 1079.

| Lane | Owns | e2e |
|---|---|---|
| **S1, the list and the tracker**, beside the icon pass once the bar and D&D Beyond stacks land | combat/CombatUses.tsx (Edit and pips slots, presence with the record), combat/logic.ts (skipped rows, `usesPresence`), resources/ResourceRows.tsx (Edit on its line), combat/UsesSection.tsx (new, from ClassResourcesSection's parts and its test), encounter/ReactionSection.tsx (new), encounter/Pips.tsx (moved out of Row.tsx, wrapping), encounter/Row.tsx (order, rename), combat/usesSurfaces.test.ts, their tests | combatuses, classresources, combat |
| **S2, the groups**, in the icon pass's lane right after its Token panel part | tokens/panelOrder.ts, attach/detach.ts (`attachControls`), panels/TokenPanel.tsx, tokens/CharacterCard.tsx, tokens/StatsSection.tsx (maxima only, with the pips in place), vision/TokenSight.tsx, a `useDuplicate` hook out of canvas/TokenActionBar.tsx, resources/ClassResourcesSection.tsx and its test deleted, panelOrder.test.ts | tokenpanel, characters, companions, attach, alignment |

- **S1's first commit** exports `UsesSection({ target, name, character? })` and `ReactionSection({ self, name })`, so S2 starts from it.
- **Stats' used steppers** go in S2, in the same commit that puts the pips in the panel's Uses, so no build between the lanes leaves the DM without a way to set the counts outside a fight.
- **Why S2 shares the icon lane**: both change the same group headers and summaries in TokenPanel.tsx and CharacterCard.tsx, and the icon pass's summary floor (its 3.3) cuts the new Combat summary. Built after it, S2 measures it against the floor.
- **Docs**, in S2's last commit, starting from the D&D Beyond stack's wording where it changed a line:
  - **FEATURES.md**: 126 (the groups), 177 (Reaction used), 282 (the row's switch), 290 (Uses in the panel and page), 373 (the page's Combat) and 375 (class resources in Uses).
  - **docs/dm-guide.md**: 473 (Combat's sections), 585 and 591 to 593 (the options' order, the renamed switch, Uses and Reaction in the panel) and 1079 (class resources in Uses).

## As built

The builder fills this in the lane's docs commit with every place the build went its own way.

### S1 as built

S1 built the list and the tracker. The Token panel and the page do not show `UsesSection` or `ReactionSection` yet: S2 places them.

- **`UsesSection({ target, name, character? })`** (combat/UsesSection.tsx) is the list form of `CombatUses` under a "Uses" heading, for the DM and owners while `useUsesPresence` is `yes` or `loading`. With `character` it always draws, and adds the level-up line, Edit on each resource's button line, then Add or the limit's line. It draws nothing for a creature with no use and no `character`, so S2 may pass it for any viewer the section is for and let it decide the rest.
  - The level-up line comes first, above the list, as the Class resources section had it, so the question is read before the rows it changes.
  - The help line shows where the list holds nothing (`useUsesPresence` is `no`), as 3.1 says. A character in a shape whose block has uses shows those rows and no help line.
  - The DM's pips are `CombatUses`' `pips` slot, inside the list's box after its status line. Edit is its `edit` slot, passed to the class resource rows.
- **`CombatUses`** draws nothing where it has no row, no loading line and no class resource, for a character too. Before, a character with nothing drew an empty box, which would have taken a gap in the section.
- **Edit on its line**: Use…, Restore… and Edit need 207 of the 212 layout px at 320 x 568 at 130% (the design's estimate was 196), measured on Lay on Hands' row in the browser. They hold one line there. Below 207 px Edit would wrap alone, which no Combat section reaches.
- **The pips** (encounter/Pips.tsx): `LegendaryPips({ target })` reads the counts and writes them where the actor lives (the character a token plays, else the token), for the tracker row and, in S2, the section. Each count keeps its words with the count after them, "Legendary Actions used: 1 of 3", as the row's pips had them. Each pip is round, its focus ring included, so a lone pip on the last row reads as one of the set, and the alignment check takes the row of round targets as choices rather than a wrapped orphan.
  - Measured in the tracker row (combatuses s1-cu-a), both counts at each maximum from 1 to 10: 4 a row at 320 x 568 at 130% (rows of 1 to 4, 5 to 8, 9 and 10) and 5 a row at 390 x 844 at 130% (1 to 5, 6 to 10), as section 5's table has them. No pip past its row, each 57.2 px (44 layout px at 130%), each dot 0.01 px off its pip's center, nothing over 1 px. The words take two lines for "Legendary Resistances used today" at both sizes and for "Legendary Actions used" at a maximum of 10 at 320. A block is 86, 143 and 200 px for one, two and three rows of pips, 24 px more with two lines of words: 6 px over section 5's, since the words keep the body line height.
- **`ReactionSection({ self, name })`** (encounter/ReactionSection.tsx) holds `ReactionSwitch`, the one switch the row's options, a companion's sub-row and the section now share, under a "Reaction" heading. `name` names the switch's group, "Thorn's reaction", as the uses list is named. `reactionFor(view, you, self)` is the pure rule (the DM, the row's owner by `ownsEntry`, a shared companion's owners by `ownsToken`), exported for S2's `panelSections`.
- **The tracker row's options** are in section 4's order. A companion's sub-row lists its Uses first too, with no pips, as section 4's table has it. Measured whole at 1280 x 800, 390 x 844 at 130% and 320 x 568 at 130% (combat s1-c-a), the options showed "Disadvantage" alone under the reminder's other two buttons at all three, from before S1. The three now grow to fill their lines, so none stands alone.
  - Not fixed here: at 320 x 568 at 130% the row's own line stacks AC, HP and the LA and LR tags one to a line, and the edge check reads the tags' words, inside their pills, 11.4 px right of the AC and HP. The line is unchanged since before S1 and drawn by parts.tsx and Tag.tsx, which S1 does not own. s1-c-a logs it.
- **Skipped prompts**: `usesPresence` takes `record`, required, so no caller can leave the current record out by mistake.
- **Tests**: UsesSection.test.ts is new beside ClassResourcesSection.test.ts, which S2 deletes with the section. The order is checked in usesSurfaces.test.ts on the rendered options and in combat s1-c-a in the browser. The pips' alignment is in combatuses s1-cu-a, not the alignment sweep, which S2 edits: the panel's pips are S2's to measure once it places them.
