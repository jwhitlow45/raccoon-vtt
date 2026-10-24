# raccoon-vtt v1: what each token section holds

Status: designed, not built. Code is cited from main at `1ca246d2`, the token bar from its stack (docs/design-v1-bar-compact.md, built and landing) and the group icons from the second icon pass (docs/design-v1-icons-2.md, reviewed and not yet built). Measured in the browser against a short local prototype that was not kept (section 5).

The project owner, 2026-10-24: "It feels a little weird that the token pop up has uses but the combat section doesn't. Up to ideas of what all should be included in the various sections"

Decided under guess mode as D-261024-38: the Token panel and a character's page hold everything about a creature. The token bar and the tracker row's options are quick subsets of it, so anything they offer is also in the panel, in the group of the same name. This note audits every surface against that rule and settles each group's contents.

## 1. The answer in short

- **Combat** holds, in order: Hit points, Conditions, **Uses**, **Reaction**, Rest. On the Token panel and a character's page alike.
- **Uses** is the bar's Uses drawer and the tracker row's Uses group: one list, `CombatUses` in its `list` form. For a character it is also where class resources are edited and added, so the Class resources section goes. For the DM it holds the legendary pips the tracker holds, which leave Stats.
- **Reaction** is new, shown while the creature has a row in the fight: the tracker's Reaction used switch and its Ready controls.
- **Range rings** move from Combat to **Position**, a map aid beside elevation and facing.
- The panel gains what only the bar offered: **Duplicate** (the DM), **Dismiss** (a companion's player) and **Attach** with Get off, Put down and Let go.
- **The tracker row's options** list the creature's things first, in Combat's order, then the row's own setup.
- **Exempt from the rule**, by name: map gestures (Undo move, Doesn't count, a door, Multi-select) and links that open another panel (Roll, Details). The turn card's frame (Collapse, Show, Dismiss) is the card's own.

## 2. The audit

Every control and section on each surface, for the DM and a player, on a monster (the adult red dragon, a goblin), a character (Thorn, three class resources) and a companion (Skitter, a giant spider sharing Thorn's turn). "Own" is the DM or an owner. "Strip" and "expanded" are the bar's states (docs/design-v1-bar-compact.md 3.3 and 5).

| Thing | Bar: strip / expanded | Tracker row options | Turn card | Token panel today | Character page today | Finding |
|---|---|---|---|---|---|---|
| Name, AC, HP, speed, PP | status line / vitals line | AC, HP on the row's line | title | header, quick numbers with Init, elevation, Sheet | header | ok |
| HP entry, Crit, "Use 9" | the lead / the entry | | | Combat › Hit points | Combat › Hit points | ok |
| Max HP, Temp HP | | | | Hit points | Hit points | ok |
| Death saves and their Roll | / while dying | | death save card | Hit points | Hit points | ok |
| Revive | / the DM, dead | the DM, first | | Hit points (Revive, Stabilize, Mark dead) | Hit points | ok |
| Conditions | Conditions, opening the drawer / chips and drawer | chips on the line | | Combat › Conditions, with durations, concentration and rules text | same | ok |
| **Uses** | Uses (fits only at 440 px) / Uses drawer | Uses group | its card form | **missing**: a character's Class resources only | Class resources only | **gap: the owner's complaint** |
| Legendary counts used | | the DM's pips in Uses | counted | Stats › two steppers, the DM's | | **misplaced**: play state in setup, two controls for one thing |
| Class resources | in Uses | in Uses | in the card | Combat › Class resources, with Edit and Add | same | **shown twice** once Uses joins Combat |
| Reaction used | | a switch, own (a shared companion's is its own) | | **missing** | **missing** | **gap** |
| Ready, "It fired: Reaction used" | | Ready controls, own | | **missing** (Readied is listed in Conditions) | **missing** | **gap** |
| A skipped prompt's Reopen | | | Reopen | **missing** | **missing** | **gap**: lost after the card's Dismiss |
| Range rings | | | | Combat | | **misplaced**: they mark the map |
| Rest | | | | Combat › Rest | Combat › Rest | ok |
| Stat block, saves and defenses | / Stat block, saves line (the DM) | Stat block | | Stat block group | Stat block | ok: links into the panel |
| Elevation, facing | / −5 and +5 | | | Position | | ok |
| Light | / Light | | | Position › Sight, "Light it carries" | | **name differs** |
| Attach, Get off, Put down, Let go | / play row, group line | link tags on the line | | header tags and Steer only | | **gap** |
| Other images | / its row | | | Image | Image | ok |
| Size | / − and + | | | Stats › Size | Stats › Size (the DM) | ok |
| Hidden from players | Hidden (the DM, no-HP tokens) / the eye | | | Token settings, the header's tag | | ok: short form "Hidden" with the eye |
| Locked | / the lock | | | Token settings | | ok |
| Duplicate | / the DM | | | **missing** | | **gap** |
| Delete, Dismiss | / Delete (the DM), Dismiss (a companion's player) | | | Remove: Delete (the DM) | Remove | **gap**: Dismiss |
| Undo move, Doesn't count, a door | Roll's place / passing row | | | | | exempt: a map gesture |
| Multi-select | strip / play row | | | | | exempt: map selection |
| Roll | Roll's place / play row | | | | | exempt: opens the Dice panel |
| Details | strip / Read more | | | (it is the panel) | | exempt |
| The row's own: Hidden (the row), In lair, roll reminder, Roll Initiative, Auto Initiative, Move after, tie order, Remove from the fight | | the DM (a player: Roll again, Remove) | | | | the row's, section 4 |

What each viewer and kind changes:
- **The DM** sees every row above. **A player on their own character or companion** sees the same less the DM's: no pips, Hidden, Locked, Duplicate, Delete or row setup. **A player on another creature** gets the header, HP as the DM allows, Conditions and Notes for everyone. Uses never reach them (projection drops `uses`, `resources` and `turnRecord`), and their bar offers Multi-select and Details.
- **A monster's** Uses come from its block. **A character's** are its class resources, plus a shape's block uses while in a shape. **A companion's** come from its block, and a companion sharing its character's turn keeps a Reaction of its own (`companionReaction`). **An object** has Hit points alone in Combat.
- **Two things share one name**: the token's "Hidden from players" (Token settings) and the row's "Hidden from players" (the tracker's switch, "Players do not see this row").
- At 320 x 568 at 130% today, Range rings' "Custom ft" field wraps alone under the presets (`measureAlignment` wrap-orphan, 62 px).

## 3. The proposal

The panel's order stays header, stat block, groups by use, setup (docs/design-v1-token-panel-groups.md 2). Group icons are the second icon pass's (its section 5). Section labels inside a group stay words (its 3.2).

| Part | Holds, in order | Who | Folded summary | Starts |
|---|---|---|---|---|
| Header, Stat block, Notes, Image, Companion, Owners | as today | as today | as today | as today |
| **Combat** | Hit points, Conditions, **Uses**, **Reaction**, Rest | everyone, each section by its own rule | "HP 52/60 · 1 condition · Reaction used" | open everywhere, as today |
| **Position** | Elevation and facing, **Range rings**, **Attach**, Sight | the DM and owners, and a player on another creature only while it has rings, which they read | "On the ground, facing 90°, rings 30 ft" | folded, as today |
| **Stats** | Size, the card's fields, the legendary maxima only, Sheet link | as today | | folded |
| **Token settings** | as today, then **Duplicate** (the DM) | as today | | folded |
| **Remove** | Delete this token (the DM), or **Dismiss {name}** (a companion's player) | | | |

**A character's page**: header, Place a token, Stat block, Combat (Hit points, Conditions, Uses, Reaction, Rest), Companions, Notes, Image, Stats, Played by, Remove. Nothing of a token on a map, as today.

### 3.1 Uses

- **The list**: `CombatUses` in its `list` form, the drawer's and the row group's. Legendary Resistance with Use and Restore, legendary actions by name with their off reasons, recharge and X/Day abilities, Other used, Regeneration's line, a character's class resources, and the turn's skipped prompts with Reopen (below). Its status line under it, its busy buttons and its loading line (`Loading the uses…`, or the inline reload) as built.
- **Who**: the DM and the creature's owners, where `useUsesPresence` is `yes` or `loading`, as the bar's button. For a character, the DM and its players always, so Add is reached with no resource yet. A player lent only a character's token gets no class resources, as today (`holdsClassResources`).
- **Added in the panel and page only**:
  - **For a character**: Edit (the pencil alone, "Edit Rage") on each resource's button line, the level-up line ("Your level went up. Update Barbarian resources?" with Update), then "Add a class resource" or the limit's line. With nothing to list, the help line of today's section. ResourceSheet opens from Edit, Update and Add, and gives focus back to its opener.
  - **For the DM**: the tracker's pips under the list, "Legendary Actions used" and "Legendary Resistances used today". Stats keeps "Legendary Actions per round" and "Legendary Resistance per day".
- **Skipped prompts** join the list form while their record is current (`usesRows`' card-only branch becomes both forms), so Reopen stays reachable from the panel, the row and the bar after the card's Dismiss. After Next the record is not current, so the rows go.
- **Order inside Combat**: after Conditions, which everyone reads and which is short. Before Reaction, since a DM spends legendary actions after nearly every turn.

### 3.2 Reaction

- **When**: the creature has a row in the current fight, by `reactionTarget(view, self)` (encounter/ready.ts): its own row, or for a companion sharing its character's turn, its character's row with its own Reaction. A companion with no turn, or no fight, draws nothing.
- **Who**: the DM and the creature's owners, as the row's options. Another creature's spent Reaction stays the row's "Reaction used" tag for everyone.
- **Holds**: the row's switch, in the row's words: "Reaction used" with "Clears at the start of its turn" (the DM), "Clears at the start of your turn" (a player), or "Its own, which clears when its character's turn starts" (a shared companion). Then `ReadyControls` with the same answer the row passes. A player's switch is busy until the server answers, as the row's is.
- On a character's page it is the character's row, by `reactionTarget(view, { characterId })`.

### 3.3 Position

- **Range rings** follow Elevation and facing. For a viewer who may not change them they read as today's labelled line ("30/60 ft" under RANGE RINGS), and Position draws for another's creature only to hold that line.
- **Attach**: the bar's `AttachButton` (a popover from 900 px up, a sheet on a phone, as the class resource sheet opens over the panel's sheet today), the bar's group line with its names and Let go or Put down, Get off with its note. Steer stays under the header's tags, where it is read with "Riding Warhorse".
- **Sight** keeps its parts. Its light row reads **Light**, the bar's word.

### 3.4 One name, one control

| Thing | Everywhere it shows | Change |
|---|---|---|
| Uses | "Uses" in the strip, drawer, row group and the Combat section | the section is new |
| Class resources | rows in Uses, "Add a class resource" | the section's heading goes |
| Legendary counts used | pips "Legendary Actions used", "Legendary Resistances used today" | Stats' two used steppers go |
| Reaction used, Ready | the row's switch and help, `ReadyControls`, the row's tag | the panel reuses them |
| Light | "Light" | the panel's "Light it carries" becomes "Light" |
| The row's hidden switch | "Row hidden from players", help unchanged | renamed, as it is not the token's "Hidden from players" |
| Dismiss | "Dismiss" then "Dismiss {name}?" | the panel reuses the bar's |
| Duplicate | "Duplicate" | the panel gets a worded button |

## 4. The tracker row's options

The creature's things first, in Combat's order, then the row's own setup, then Remove. No new label between them.

| | The DM | A player, own row | A companion's sub-row |
|---|---|---|---|
| The creature's | Revive (dead), **Uses** with the pips, Reaction used, Ready, Stat block | **Uses**, Reaction used, Ready, Stat block | Revive (the DM), **Uses**, Reaction used (its own), Ready, Stat block |
| The row's own | Roll or Roll again, **Row hidden from players**, In lair, Initiative roll reminder, Initiative modifier with Roll Initiative and Auto Initiative's group, Move after {rider}, Move up and Move down | Roll again | |
| Last | Remove | Remove | |

Today the DM's Uses group comes tenth, after the row's Roll, Hidden, In lair, roll reminder and Auto Initiative controls. In lair stays the row's: it is set as the creature joins (`joinEntry`), and its switch waits on the row's block.

## 5. Measures

Seeded room (Thorn level 7 with Rage 2 of 3, Lay on Hands and Channel Divinity, the dragon with Fire Breath used, Skitter, a goblin, a fight under way), opened by a tap on the tracker row as the DM and as Pat. Heights are the Combat group's in screen px, open, today and with the prototype of sections 3.1 to 3.3 (Uses, Reaction, rings moved, without the pips or Edit).

| Creature, viewer | 1280 x 800 | 390 x 844 at 130% | 320 x 568 at 130% |
|---|---|---|---|
| Adult red dragon, DM | 698 to 975 | 933 to 1293 | 1015 to 1421 |
| Thorn, DM | 1070 to 1057 | 1463 to 1446 | 1571 to 1515 |
| Thorn, Pat | 1018 to 1005 | 1396 to 1379 | 1503 to 1447 |
| Skitter, DM | 627 to 747 | 842 to 998 | 904 to 1021 |
| Goblin, DM | 627 to 642 | 842 to 862 | 904 to 886 |
| Thorn's page, DM | 910 to about 1041 | 1255 to about 1425 | 1300 to about 1494 |
| The scroller's view | 647 (Pat 755) | 328 | 159 |
| Combat folded | 49 | 63.4 | 63.4 |

- **Parts, at the three sizes**: the dragon's Uses 274, 356 and 440. Thorn's Uses 356, 510 and 510, the same as today's Class resources section. Skitter's 88, 115 and 115. Reaction 131, 170 and 194, mostly the Ready field. Range rings leaving Combat: 144, 187 and 250. The page's Reaction is added from the panel's, not drawn. The DM's two pips are not drawn: two 44 px rows, about 100 px more at 100% and 120 at 130%, on a legendary creature only.
- **Folded**: Combat's row is unchanged in height. Its summary loses "rings" and gains "Reaction used" while spent. At 320 x 568 at 130% it was cut before and is after ("HP 200/256 · 1 condition").
- **What scrolls**: one scroller per panel, the side panel's body at 1280 and the sheet's body on a phone. Nothing in it is sticky. On a phone Combat starts 150 to 310 px down, below the first view at 320 x 568 at 130% as today. Open, it is 2.6 to 4.4 views of the sheet at 390 x 844 at 130%, 5.6 to 9.5 at 320 x 568 at 130%, and 1 to 1.6 views at 1280. At 1280 the dragon's stat block, open by default there, puts Combat 1725 px down, as today.
- **Default folds**: unchanged. Combat opens everywhere, since Hit points leads it and is the first thing wanted. No section inside it folds on its own.
- **Shots**: today in `screenshots/sections/audit2/`, the prototype in `screenshots/sections/proposal2/`, named `token-{viewer}-{creature}-{top|combat-end}-{size}` and `page-{viewer}-thorn-…`, for the DM on the dragon, Thorn, Skitter and the goblin and Pat on Thorn and Skitter, and both on Thorn's page. A player on another creature was read from the code: Pat's tracker lists only his rows.

## 6. Decisions, with rejected options

1. **Uses is a section of Combat, after Conditions**, the bar's list. Rejected: a Uses group of its own, folded, which hides the owner's ask behind a tap, and D-261024-38 puts it in Combat. Rejected: a second, panel-only view (D-261024-38).
2. **Class resources fold into Uses for a character**, with Edit, Update and Add there. Rejected: a Class resources section beside Uses, which shows Rage twice in one group. Rejected: Uses without class resources in the panel, which then differs from the bar's.
3. **Range rings move to Position.** They mark the map, are set rather than spent, and no rule of a fight changes them. Combat gains Uses, and Position's folded summary still names the rings. Rejected: keeping them in Combat, as the owner grouped them on 2026-10-17.
4. **Reaction is a section while the creature is in the fight.** Rejected: leaving Reaction used and Ready in the tracker alone, which breaks D-261024-38's rule. Rejected: a Turn section with the initiative value and Roll, a second place to reorder the fight, which W7B-P-6 kept a stray tap from doing.
5. **Initiative**: the bonus stays a quick number ("Init +2") and a Stats field, the value and its Roll stay the row's. Rejected: the value in the panel.
6. **Death saves stay in Hit points**, beside the 0 HP that brings them. Rejected: a section of their own. The turn-start card stays a prompt, not their home.
7. **Effects, durations and concentration stay in Conditions**, its one home. Readied is listed there with its duration, and Ready's controls are Reaction's. Rejected: a Concentration section.
8. **One control for the legendary counts used**: the pips, in Uses on the panel and the row. Rejected: Stats' steppers beside the row's pips.
9. **The row's options lead with the creature's things in Combat's order.** Rejected: today's order. Rejected: a label between the parts, a line more on a phone.
10. **Map gestures and links to other panels are exempt.** A drag never starts in the panel, the top bar holds Undo, and the Dice panel is a tab away. Rejected: copies in the panel.
11. **The panel gains Duplicate, Dismiss and Attach.** Rejected: leaving them in the bar, against the rule.
12. **"Light" and "Row hidden from players".** Rejected: "Light it carries" on the bar's shared line. Rejected: one name for two switches.
13. **Skipped prompts in the list.** Rejected: on the card alone, where a local Dismiss leaves no way back until Next.

## 7. UI checklist

- **Loading**: Uses keeps the list's own: counts at once, rows that need the block under the shared Loading ("Loading the uses…", after 200 ms), the inline reload on failure, and each button busy until the server answers. Reaction used is busy for a player until answered. Duplicate and Dismiss as the bar's.
- **Keys and focus**: no new keys. Edit, Update and Add hand ResourceSheet their button for focus to return to. Escape in a pool's amount field closes only the field, never the sheet. Dismiss's second tap is a new name on the same focused button.
- **Screen readers**: headings "Uses" and "Reaction" (h4) in Combat. The list is named "{name}'s uses". An off button keeps its focus and reads why. The pips keep the row's names.
- **Large sizes**: every new section was drawn at 130% (section 5). Edit shares the resource's button line: by an estimate Use…, Restore… and Edit take about 196 of 214 layout px at 320 x 568 at 130%, so the builder measures it. Rings' orphan field (section 2) is fixed or allowed as it moves.
- **The exact words**: "Uses", "Reaction", "Reaction used" with the three help lines of 3.2, "Add a class resource", "Legendary Actions used", "Legendary Resistances used today", "Legendary Actions per round", "Legendary Resistance per day", "Light", "Row hidden from players", "Duplicate", "Dismiss", "Dismiss {name}?", Position's "rings 30 ft".

## 8. Cases

| Case | Expected | Test |
|---|---|---|
| The DM on the dragon, off its turn | Combat: Hit points, Conditions, Uses with Fiery Rays live and the pips, Reaction, Rest. Rings under Position | tokenpanel |
| Fiery Rays from the panel | A pip spent, the row's LA chip and the bar's drawer show it | combatuses |
| Pat on Thorn | Uses: Rage 2 of 3 with Use, Restore and Edit, Add. No Class resources heading | classresources |
| Pat adds a resource from the panel's Uses | The sheet opens, Add returns focus to "Add a class resource" | classresources |
| Thorn's level rises | "Your level went up…" with Update in Uses, on the panel and the page | classresources |
| A goblin with no uses, in the fight | No Uses section. Reaction shows | tokenpanel |
| No fight | No Reaction section | panelOrder.test |
| Skitter sharing Thorn's turn | Reaction is its own switch with its help line | tokenpanel |
| Reaction used toggled in the panel | The row's "Reaction used" tag and switch follow | combat |
| Pat on the dragon | HP as allowed and Conditions. No Uses, no Reaction, Position only for its rings | tokenpanel |
| A monster whose block loads | Uses holds the list's loading line, then its rows | combatuses |
| Regeneration skipped, then the turn card dismissed | Reopen in the panel's Uses, the row's group and the drawer, gone after Next | combatuses, logic.test |
| The DM's row options | Uses before Row hidden from players | combat |
| Duplicate from Token settings | A copy beside it, selected, the panel showing it | tokenpanel |
| Pat dismisses Skitter from Remove | Two taps, the token goes | companions |
| Attach from Position on a phone | The attach sheet over the panel's sheet, the link made, Get off then offered | attach |
| Stats for the DM on the dragon | The maxima, no used steppers | tokenpanel |

## 9. Tests

- `panelOrder.test.ts`: Combat's order for the DM, an owner, another player, a character, a companion and an object. Uses only with presence or a character's resources for the DM and its players. Reaction only with a row and full access. Rings in Position, and Position for another's creature only with rings. Every section once.
- `logic.test.ts` (`usesRows`): skipped rows in the list form while the record is current, none after Next.
- e2e, the touched files plus `reach`: `tokenpanel`, `classresources`, `combatuses`, `combat`, `characters`, `companions`, `attach`, `alignment` (the Uses and Reaction sections and Position with rings as roots, at the sweep's sizes).
- **Mutation**: COMBAT in today's order fails panelOrder.test. Skipped rows card-only fails logic.test and combatuses. The old menu order fails combat's order step. Stats' used steppers back fail tokenpanel.

## 10. Lane plan

It builds after the bar stack and the second icon pass land. The bar edits CharacterCard.tsx and the tokenpanel, classresources and combatuses e2e files, and the icon pass edits TokenPanel.tsx, CharacterCard.tsx and Panel.tsx's group headers.

| Lane | Owns | e2e |
|---|---|---|
| **S1, the list and the tracker**, beside the icon pass once the bar lands | combat/CombatUses.tsx (Edit and pips slots), combat/logic.ts (skipped rows), resources/ResourceRows.tsx (Edit on its line), combat/UsesSection.tsx (new, from ClassResourcesSection's parts), encounter/ReactionSection.tsx (new), encounter/Pips.tsx (moved out of Row.tsx), encounter/Row.tsx (order, rename), tokens/StatsSection.tsx (maxima only), their tests | combatuses, classresources, combat |
| **S2, the groups**, in the icon pass's lane right after its Token panel part | tokens/panelOrder.ts, panels/TokenPanel.tsx, tokens/CharacterCard.tsx, vision/TokenSight.tsx, a `useDuplicate` hook out of canvas/TokenActionBar.tsx, resources/ClassResourcesSection.tsx deleted, panelOrder.test.ts | tokenpanel, characters, companions, attach, alignment |

- **S1's first commit** exports `UsesSection({ target, name, character? })` and `ReactionSection({ self, name })`, so S2 starts from it.
- **Why S2 shares the icon lane**: both change the same group headers and summaries in TokenPanel.tsx and CharacterCard.tsx, and the icon pass's summary floor (its 3.3) cuts the new Combat and Position summaries. Built after it, S2 measures them against the floor.
- **Docs**, in S2's last commit: FEATURES.md lines 126 (the groups), 177 (Reaction used), 290 (Uses in the panel and page), 375 (class resources in Uses), and docs/dm-guide.md 473 (Combat and Position), 591 to 592 (the options' order, the renamed switch, Reaction in the panel) and 1079 (class resources in Uses).

## As built

The builder fills this in the lane's docs commit with every place the build went its own way.
