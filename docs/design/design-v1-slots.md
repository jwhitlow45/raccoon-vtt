# raccoon-vtt: Hit Point Dice and spell slots on a character

Decisions D-261127-076 to 105, the coordinator's 260 to 262, round 1's 263 to 279, round 2's 360 to 369, round 3's 400 to 407, round 4's 408 and 409.

## 1. Summary

Today a caster counts spell slots on paper, and a Short Rest asks for HP the player rolled elsewhere (FEATURES "Short Rest and Long Rest", RestSection.tsx:85, design.md:1054 "the rest rolls nothing and counts no dice"). After this change a character has **classes** (class and class level, as D&D Beyond already sends them). From them the app counts spell slots, Pact Magic slots and Hit Point Dice by the SRD 5.2.1 tables. Use spends one slot in one tap, wherever class resources show. The Short Rest card rolls one Hit Point Die plus the current Constitution modifier per tap, on the server's dice, and heals by the result at once. Each rest gives back what the SRD says.

- No spell lists, no prepared spells, no sheet builder (ROADMAP "does not plan to do"). Monsters' Spellcasting stays as it is.
- One format step: OP_VERSION 68 and SNAPSHOT_VERSION 51, both identity steps, with one replay predicate, `usesStamped` (section 6).
- Three lanes: A rules and server (L), B client (M), C D&D Beyond (S). Section 12.

## 2. The rules (SRD 5.2.1)

- **Spellcasting, each class's "Spell Slots"**: the class's Features table "shows how many spell slots you have to cast your level 1+ spells. You regain all expended slots when you finish a Long Rest." Full casters (Bard, Cleric, Druid, Sorcerer, Wizard) use the full table. Paladin and Ranger have Spellcasting from level 1 in the 2024 rules: 2 level 1 slots at level 1, 4/3/3/3/2 at level 20.
- **Warlock, "Pact Magic"**: the slots are all of one level (1 at level 1, 2 from 2, 3 from 11, 4 from 17, slot level 1 rising to 5 at level 9), and "You regain all expended Pact Magic spell slots when you finish a Short or Long Rest."
- **Multiclassing, "Spell Slots"**: add "all your levels in the Bard, Cleric, Druid, Sorcerer, and Wizard classes", "half your levels (round up) in the Paladin and Ranger classes", then read the Multiclass Spellcaster table (the full table). With Spellcasting from one class only, that class's own table applies. Pact Magic slots stay apart.
- **One-third casters, not SRD 5.2.1** (D-261127-260, 274). SRD 5.2.1 lists full and half casters only (its subclasses are the Champion and the Thief). The app counts a Fighter or Rogue whose subclass casts from the one-third caster tables of the 2024 Player's Handbook (Eldritch Knight, Arcane Trickster): 2 slots at level 3, up to 4/3/3/1 at 19, and in a multiclass a third of those levels, rounded down, joins the sum above. It names no subclass in the UI, and the design, FEATURES and the tick's help say the numbers are not SRD. They count only from class level 3, where that Spellcasting starts.
- **Hit Point Dice**: Barbarian d12, Fighter, Paladin and Ranger d10, Bard, Cleric, Druid, Monk, Rogue and Warlock d8, Sorcerer and Wizard d6, one per class level. Multiclassing: dice of one type pool, and "If your classes give you Hit Point Dice of different types, track each type separately."
- **Rules Glossary, "Short Rest"**: "For each Hit Point Die you spend in this way, roll the die and add your Constitution modifier to it. You regain HP equal to the total (minimum of 1 HP). You can decide to spend an additional Hit Point Die after each roll."
- **Rules Glossary, "Long Rest"**: "You regain all lost Hit Points and all spent Hit Point Dice." The 2014 half rule is gone (D-261127-082).
- **Wild Shape** keeps the druid's Hit Point Dice but takes the beast's Constitution (SRD 5.2.1 p. 43), so a die rolls the shape's modifier (D-261127-263).
- Lane A types every table row from the SRD text. The round 1 reviewer checked the full, half, Warlock, multiclass and Hit Point Dice tables against SRD 5.2.1 (pp. 25, 53, 70).

**Comparable VTTs, ideas only.** D&D Beyond draws a row of tick boxes per slot level and a Short Rest dialog with a die button per class that adds CON. Foundry's 2024 sheet keeps slot value and most per level and a rest dialog with one "Roll Hit Die" per die size. Taken: counts by level, one button per die size that rolls and heals. Left: Foundry's typed slot maxima (D-261127-076).

## 3. What the DM and players see

### 3.1 Classes

- Uses (Combat group of the character's page and its tokens' panels) ends with a **Classes** line for the DM and the character's players: "Classes: Wizard 5, Cleric 1" and its pencil, Edit classes. With none: the help "Add your classes to count spell slots and Hit Point Dice." and **Add your classes**. It stands just above Add a class resource, so both edit controls sit at the foot.
- **The Classes sheet** (a bottom sheet on a phone held upright, the dialog form elsewhere, as Add a class resource). One row per class: Class (the 12 SRD classes, those already picked left out, then **Other class**), Level (the stepper with the Size stepper's icons), Remove (trash, "Remove Wizard"). Other class adds a **Hit Point Die** choice (d6, d8, d10, d12) and counts toward the level and the dice, never slots (D-261127-261, 267). Fighter and Rogue add the checkbox **Its subclass casts spells**, off and unavailable below level 3, help "From level 3. Its slots follow the one-third caster table, which is not in SRD 5.2.1." **Add a class** adds a row.
- Under the rows a preview: "Spell slots: 4, 3, 2. Pact Magic: 2 at level 3. Hit Point Dice: 5 d10 and 1 d8." (each part only when there is one) and "Level 6 in all." with "Saving sets the character's level to 6." when it differs. Past 20: "The classes add up to 23. A character's level is at most 20." and Save is off. Save and Cancel, "Discard changes?" on Back or Cancel once something changed.
- **A Save that lowers the level** shows "Saving lowers Bree's level from 8 to 3, and with it the Proficiency Bonus." and turns Save into **Lower to level 3 and save**, which a second tap sends (D-261127-267).
- **Saving no classes** (the last row removed) removes the classes and every spent slot and die, and keeps the level as it is (D-261127-265).
- **It starts from** the character's classes, else from its class resource presets (each preset's class at the highest class level read), else empty (D-261127-087). Add a class resource then starts its class picker at the first SRD class in the list and its level.
- **Level.** Save sends the classes and their sum as the level in one `character.update` (D-261127-086). A level that later differs (raised in Stats, a re-sync) shows one line at the head of Uses: "Your classes add up to level 5, and your level is 6." with Edit classes.
- **Class resource updates read the class's own level** once there are classes (D-261127-268): `levelUps` compares each preset's `level` with that class's level in `classes`, and asks "Your Barbarian level is now 6. Update Barbarian resources?" prefilled with that level, not a guess. A preset whose class is not in `classes` asks nothing (D-261127-368). The total-level rule stays for a character with no classes. So Barbarian 5 and Fighter 1 saved at level 6 asks nothing of Rage.

### 3.2 Spell slots

- Rows in **CombatUses**, after the class resources, so they show wherever those do: Uses in the panel and the page, the action bar's Uses drawer (the strip's Uses on a phone held upright, the token window on a phone on its side or a screen 600 px wide), the tracker row's Uses group, and the turn card (D-261127-078). A character with slots and nothing else gets Uses in its bar and row (`usesPresence`) and a turn card (D-261127-266, section 9).
- **In the panel, the page and the tracker row, each slot level is a class resource row** (ResourceRows.tsx:83's shape, D-261127-273): its name "Level 3 spell slots" with pips at the line's right end (at most 4, always pips, D-261127-104), the muted line "Back on a Long Rest" under it, then Use and Restore on a line of their own. Only levels the character has. **Pact Magic, level 3** follows as one more such row, "Back on a Short or Long Rest".
- **On the turn card, and in the bar's Uses drawer on a phone held upright, the slots fold to one row** (D-261127-360): a resource-shaped "Spell slots" row whose muted line reads "Left by level: 4, 3, 3, 3, 2, 1, 1, 1, 1", with **Use a slot…**, which opens one 44 px button per level under the row ("Level 3, 2 left", off with "No level 3 spell slots left."), wrapping, as a pool's Use… opens its field (ResourceRows.tsx:195-230). Escape or a second tap closes it. The drawer adds **Restore a slot…** ("Level 3, 1 spent", off with "Every level 3 spell slot is there."). Pact Magic keeps its own one-button row. About 104 px closed, 200 open. The token window and wider screens keep full rows. The turn card counts the slot group as 1 and Pact as 1.
- Use spends one slot. Restore gives one back: Arcane Recovery, Natural Recovery, Font of Magic and Magical Cunning are done this way, by hand, after the player spends the feature in its own row (D-261127-083). Restore never passes the count.
- A refused tap says why in the list's one status line ("No level 3 spell slots left."), as class resources do. The DM sees and spends every character's, for a player who is away.
- **A cast ask** (the Dice panel's Ask for saves block) never spends a slot itself (D-261127-262, 279). The block closes once its ask waits (cast.ts:433 `blockDone`, CastBlock.tsx:121), so the offer lives apart from it (D-261127-362): a sent ask at casting level 3 sets a **slot offer** in the roll options' store (optionState.ts), drawn under the spell's row in the Dice panel as "Cast at level 3." with one button per pool that can cast it (D-261127-363, 400): **Use a level 3 spell slot** where the character has slots at exactly the casting level, and **Use a Pact Magic slot (cast at level 3)** only where the Pact level equals the sent ask's casting level, since a Pact slot always casts at its level (SRD 5.2.1 p. 70) and the ask's damage was already scaled to the level sent (D-261127-408). A multiclass caster who means to spend Pact picks the Pact level with the stepper before sending. Each is off with its "left" reason, beside Dismiss. An area spell with no row of its own (the standalone block, RollOptions.tsx:597) gets the same offer in a fallback line under the creature's options, at the top of the Dice panel (D-261127-403). Either stays through the waiting line, the DM's acceptance and an immediate resolution, until a Use, Dismiss, another ask from that spell, or leaving the room. No pool, no offer. Where Pact Magic is the only pool that covers the spell, the casting level starts at the Pact level, in the block (cast.ts:115 `blockLevel`) and a row's stepper (RollOptions.tsx:1104) (D-261127-401). The Dice panel's spell rolls offer nothing (D-261127-093).

### 3.3 Hit Point Dice

- In **Rest** (Combat group, page and token panel), never in Uses (D-261127-079). With classes, a muted line under the rest choice: "Hit Point Dice: 3 of 5 d10" ("3 of 5 d10, 1 of 1 d8").
- **The Short Rest card** with classes: the note "Spend Hit Point Dice one at a time. Each one heals at once.", the line of what the rest restores, then one row per die size, largest first: "d10 Hit Point Dice", pips up to 6 and "15 of 20" past that, with **Roll d10 + 2**, **Type a roll…** and **Restore**. Then Finish the Short Rest and Cancel, as today.
- **Roll** sends one server roll. The result shows in the row as a fight card's roll does (useCardRoll, CardRoll.tsx): busy, the dice landing 1 s after the answer, then "Rolled 7 + 2: 9 HP back." ("Rolled 1 - 2: 1 HP back, at least 1."). The HP changes with the answer. The next tap rolls the next die (D-261127-080).
- **Type a roll…** opens a 16 px numeric field under the row, "HP from one d10, your roll plus Constitution", with Spend and Cancel, as a pool's Use… does. Spend spends one die and heals by the number (D-261127-081). Real dice stay first class, as FEATURES' opening promises.
- **Constitution** is the modifier the Dice panel rolls with now (`useCharacterRollNumbers`, which reads `creatureNumbers`): the stat block's, in Wild Shape the beast's mixed in (pcStats.ts:100), in another shape or Wild Shape with no block the creature's own (D-261127-263). Only with no block and no shape does a "Constitution modifier" field (-5 to 10) stand above the rows, which this device remembers for the character (D-261127-091). A shaped character never gets the field. While the numbers load, Roll is busy. If they fail to load, Roll is off and the row shows the shared load-failure line with its reload (`SrdLoadFailed`, as CombatUses does) (D-261127-365).
- Roll and Spend are off at full HP ("Thorn's HP is full.") or with none left ("No d10 Hit Point Dice left."), each keeping its focus and reason as Use does. Below 1 HP the whole Rest section is off today ("A rest needs at least 1 Hit Point."), and stays so.
- **Cancel** after a roll keeps the HP and the spent dice: they happened. Finish restores what the rest restores, with no `heal`.
- **Without classes** the card is today's: the typed "HP regained" field, its note ending "or add your classes in Uses to count and roll them here."
- A running fight keeps today's note once a rest is chosen, and the rows still work (D-261127-100).

### 3.4 Rests and their words

- Short Rest: Pact Magic slots all back, Hit Point Dice none. Long Rest: every slot, every Pact Magic slot, every Hit Point Die. The party's Long Rest does the same for each character (D-261127-102).
- `restBackText` names what is spent: "A Long Rest also restores Rage, 3 spell slots and 2 Hit Point Dice." and "A Short Rest also restores 2 Pact Magic slots and one Rage." ("1 spell slot", "1 Hit Point Die").
- The Long Rest note names only what the character has: "All HP back, every spent Hit Point Die back, every spell slot back, Temporary HP gone, one less Exhaustion level, and Legendary Resistance reset.", with the slot part only for a character with slots or Pact Magic. Without classes it keeps today's words.
- The party card: "It also restores every class resource, spell slot and Hit Point Die." while any of the party has one spent.
- A D&D Beyond fill or a new class starts with every slot and die there (FEATURES says so, D-261127-094).

### 3.5 Devices

- **Phone held upright** (390 x 844, 320 x 568, 100% and 130%): each full slot row is about 92 px plus a 12 px gap (ResourceRows.tsx:151-161), so a level 17 wizard's 9 rows take about 930 to 1,030 px in the panel, where Combat folds. The turn card and the drawer use the folded row, since the alerts column holds about 650 px (InitiativeStrip.tsx:1177-1188).
- **Phone on its side, tablet, computer**: the same rows in the token window, the side sheet or the side panel. The Classes sheet is the dialog form.

## 4. UI entry points (for DFEAT's modules)

DFEAT may hide each module on a device. Hiding is UI only and changes nothing here.

| Module | Surface | File |
| --- | --- | --- |
| Spell slots | Slot and Pact rows in every CombatUses form, full and folded | client/features/slots/SlotRows.tsx, mounted in combat/CombatUses.tsx |
| Spell slots | Uses showing, and the turn card admitted, for slots alone | combat/logic.ts `usesPresence`, `usesCount`, combat/alerts.ts |
| Spell slots | The slot offer under a cast spell's row, or its fallback line | client/features/slots/SlotOffer.tsx, dice/optionState.ts, dice/cast/cast.ts, dice/RollOptions.tsx |
| Spell slots | Slot words in rest lines and the party card | resources/logic.ts `restBackText`, `partyRestBackText` |
| Hit Dice | The count line under the rest choice | client/features/slots/HitDiceRows.tsx `HitDiceCount`, mounted in tokens/RestSection.tsx |
| Hit Dice | Dice words in rest lines and the Long Rest note | resources/logic.ts, RestSection.tsx |
| Both | Classes line, level line, Classes sheet | client/features/slots/ClassesSheet.tsx, combat/UsesSection.tsx |
| Both | Search results "Spell slots", "Hit Point Dice", "Classes" | tokens/search.ts |
| Never hidden | Slot and Hit Point Die lines in the Log and Recent rolls (section 7): Log and Dice are core | shared/logText.ts, dice/RecentRolls.tsx |
| Never hidden | The Short Rest card's die rows, Roll, Type a roll…, Restore and the CON field: they belong to Rests (D-261127-300) | HitDiceRows.tsx `HitDiceRows` |
| Never hidden | The D&D Beyond review line "Classes" and its Overwrite choices, during import and re-sync | pcstats/fill.ts, SyncReview.tsx |

No keys, toasts or notices of their own. The Hit Dice module hides only the count line and the dice words outside the Short Rest card. The Classes line hides only when both modules are hidden.

## 5. Model

```ts
// shared/model.ts, on Character, beside resources
classes?: ClassLevel[]   // at most 12 entries, each SRD class once, levels 1 to 20, sum at most 20, absent is none
spent?: Spent            // written by use, roll and rest ops and a re-sync Undo, absent while nothing is spent
useRev?: number          // from op 68 every rest and use on the character adds 1, absent before the first
type ClassLevel = { id: ClassId, level: number, third?: true } | { id: "other", level: number, die: 6 | 8 | 10 | 12 }
type Spent = { slots?: number[], pact?: number, dice?: { d12?: number, d10?: number, d8?: number, d6?: number } }
```

- **Counts are derived, never stored** (D-261127-076, 097). New shared/rules/spellSlots.ts holds the four tables and `slotsOf(classes)` (nine counts and the Pact row or null), `diceOf(classes)`, `dieOf(entry)`, `spentWithin(spent, classes)` and `normalSpent`. `third` counts only from level 3, and a ticked Fighter or Rogue below 3 is no Spellcasting class for the one-class rule. An Other class counts toward dice and level only. A scratch prototype checked the tables and rule cases (paladin 1 alone has 2 slots, paladin 3 and wizard 1 read caster level 3, a third caster at 4 alone has 3 slots and with wizard 1 reads level 2).
- **Normal form** (D-261127-276): `slots` exactly 9 counts, present while one is above 0, `pact` and each die key only above 0, die keys in d12, d10, d8, d6 order, `spent` absent when empty, every count within its derived most. The reducer writes only that form, and server/rooms/stateSchema.ts refuses any other in an import (a superRefine against `classes`).
- **Why derived**: the server stays the authority, D&D Beyond and the sheet never disagree with the count, and a typed count would need an edit path and a merge part. A table fix later is a rules change like any other and takes an op gate.
- **A classes change** clamps `spent` to the new counts in the same write, and an empty list removes classes and spent.
- **Rests**: `restedSpent(spent, kind)` in shared/rules/rest.ts beside `restedResources`: a Long Rest drops `spent`, a Short Rest drops `pact`.
- **The use stamp** (D-261127-361): from op 68, `actorRest`, every `actor.use` whose target resolves to a character and `hitDieRoll` add 1 to that character's `useRev`. A rest always moves it, even one that leaves every count as it was. A use moves it only when it changes something, so a give-back with nothing to give, or `ifReady` on a used ability, leaves it (uses.ts:75-80, D-261127-404). It is a whole number from 0 like `rev` (stateSchema.ts:81). Owners get it, non-owners never (the allowlist). It exists only for the re-sync guards (section 6).
- **Caps** (D-261127-099): at most 12 entries, each SRD class once, Other classes as many as fit. Slot counts at most 4, Pact at most 4, each die at most 20.

## 6. Ops, permissions, versions

| Op | Who | Notes |
| --- | --- | --- |
| `character.update { patch: { classes, spent? } }` | DM and owners | `classes` joins OWNER_CHARACTER_FIELDS. An empty list removes classes and spent. The reducer clamps `spent`. `spent` is accepted only beside `classes`, `ddbSync` and `expect.classes` in one patch, as a re-sync Undo sends it, else refused (D-261127-264, 367) |
| `actor.use { use: { kind: "slot", level: 1..9 } }` | DM and the character's owners | Spends one, `back` restores one. "No level 3 spell slots left.", "Bree has no level 3 spell slots." |
| `actor.use { use: { kind: "pact" } }` | as slot | "No Pact Magic slots left." |
| `actor.use { use: { kind: "hitDie", die, heal? } }` | as slot | Spend needs `heal` 1 to 100,000 (a typed roll) and heals by it. `back` restores one and takes no `heal`. Needs alive and 1 HP, and HP below its most: "Thorn's HP is full." |
| `actor.hitDieRoll { tag, target, die, con? }` | as slot | A dice op, resolved into `sys.dice` (dice/resolve.ts) as `actor.deathRoll` is. CON from `creatureNumbers` with the server's SRD numbers. `con` -5 to 10 only where those give none (no block, no shape), else "The character's numbers give the Constitution modifier." Every refusal comes before the draw |

- **The lent-token rule** (permissions.ts:1262) widens from `resource` to every kind here and to `actor.hitDieRoll`: a player lent only a character's token gets `NOT_YOURS` (D-261127-090). `GONE` for a target the sender cannot see. No classes: "Add the character's classes first."
- **Reducer**: shared/reducer/uses.ts (`slotUse`, `pactUse`, `hitDieUse`), shared/reducer/dice.ts (`hitDieRoll`: spends a die, heals `max(1, total)` up to the most, writes the HP line with its `revert` as a death save's natural 20 does, and the dice line), shared/reducer/actors.ts `actorRest` (`restedSpent` beside the resources), shared/reducer/tokens.ts (`classes` by setOrDelete, the clamp, a re-sync Undo's `spent`).
- **Undo** (D-261127-272): `actor.use` is a play step (undoScope.ts:51), so the DM's slot and die uses go on the toolbar Undo ("using a level 3 spell slot for Bree", "giving back a d10 Hit Point Die for Thorn"). A classes change is a Setup history step ("changing Bree's classes"). Both restores are value-hash guarded. `actor.use` stays off the player stack, so a player corrects with Restore. `actor.hitDieRoll` is `none` (undoScope.ts:162), and the DM takes its heal back from its HP line. undoCorrection.ts:44-49 gains `classes` and `spent` for owners beside `resources`.
- **Re-sync Undo** (D-261127-264): `undoSync` (pcSync.ts:1219) sends the classes from before with the exact `spent` from before in the same guarded `character.update`, its `expect.classes` hashing classes, spent and `useRev` together, as resources' counts and HP come back today. Any rest or use since the re-sync, on any device, moved `useRev`, so the Undo is refused as stale and goes off with today's words, even where the counts match (D-261127-361). So Wizard 5 cut to 4 with every spent slot clamped away, then a Long Rest, never gets the old spent slots back. `expect.classes` is the one part that hashes `useRev`: the resources part keeps today's hash (permissions.ts:481-483), which leaves today's Apply as it is, since `expectFits` checks only at admission (permissions.ts:500-507). `undoSync` sends `expect.classes` with every Undo, a resources-only one included, which guards the class resource list's Undo too, where a removed resource came back with its old count (D-261127-405). A re-sync's Apply sends it too whenever it writes classes or resources, so a rest or use on any device during the review refuses Apply with today's words, and the review reads again (D-261127-406).
- **OP_VERSION 68**, the identity step 67 to 68. `actor.hitDieRoll`, the three `use` kinds, `patch.classes` and `patch.spent`, the `use` line kinds, `DiceRoll.hitDie`, `useRev` and the new `sys.dice` asked shape are new, which an older build's strict schema refuses, so no stored op changes shape. One predicate, `usesStamped(opVersion)` (`USE_STAMP_OP_VERSION = 68`): only from 68 do rests and uses move `useRev`, since a stored rest or use replayed with the stamp would change the character and fail a later stored restore's hash guard. Comment in the house form, with "Deploy: back up the database just before, and reload DM pages first, then every other open page."
- **SNAPSHOT_VERSION 51**, the identity step 50 to 51, as known forms took 14 to 15: `classes`, `spent` and `useRev` are optional, absent as before. The number moves so an older build refuses a v51 snapshot instead of failing on the character.
- **Rollback** (D-261127-271): no first-commit snapshot is forced (actor.ts:992 forces one only below 49), and none is needed, since only a version 68 op writes the fields. A room's snapshot turns v51 at its next periodic snapshot, or at a clean stop where the room changed or replayed ops since its last snapshot (`#writeNow` returns early otherwise, actor.ts:4574). So going back needs the backup taken just before the update for any room this build wrote a snapshot of, and for any room with version 68 rows after its last snapshot (D-261127-364). A room only opened and left untouched needs nothing.
- **Ops at 67 and below replay unchanged.** None carries a new kind or field. A stored `actor.rest` or `character.update` meets a character with none of the three fields, since only a version 68 op writes them and a build at 67 refuses a v51 snapshot, so `restedSpent` and the clamp change nothing, and `usesStamped` keeps their rests and uses from moving `useRev`. The stored replay fixtures (floors4.replay, floorLinks.replay and the op-gate replay tests) keep their hashes.
- **Every per-op table** gains the new op, which the typecheck enforces: farLine.ts:25 `FAR_TREATMENT`, undoScope.ts, protocol.ts:4234 `ID_RULES` and :4456 `NEW_ID_PATHS`, server/rooms/playerOpsTesting.ts.
- **Import and export**: stateSchema.ts adds `classes`, `spent` in normal form and `useRev` (D-261127-402). remap.ts and reid.ts change nothing: class ids are constants, not room ids. An export from before has neither.
- docs/self-hosting.md gains the rule 15 bullet under **Since v0.5.0**: change format 68, room format 51, back up first, reload pages, and the rollback above.

## 7. Privacy

FEATURES: "Other players see only the name, conditions and whatever HP the DM allows." A player's classes, slots and dice are theirs and the DM's (D-261127-088).

- **State.** `projectCharacter` (project.ts:1633) gives a non-owner an allowlist: id, rev, name, size, the public actor and the image. None of `classes`, `spent` and `useRev` is in it, so the character projection does not change. Owners get all three whole. The table display is a non-owner. The re-sync record's `classes` base sits in `ddbSync`, which non-owners never get.
- **Log lines.** Every slot, Pact and typed Hit Die line is a `use` line with `hidden`, which reaches the DM and owners only (project.ts:4256-4264), with its counts: "Bree used a level 3 spell slot (2 of 3 left).", "Bree used a Pact Magic slot (1 of 2 left).", "Bree: a level 3 spell slot is back (3 of 3).", "Thorn spent a d10 Hit Point Die (2 of 5 left)."
- **The roll** (D-261127-269). Its one roll carries a mark of its own, `hitDie: 10`, and the character's id, never the token's. `diceRollReach` (project.ts:3920) gives a roll with `hitDie` the character's players only (`creaturePlayers`), co-owners included, a lent-token player not. It is not `DiceRoll.hidden`, which only an initiative roll may carry (dice/logic.ts:231, logText.ts:301-303, RecentRolls.tsx:215-219). The line reads "Kim rolled for Bree, Hit Point Die (d10): 1d10+2 (7) = 9." and has no Again, since a free roll would spend nothing. A public line would tell the heal's size to a player who may read only Healthy or Bloodied.
- **The heal** is an ordinary `hp` heal line, by `creatureReach` and the exact parts every heal has. Its order beside the dice line needs no rule (D-261127-270): `Tx.settleLog` numbers each audience's lines on its own (tx.ts:345-422), so another player's ids match a plain heal whatever the order.
- **Accepted** (D-261127-277): each die writes one heal line that other players read by HP access, so they can count the dice spent, never how many are left.
- **Refusals.** A non-owner's or lent player's op is refused at permissions, before any count is read.
- **Room size** (D-261127-369). An owner's ops write only what their copy holds. But a player lent only the token may rest the character (permissions.ts:1251), which writes `spent` and `useRev` beyond their copy, and may use its token's abilities, which writes `actor.uses` and `useRev`. So server/rooms/sizeGuard.ts's `character` list (OWN_WRITTEN, sizeGuard.ts:2365-2377) gains `fixed("", "spent", SPENT_MOST)` (81 bytes) and `fixed("", "useRev", DIGITS.rev)`, "whoever rests the character", as `longRest` is (D-261127-407, 409). That keeps a lent character inside `EXACT_WIDTH.character` (5 KiB, limits.ts:1484) by about 140 bytes, which the builder confirms in limits.bounds.test.ts. sizeGuard.exact.test.ts proves it with a lent player's rest of a character with slots spent and no class resources. Main's own gap, a lent rest shrinking hidden resources' counts (actors.ts:88), is a separate follow-up, LENT-REST-RESOURCES, not this design.
- **Twin tests** (server/rooms/slots.privacy.itest.ts, Pat a non-owner, Bree's player Kim):
  1. Pat's snapshot and every frame are the same whether Bree has classes, slots spent and a moved `useRev`, or none.
  2. Kim spends and restores a level 3 slot and a Pact slot: Pat gets no frame, against a twin where Kim does nothing.
  3. Kim's Hit Die roll that heals Bree 9, and her typed one, against the DM's heal of 9: Pat's frames match whole, line ids included, with "Players see the party's HP" on and off.
  4. A player lent Bree's token gets no classes, counts or lines, and the same `NOT_YOURS` whether Bree has 0 or 4 level 1 slots left.
  5. The table display's frames hold none of the three fields, and Pat's archive pages hold none of Bree's slot or die lines.
  6. Bree's co-owner gets the counts and the roll.
- The mutation that must fail twins 3 and 6 removes `hitDie` from `diceRollReach` or widens its reach, and twin 4 dropping the lent-token check (D-261127-270).

## 8. D&D Beyond

- shared/ddb/read.ts `classesOf` already reads each class's name, level and spellcasting ability. The fill gains `classes` (shared/rules/pcFill.ts `PcFill.classes`), read only when the classes were sent and read whole: each name matched to an SRD class id, case blind, `third` on a Fighter or Rogue whose spellcasting ability comes from its subclass.
- **A class that is not SRD** becomes an Other class row, its die from `definition.hitDice` (D-261127-261). The review names it, "Artificer 3 (Other class, d8)", and warns "Artificer is not an SRD 5.2.1 class, so it counts toward your level and Hit Point Dice here, never spell slots." (D-261127-366). One whose die is not 6, 8, 10 or 12 is left out with "Blood Hunter's Hit Point Die could not be read, so its levels count toward no Hit Point Dice here." (read.ts levels stay as today).
- **Left out whole** (D-261127-275): a class of level 0 is dropped (read.ts:261 keeps 0 today). When the levels pass 20, no classes are read, with "The classes' levels add up to 23, past 20, so the classes were not read. They stay as they are.", and the level reads 20 as today (read.ts:554-558).
- The review lists "Classes: Fighter 3 (its subclass casts spells), Wizard 2, now none" ticked (client/features/pcstats/fill.ts). Re-sync (shared/rules/pcSync.ts) treats `classes` as one field, as it treats `level`: `DdbBase.classes` records what D&D Beyond said, a change made here is kept with Overwrite, and its Undo is section 6's. The `ddbSync` record grows at most about 0.5 KB, within `ddbSyncBytes` (6 KB).
- Spent counts are not read (`spellSlots`, `pactMagic`, `hitDiceUsed`): the table spends here, so a fill starts full (D-261127-094).

## 9. Files

- **Shared**: model.ts (types, `use` line `what` gains `slot`, `pact`, `hitDie` with `level?` and `die?`, `DiceRoll.hitDie`, `DdbBase.classes`), protocol.ts (with ID_RULES and NEW_ID_PATHS), migrate.ts, farLine.ts, undoScope.ts, rules/spellSlots.ts (new), rules/classResources.ts (`levelUps`), rules/rest.ts, rules/pcFill.ts, rules/pcSync.ts, ddb/read.ts, reducer/uses.ts, dice.ts, actors.ts, tokens.ts, dice/resolve.ts, permissions.ts, project.ts (`diceRollReach`), logText.ts, testutil.ts, undoCorrection.ts.
- **Server**: rooms/stateSchema.ts, undoLabels.ts, playerOpsTesting.ts, sizeGuard.ts. server/rooms/dice.ts passes the new dice op through `isDiceOp` with no change of its own.
- **Client**: features/slots/ (new: SlotRows.tsx with the full and folded forms, HitDiceRows.tsx, ClassesSheet.tsx, SlotOffer.tsx, logic.ts), combat/CombatUses.tsx (the empty guard at :115 counts slots, and a `folded` flag), combat/TurnCard.tsx and canvas/TokenActionBar.tsx (pass `folded`, the bar only as the strip on a phone held upright), combat/logic.ts (`usesPresence`, `usesCount` counting the slot group as 1 and Pact as 1), combat/alerts.ts (passes them to `usesCount`), dice/optionState.ts and dice/cast/cast.ts (the slot offer, set on a sent ask, and `blockLevel`'s Pact start), dice/RollOptions.tsx (the fallback line and the row stepper's start), combat/UsesSection.tsx, tokens/RestSection.tsx (gains `character`, passed by CharacterCard.tsx and TokenPanel.tsx), resources/ResourceRows.tsx (its row exported for slots), resources/logic.ts, resources/ResourceSheet.tsx, dice/logic.ts (`againInput` none for a Hit Die), dice/RecentRolls.tsx, dice/cast/CastBlock.tsx, tokens/search.ts, pcstats/fill.ts and SyncReview.tsx.
- **Docs and credits**: FEATURES.md (Uses presence at 143 and 1261, three bullets after Class resources at 1553 with the one-third tables marked not SRD and their source, the rests at 1561, D&D Beyond reads at 1505), docs/dm-guide.md 2158 ("Spell slots are tracked on the players' own sheets" goes), design.md:1054 and design-v1-pc-stats.md:396 point here, FEATURES' Dice panel part says a pure Warlock's spell rolls start at the Pact level, docs/self-hosting.md, CREDITS.md:1077 and shared/credits.ts's SRD entry gain "the spell slot and Hit Point Dice tables", never the one-third tables (D-261127-274).

## 10. Performance and sizes

- Per character: `classes` at most 12 entries of about 42 bytes, about 30 for one class in practice. `spent` at most 81 bytes. So 50 characters add at most about 30 KB to a room's 8 MiB, and a typical HP frame, which sends the character whole, grows by about 100 bytes.
- Hidden lines go to owners' party copies, bounded by `partyLinesPerRoom`, and a busy caster's lines push out only that player's own old copies (logRings.ts).
- A mid-range phone draws at most 10 slot rows and 4 die rows, which read the character's fields through `useRoomView` and redraw only when they change. `slotsOf` is a table lookup, memoized on the classes array.

## 11. Keys, touch, accessibility

- **No new key or gesture** (D-261127-105), so the shortcut sheet registry and FEATURES' Shortcuts stay. Every button is in Tab order. Escape closes the typed field (the row only) and the sheet, as today.
- **Names**: "Use a level 3 spell slot, 2 of 3 left", "Restore a level 3 spell slot", "Use a Pact Magic slot, 1 of 2 left", "Roll a d10 Hit Point Die plus 2, 3 of 5 left", "Restore a d10 Hit Point Die". An off button keeps focus and reads why through `aria-describedby` ("Every level 3 spell slot is there."). Slot rows are a list named "Bree's spell slots". Use a slot… is `aria-expanded`, and its level buttons read "Use a level 3 spell slot, 2 left". A roll's result is said once at the answer through the row's status line.
- **Touch**: 44 px buttons and rows, 16 px numeric fields, nothing on hover or long press. **Reduced motion** draws the dice landed. Low power, the Roll animation switch off or no WebGL show the total at once. **Contrast**: CountPips and theme tokens, checked by the existing contrast tests.

### UI checklist

- Loading: Use, Restore, the folded row's level buttons, Roll, Spend and the slot offer's buttons busy until the answer and deaf to a second tap (useAnyPending). Save busy. Roll busy while the shape's numbers load. A roll that never lands reads "This may have happened. Check the log." (rollTrouble).
- Focus: a Use that empties its row keeps focus with its reason. Removing a class row hands focus to the next row's Class, else Add a class. The sheet gives focus back to Edit classes or Add your classes. The second-tap Save keeps focus.
- Sizes: every new screen in the alignment sweep (section 13) at 1440 x 900, 390 x 844 and 320 x 568, 100% and 130%, at most 1 px off.
- Words: sections 3, 6, 7 and 8, verbatim. One phrasing for full HP, "Thorn's HP is full.", on the button and in the refusal.

## 12. Lane plan

**Contracts first** (lane A's first commit): model.ts, protocol.ts, migrate.ts (68 and 51), rules/spellSlots.ts with the tables and pure functions, and a client stub `client/features/slots/SlotRows.tsx` exporting `SlotRows({ characterId, form, label })` and `slotRowCount(character)`. B and C start from it.

| Lane | Size | Owns | e2e it runs |
| --- | --- | --- | --- |
| **A. Rules and server** | L | The contracts, farLine.ts, undoScope.ts, rules/classResources.ts, rules/rest.ts, reducer/uses.ts, dice.ts, actors.ts, tokens.ts, dice/resolve.ts, permissions.ts, project.ts, logText.ts, testutil.ts, undoCorrection.ts, server/rooms/stateSchema.ts, undoLabels.ts, playerOpsTesting.ts, sizeGuard.ts, their tests, slots.privacy.itest.ts, sizeGuard.exact.test.ts additions | none |
| **B. Client** | M | client/features/slots/ (the stub filled), combat/CombatUses.tsx, TurnCard.tsx, logic.ts, alerts.ts, UsesSection.tsx, canvas/TokenActionBar.tsx, tokens/RestSection.tsx, CharacterCard.tsx, panels/TokenPanel.tsx, resources/ResourceRows.tsx, logic.ts, ResourceSheet.tsx, dice/logic.ts, RecentRolls.tsx, RollOptions.tsx, optionState.ts, cast/cast.ts, cast/CastBlock.tsx, tokens/search.ts, e2e/slotsdice.e2e.ts (new), e2e/alignmentRoom.ts, CREDITS.md, shared/credits.ts | slotsdice, classresources, combatuses, tokenpanel, characters, alignment, reach |
| **C. D&D Beyond** | S | shared/ddb/read.ts, rules/pcFill.ts, rules/pcSync.ts, pcstats/fill.ts, SyncReview.tsx, their tests | resync, pcstats, reach |

- Landing order A, C, B. B's last commit holds the docs for all three lanes, so no file has two owners. Step labels `sd-a-`, `sd-b-`, `sd-c-`.
- e2e/slotsdice.e2e.ts takes port offset +72 (free at a6ed9ce2 by a grep of `E2E_PORT +`, the builder checks again).

## 13. Tests

- **Tables** (shared/rules/spellSlots.test.ts): every class at levels 1 to 20 against the rows typed from the text, one row below and at each unlock. Multiclass: paladin 1 alone, paladin 1 with fighter 1, paladin 3 with wizard 1, ranger 5 with druid 5, a third caster at 2, 3 and 4 alone and with a wizard, a ticked fighter 2 with paladin 3 (one caster class), warlock 5 with sorcerer 3 (Pact apart), an Other class d8 with wizard 2. Dice: paladin 5 with fighter 5 pools 10 d10, with cleric 5 keeps 5 d10 and 5 d8.
- **Properties** (fast-check, spellSlots.prop.test.ts): raising any class's level never lowers a count, any split of full caster levels gives the same slots, dice always sum to the class levels, `normalSpent` is idempotent and within the counts.
- **Randomized reducer** (shared/reducer/slots.random.test.ts), 3 seeds of 600 steps: spends, Restores, rolls with a fixed draw and shapes on and off, typed dice, class edits that grow, shrink and empty, both rests, the party rest, re-syncs and their Undo, DM undo of each step and HP take-backs. Invariants: every count between 0 and its most, `spent` in normal form, HP never above its most, a refused op changes nothing, a Long Rest leaves no `spent`, a Short Rest leaves no `pact`, replay rebuilds the same state, and a non-owner's projection never holds `classes`, `spent` or `useRev`.
- **Reducer and permissions**: each kind spent, restored and refused with its words, CON shaped (Brown Bear +2 over a base +0) and unshaped, with and without a block, `con` refused where numbers exist, the lent-token `NOT_YOURS`, `GONE` for a hidden target, refusals before the draw, saving no classes keeps the level and clears `spent`, `spent` refused without any of `classes`, `ddbSync` and `expect.classes`, `useRev` moved by each rest and use from 68 and by none at 67.
- **Re-sync Undo** (pcSync tests): Wizard 5 to 4 with level 3 slots spent, then Undo, gives back Wizard 5 and the spent slots. With a spend, a Restore or a rest between, Undo is refused. Every spent count clamped away, then a Long Rest that changes no count, then Undo: refused, with today's stale words. Removing every class, then Undo, the same. A resources-only re-sync, a rest, then Undo: refused. A rest during the review refuses Apply. A give-back with nothing to give leaves `useRev`.
- **levelUps** (classResources.test.ts): Barbarian 5 and Fighter 1 at level 6 asks nothing, Barbarian 6 asks with 6, a Rage preset with no Barbarian in the classes asks nothing, no classes keeps the total-level guess.
- **Turn card** (client/features/combat/alerts.test.ts, logic.test.ts): a Wizard 3 with no attacks or class resources gets a turn card with the folded slot row, its count 1, a Wizard 5 and Warlock 5 counts 2. Use a slot… opens one button per level and Escape closes it.
- **The slot offer** (cast tests): an ask sent at level 3, then the DM accepts it and resolves at once, and the offer still stands and its Use spends. A Warlock 5 casting a level 1 spell at its default level (now 3) gets the Pact button only. A Wizard 5 and Warlock 5 at level 1 gets the level 1 button only, at level 3 both. A Wizard 9 and Warlock 5 sending Fireball at level 5 gets the level 5 button only, and at level 3 both. An area spell absent from the character's rolls keeps its fallback offer through an immediate resolution. Dismiss, another ask and leaving end it.
- **Numbers** (slots/logic.test.ts): loading keeps Roll busy, failed shows the load-failure line, a shaped character never shows the CON field.
- **Again and the log** (dice/logic.test.ts, logText.test.ts): a Hit Die roll has no Again and is never an initiative roll, and reads its words.
- **Versions**: migrate 67 to 68 and 50 to 51, an older schema refusing both, the replay fixtures unchanged, an import round trip from a room rested at op 68, carrying `classes`, `spent` and `useRev`, an import with `spent` out of normal form refused.
- **Privacy**: the six twins of section 7, and the log rings' audience test with the new lines.
- **D&D Beyond** (read.test.ts): classes read, an Artificer as Other class d8, a level 0 class dropped, levels past 20 leaving classes out, the third flag, classes read in part left out.
- **Client logic** (client/features/slots/logic.test.ts, resources/logic.test.ts): every label, reason and rest line of section 3, the preview, the level and lowering lines, the start from presets.
- **e2e** (`slotsdice.e2e.ts`): Kim on a phone adds Wizard 3 and Cleric 1, uses a level 2 slot from her page, the DM's desk shows it, Restore, then from the bar's drawer and her turn card. Short Rest: two d6 rolls heal by their results, a typed roll, a reload keeps every count, Long Rest gives all back. A sent cast ask's Use spends a slot. Pat's page never shows the rows, and his frames are scanned for `classes`, `spent` and `useRev`. A D&D Beyond fill sets classes (the resync fixture). `classresources.e2e.ts` gains Add starting at the classes' class.
- **Alignment roots** (e2e/alignmentRoom.ts): full slot and Pact rows in the page and panel, the folded row closed and open in the turn card and the phone's drawer, the Classes sheet with a Fighter and an Other row and the lowering line, the Short Rest card with two die sizes, a typed field and a landed roll, the slot offer with two pools.
- **Mutation checks**: each new rule test must fail with its fix taken out: the round up and round down, the one-class rule, `third` below 3, Pact on a Short Rest, the clamp, the shape's CON, the re-sync Undo's counts, the `hitDie` reach and the lent-token check.

## 14. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Paladin 1 alone | 2 level 1 slots | spellSlots.test |
| Paladin 3 and Wizard 1 | caster level 3: 4 and 2 | spellSlots.test |
| Fighter 4, subclass casts, alone | 3 level 1 slots, its own table | spellSlots.test |
| Fighter 2 and Paladin 3 | the tick is off below 3, Paladin's own table | spellSlots.test, logic.test |
| Warlock 5 and Sorcerer 3 | 4 and 2 slots, Pact 2 at level 3 apart | spellSlots.test |
| Artificer 3 and Wizard 2 from D&D Beyond | Other class d8 3, Wizard 2, level 5, 3 d8 and 2 d6 | read.test |
| Save that lowers 8 to 3 | the lowering line, a second tap sends | logic.test, e2e |
| Last class removed | classes and spent go, level stays | tokens.test |
| Barbarian 5 and Fighter 1 saved at level 6 | no Rage update asked | classResources.test |
| A Wizard 3 alone in a fight | a turn card with the folded slot row, count 1 | alerts.test |
| Two devices tap the last level 3 slot | one spends, the other reads "No level 3 spell slots left." | uses.test, e2e |
| Re-sync drops Wizard 5 to 4, then Undo | Wizard 5 and its spent slots back, refused after a spend or any rest, equal counts too | pcSync tests |
| Short Rest | Pact back, dice and slots stay | rest.test |
| Long Rest, party Long Rest | every slot and die back | rest.test, actors.test |
| Roll at full HP, or with none left | Roll off with its reason, the server refuses before the draw | resolve.test, logic.test |
| Wild Shape Brown Bear, base CON +0 | the die adds +2 | resolve.test, dice.test |
| A character with no block or shape | the CON field, remembered on this device | logic.test, e2e |
| A lent-token player taps a slot by op | `NOT_YOURS`, same with 0 or 4 left | twin 4 |
| Pat reads Kim's roll | the heal line only, as for a DM heal | twin 3 |
| The DM's Again on a Hit Die line | none offered | dice/logic.test |
| A cast ask at level 3, the DM resolves at once | the offer stays, both pools for Wizard 5 and Warlock 5 | cast tests, e2e |
| Warlock 5 asks saves for a level 1 spell | casting level starts at 3, "Use a Pact Magic slot (cast at level 3)" | cast tests |
| An area spell with no row of its own | the fallback offer under the creature's options | cast tests |
| Wizard 9 and Warlock 5 send Fireball at level 5 | the level 5 slot button only, no Pact | cast tests |
| A room exported after a rest at op 68 | imports with `useRev` | stateSchema tests |
| A stored op-67 room | replays to the same hash | replay fixtures |

## 15. Op 68 riders from item 7

Each would add its own predicate in migrate.ts, gated at 68, in a lane stacked after lane A's contracts commit. A owns migrate.ts, so a rider sends A its constant and comment or stacks on A's last commit. A rider gates at 68 only if it ships in the deploy that first ships 68. Otherwise it takes 69 (D-261127-278).

| Item | Rides 68? | Size |
| --- | --- | --- |
| LP54-EDGE-1 (a squeezed Large creature beside a trapdoor on the west side of a north or south edge corridor springs it and stays) | yes: a walk rule for stored walks needs a gate | S to M (one rule in the walk's spots and `rangeAtInto`, its twin and a stored replay) |
| LP53-TRAP-2 (after a reload the DM's trap card reads "a creature" for a token away) | yes, if the fix stores the away holder's id on the occurrence, which also rides snapshot 51 | S |
| LP52B-INIT-ROWS (two Initiative rows for one character's two tokens) | no: it needs its own combat design first (D-261126-290) | M with the design |
| DROPMAP-OPUS-8 (the map's edge as a wall for a squeeze) | built at op 66 (`edgePinches`, migrate.ts:2783, S66-B), hexes already counted the edge, so close it | none |

## 16. Decisions

- **D-261127-076** Counts come from classes and the tables. Rejected: 14 entries in the 12-entry class resource list, a typed most per level.
- **D-261127-077** Spent counts live in `Character.spent`, written by use, roll and rest ops and a re-sync Undo. Rejected: counts in an ordinary `character.update`.
- **D-261127-078** Slots show wherever class resources show, folded on the turn card and the phone's drawer by 360. Rejected: the panel only, a Spells panel.
- **D-261127-079** Hit Point Dice live in Rest. Rejected: rows in Uses, which are combat spends.
- **D-261127-080** One tap rolls one die on the server and heals at once. Rejected: dice gathered and applied on Finish, all dice in one roll.
- **D-261127-081** Type a roll… spends one die for typed HP. Rejected: app dice only, today's one total field.
- **D-261127-082** A Long Rest gives back every Hit Point Die. Rejected: half, the 2014 rule.
- **D-261127-083** Recovery features are Restore taps. Rejected: an Arcane Recovery picker, slots made past the count.
- **D-261127-084** The SRD multiclass rule, one caster class on its own table. Rejected: always the multiclass table.
- **D-261127-085** "Its subclass casts spells" on Fighter and Rogue, no subclass named (labels and source by 260 and 274). Rejected: naming subclasses, no third casters.
- **D-261127-086** Saving classes sets the level to their sum, a mismatch shows one line. Rejected: two numbers apart, a level only the classes set.
- **D-261127-087** The sheet starts from class resource presets, and Add a class resource from the classes. Rejected: no link.
- **D-261127-088** Classes and counts reach the DM and owners only, lines too. Rejected: lines public by name, as class resources are.
- **D-261127-089** The roll's line reaches the DM and owners only (by 269, ordered by 270). Rejected: a public dice line, which tells the heal past HP access.
- **D-261127-090** A lent-token player spends none. Rejected: token ownership as enough.
- **D-261127-091** CON as the character rolls it (263), else a field this device remembers. Rejected: a block required, CON stored on the character.
- **D-261127-092** A die at full HP is refused and its button off. Rejected: let the die go to waste.
- **D-261127-093** The Dice panel's spell rolls spend no slot and offer none (the cast ask by 262). Rejected: a slot per spell roll (a roll is not a cast, as for X/Day).
- **D-261127-094** D&D Beyond fills classes, not spent counts, so a fill starts full. Rejected: reading its spent slots and dice.
- **D-261127-095** Replaced by D-261127-261: a non-SRD class becomes an Other class row.
- **D-261127-096** OP_VERSION 68 and SNAPSHOT_VERSION 51, identity steps, one predicate by 361. Rejected: an op step alone, which an older build would meet as an unknown field.
- **D-261127-097** The tables are rules, changed only behind a gate. Rejected: a most stored per character.
- **D-261127-098** DM undo steps for uses and classes, Restore for players, the roll on no stack (scopes by 272). Rejected: a player Undo.
- **D-261127-099** At most 12 entries, each SRD class once, Other classes as fit, levels to 20, sum to 20. Rejected: a separate cap.
- **D-261127-100** Dice roll mid-fight under the existing note. Rejected: refusing them in a fight.
- **D-261127-101** Mystic Arcanum and other once a day spells stay typed class resources. Rejected: presets for them.
- **D-261127-102** The party Long Rest restores slots and dice, its line names them. Rejected: characters only.
- **D-261127-103** Of item 7, LP54-EDGE-1 and LP53-TRAP-2 may ride 68, LP52B-INIT-ROWS waits for its design, DROPMAP-OPUS-8 closes. Rejected: holding 68 for all four.
- **D-261127-104** Slot counts as pips (at most 4), dice as pips to 6 then words. Rejected: words everywhere.
- **D-261127-105** No new key or gesture. Rejected: number keys for slot levels.
- **D-261127-263** CON is `creatureNumbers`' (the shape's in Wild Shape), the op's `con` only where that gives none. Rejected: the base block's CON always.
- **D-261127-264** A re-sync Undo sends the classes and the exact spent counts from before in one guarded update. Rejected: Undo of classes alone, which loses clamped counts.
- **D-261127-265** Saving no classes removes classes and spent and keeps the level. Rejected: sending level 0, keeping spent.
- **D-261127-266** Slots count in `usesCount`, which admits the turn card: the slot group 1 and Pact 1 (by 360). Rejected: no count, which drops a caster's card.
- **D-261127-267** Other class rows carry a level and a die. A Save that lowers the level asks for a second tap. Rejected: a name field, saving a lower level silently.
- **D-261127-268** With classes, `levelUps` reads each class's own level. Rejected: the total-level guess for every character.
- **D-261127-269** The Hit Die roll's own `hitDie` mark with owners-only reach, and no Again. Rejected: reusing `DiceRoll.hidden`.
- **D-261127-270** No order rule for the heal and roll lines. The twins' mutation is the reach. Rejected: a line-order requirement no test can fail.
- **D-261127-271** No forced first-commit snapshot, and the rollback note says which rooms need the backup. Rejected: raising the actor.ts gate to 51.
- **D-261127-272** The DM's uses are play steps on the toolbar Undo, the roll `none`, classes a Setup step, and undoCorrection holds both fields. Rejected: uses in Setup history.
- **D-261127-273** Full slot rows reuse the class resource row whole, in the panel, page and tracker row. Rejected: compact one-line rows.
- **D-261127-274** One-third casters count from level 3, say they are not SRD, and stay out of CREDITS' SRD list. Rejected: unlabeled numbers.
- **D-261127-275** D&D Beyond drops level 0 classes and reads no classes past 20, with a warning. Rejected: clamping to 20.
- **D-261127-276** `spent` has one normal form, checked by the import schema against the counts. Rejected: any shape the reducer could read.
- **D-261127-277** Accepted: other players can count dice spent from heal lines. Rejected: hiding the heal, which other heals show.
- **D-261127-278** A rider gates at 68 only in the first deploy of 68, else 69. Rejected: a later lane reusing 68.
- **D-261127-279** A sent cast ask offers Use for its level's slot, off when none is left (where and which pools by 362, 363). Rejected: spending on send, Use in every spell roll.
- **D-261127-360** The turn card and the phone's drawer fold the slots into one "Spell slots" row with Use a slot… (and Restore a slot… in the drawer), Pact its own row. Rejected: nine full rows on a 650 px alerts column.
- **D-261127-361** `useRev`, moved by every rest and use from op 68 (`usesStamped`), joins the re-sync Undo's guard. Rejected: a guard of counts alone, which a rest with equal counts passes.
- **D-261127-362** The slot offer lives in the roll options' store under the spell's row, outliving the cast block. Rejected: a button in the block, which closes on send.
- **D-261127-363** The offer lists every pool at the casting level, Pact Magic included, and the player chooses. Rejected: ordinary slots only.
- **D-261127-364** The rollback note counts only rooms this build snapshotted or changed. Rejected: every loaded room.
- **D-261127-365** Numbers that fail to load turn Roll off with the shared load-failure line, and a shaped character never gets the CON field. Rejected: the CON field as a fallback.
- **D-261127-366** An Other class from D&D Beyond is named on its review line with a warning that it never counts toward slots. Rejected: a silent Other row.
- **D-261127-367** `patch.spent` needs `classes`, `ddbSync` and `expect.classes` in the same patch. Rejected: `classes` and `expect` alone.
- **D-261127-368** With classes, a preset whose class is not in them asks for no update. Rejected: falling back to the total level.
- **D-261127-369** sizeGuard counts `spent` and `useRev` at their widest for a lent player's rest. Rejected: no written field, which a lent rest disproves.
- **D-261127-400** (amended by 408) Ordinary slots are offered at exactly the casting level, Pact as "cast at level 3". Rejected: Pact at or below its level after sending (408). Before sending, the Pact-only default of 401 still lets a Warlock's level 1 spell reach the Pact level.
- **D-261127-401** Where Pact Magic is the only pool covering the spell, judged by the slot maxima the classes give and not the slots left, the casting level starts at the Pact level. Rejected: the spell's own level, which a Warlock must raise by hand every cast.
- **D-261127-402** `useRev` is named beside `classes` and `spent` in the snapshot, import, projection, twins and scans, a whole number like `rev`. Rejected: a model field the strict import schema refuses.
- **D-261127-403** An area spell with no row gets its offer in a fallback line under the creature's options. Rejected: no offer for such a spell.
- **D-261127-404** A rest always moves `useRev`, a use only when it changes something. Rejected: every use op, no-ops too.
- **D-261127-405** `expect.classes` alone hashes `useRev`, and every re-sync Undo sends it, a resources-only one too. Rejected: `useRev` in the resources hash, which would move stored hashes.
- **D-261127-406** A re-sync Apply that writes classes or resources sends `expect.classes`, so a rest or use during the review refuses it. Rejected: Apply unguarded by the stamp.
- **D-261127-407** An ability use writes `actor.uses` and `useRev`, not `spent` (resources by 409). Rejected: the round 2 wording.
- **D-261127-408** After sending, Pact is offered only when its level equals the ask's casting level, and the Pact-only default stays. Rejected: Pact at or below its level, which spends a level 3 slot for a level 5 Fireball.
- **D-261127-409** sizeGuard counts only `spent` and `useRev` for a lent rest, and main's resources gap goes to follow-ups as LENT-REST-RESOURCES. Rejected: `resources` at its widest, about 4 KiB past the 5 KiB character width.

**Hardest to review.** 1: the folded slot row and its count (360, 266). 2: the one-third tables outside SRD 5.2.1 (260, 274). 3: the level from the classes' sum and its second tap (086, 267). 4: the re-sync Undo restoring counts through `patch.spent`, guarded by `useRev` (264, 361, 367). 5: no spent counts from D&D Beyond (094).

## 17. Round 1 changes

ASTRA-01 and R1-17 (Wild Shape CON): 2, 3.3, 6, D-263. ASTRA-02 (re-sync Undo after a clamp): 6, D-264, closed in round 2. ASTRA-03 (level 0): 3.1, 5, 6, D-265. ASTRA-04 and R1-03 (turn card gate): 3.2, 4, 9, D-266. R1-01 (non-SRD classes): 3.1, 5, 8, D-261, 267. R1-02 (level-up prompt): 3.1, D-268. R1-04 (`hidden` reuse): 7, D-269. R1-05 and ASTRA-05 (order mutation): 7, D-270. R1-06 and ASTRA-06 (rollback): 6, D-271. R1-07 (undo scopes): 6, D-272. R1-08 (one-third not SRD): 2, 3.1, 9, D-260, 274. R1-09 (missed files): 6, 9, 12. R1-10: 8, D-275. R1-11: 5, D-276. R1-12: 7, D-277. R1-13: 15, D-278. R1-14 and ASTRA-07: the decisions log. R1-15: 3.2, D-273. R1-16: 3.2, D-262, 279. R1-18: 3.3, 3.4, 11. DFEAT (D-261127-300): 4.

## 18. Round 2 changes

| Finding | Settled in |
| --- | --- |
| R2-01 (turn card and drawer heights) | 3.2 folded row, 3.5, 9, 13, 14, D-360, D-266, D-273 |
| ASTRA-02 (equal counts after a rest) | 5 "The use stamp", 6 "Re-sync Undo" and OP_VERSION, 13, 14, D-361 |
| ASTRA-08 (offer outlives the block) | 3.2 cast ask, 4, 9, 12, 13, 14, D-362 |
| ASTRA-09 (Pact and both pools) | 3.2 cast ask, 13, 14, D-363 |
| R2-02 (clean stop snapshots) | 6 "Rollback", D-364 |
| R2-03 (numbers failed, CON field) | 3.3, 13, D-365 |
| R2-04 (Other class warning) | 8, D-366 |
| R2-05 (`spent` with `ddbSync`) | 6 op table, 13, D-367 |
| R2-06 (preset with no class) | 3.1, 13, D-368 |
| R1-08 leftover (quoted SRD bullet) | 2 |
| DFEAT (Log and Recent rolls) | 4 |
| Own find: a lent player's rest writes past their copy | 7 "Room size", 9, 12, D-369 |

## 19. Round 3 changes

| Finding | Settled in |
| --- | --- |
| R3-01 (Pact at or below its level, default level) | 3.2 cast ask, 13, 14, D-400, D-401 |
| R3-02, ASTRA-12 (`useRev` in every list) | 5, 6, 7, 10, 13, 14, D-402 |
| ASTRA-10 (area spell with no row) | 3.2 cast ask, 13, 14, D-403 |
| R3-03 (no-op uses) | 5 "The use stamp", 13, D-404 |
| R3-04, ASTRA-11 (which parts, resources-only Undo, Apply) | 6 "Re-sync Undo", 13, D-405, D-406 |
| R3-05 (ability uses, lent rest of resources) | 7 "Room size", D-407 |

## 20. Round 4 changes

| Finding | Settled in |
| --- | --- |
| ASTRA-13 (Pact at the sent level only) | 3.2 cast ask, 13, 14, D-408, D-400 |
| R4-01 (no resources in the lent width) | 7 "Room size", D-409, D-407 |
| Wording (R3-04's reason, the Warlock default in FEATURES) | 6 "Re-sync Undo", 9 docs |

## 21. As built

**Lane A (rules and server)**

- Refusals the design names no words for. A slot or die op on a creature with no character reads "Only a character has spell slots and Hit Point Dice.", a character with no Pact Magic "Bree has no Pact Magic slots.", no die of the size "Bree has no d12 Hit Point Dice.", and a shape or block whose numbers are not known on the server "The character's Constitution modifier is not known here." Below 1 HP or not alive reuses rest.ts REST_NEEDS_HP ("a rest needs at least 1 Hit Point"), the same check a rest makes.
- Refusal order for a die spend or roll: no classes, no die of that size, below 1 HP or not alive, full HP, none left.
- `con` absent on a character with no block and no shape counts as +0.
- The Hit Point Die roll's label is "Hit Point Die (d10)", so the line reads "Kim rolled for Bree, Hit Point Die (d10): 1d10+2 (7) = 9." The dice line is `to: "all"`, and its reach comes from `hitDie` in diceRollReach.
- A typed die's line comes before its HP line in the op. The order is free by D-261127-270.
- Undo labels for give backs of the three new kinds read "giving back ..." (the design's words), while older kinds keep "restoring ...".
- levelUps takes the classes as a third parameter. With an empty or absent list it keeps the total-level rule.
- SPENT_MOST is 81 bytes, by the caps alone (nine slot levels at 4, Pact at 4, each die at 20). A lent character takes 4801 of EXACT_WIDTH.character's 5120 bytes (4685 before), a margin of 319 bytes.
- stateSchema refuses an empty `classes` list and `spent` with no classes, since the reducer never stores either.
- reid.caps.test.ts now loops the versions below version 8 ids, since a room at 50 or 51 gives no ids anew and its load runs no measure.
- The replay proof is shared/reducer/useStamp.replay.test.ts with a hash-only fixture (14 KB): 120 seeded runs, 3600 ops, written on the base build ztwoqzzx (d30bb30c), byte-equal at 65, 66 and 67. Live, 1787 of 3600 ops land otherwise, every one by the stamp.

**Lane C (D&D Beyond)**

- PcFill gains `classNames` beside `classes` (one D&D Beyond name per entry, line(40), at most 12), so the review can say "Artificer 3 (Other class, d8)". The model stores no name for an Other class. Rejected: a name field on ClassLevel (D-261127-267 rejected one).
- shared/protocol.ts (lane A's file, one small commit rpoqyryw): `pcFill.classes`, `pcFill.classNames`, `ddbBase.classes`.
- A re-sync's lines name an Other class by D&D Beyond's name through `names` on the classes item (FieldItem and AlsoItem). The "now" side, and a class at the last sync, read "Other class 3 (d8)", since the character holds no name.
- Classes compare as a set (same entries, any order): a list reordered on the Classes sheet is no change on a fill or re-sync.
- Overwrite on a kept classes line reads "Overwrite with Wizard 7", and "Overwrite with D&D Beyond's" when D&D Beyond has none (never "Overwrite with none").
- A class whose name is missing reads "A class" in the die warning, as the reader names it elsewhere. A read list past the caps (classesFit) is left out whole with no line, which no real sheet reaches.
- `third` is set on a Fighter or Rogue whose subclass gives the spellcasting ability and its class does not, at any level. It counts only from 3 (spellSlots.ts).
- Past 20 the existing line "...so the level reads 20." stays, and the new "...so the classes were not read. They stay as they are." follows it.
- The stat block editor's import review (fill.ts alsoLines) gains the classes line, and its Save sends `classes` beside the level (never `spent`). client/features/pcstats/resync.ts (words) and PcStatsEditor.tsx (`ALSO_WORDS.classes: "the classes"`) were touched minimally for it. SyncReview.tsx needed no change: it renders the lines from resync.ts.
- Apply also expects `classes` when it writes class resources (D-406), and every Undo expects `classes` (D-405). An Undo that puts classes back sends `spent: {}` when none was spent before, which the reducer reads as none.

**Lane B (client)**

- The Classes sheet is titled "Classes". Each row puts its class on a line of its own, with the level and Remove under it, so a phone never leaves Remove alone on a line. The level uses the panel's stepper (minus 1, the number, plus 1), since no Size stepper with icons exists.
- A new row takes the first SRD class no row picked, at level 1. With no rows the sheet says "No classes. Saving with none removes them and every spent slot and die, and keeps the level."
- Below class level 3, "Its subclass casts spells" shows unticked and unavailable, and Save sends `third` only from 3. The Classes line names an Other class "Other class 3 (d8)".
- Words the design left open. Restore off reads "Every level 3 spell slot is there.", "Every Pact Magic slot is there." and "Every d10 Hit Point Die is there." Pact's Restore is named "Restore a Pact Magic slot", and Type a roll… "Type a roll for a d10 Hit Point Die". A typed roll out of range reads "Type the HP from 1 to 100000.", and the Constitution field's hint "-5 to 10. No stat block to read it from. This device keeps it." A nonempty Constitution field that is no modifier from -5 to 10 holds Roll with "Type a Constitution modifier from -5 to 10." (SLOTS-ASTRA-01), and only an empty one counts as +0.
- One pending guard serves every die row's Roll, typed Spend and Restore, so no second die goes before the first answer (SLOTS-ASTRA-02). A roll frees it from that roll's own receipt, never the die row's latest roll, which a token panel and a page share, and never hung on a hidden pane (SLOTS-ASTRA-05).
- The Constitution error stands on its own line under the field's row, so the field keeps its place at 390 px (SLOTS-O-11).
- Pact Magic's row on the turn card has Use alone, as the card's class resource rows do. The drawer's and the full rows have Restore too.
- The bar's drawer folds the slots wherever the bar spans a phone held upright, resting as the strip or expanded (TokenActionBar's frame `rest`).
- A Hit Point Die roll's result shows once its answer commits, as the death save card's does (useCardRoll). It keeps no hold for the 3D dice. Where the numbers failed to load, Roll is off with "The Constitution modifier did not load." and the shared load-failure line stands under the rows.
- The slot offer lives in the roll options' store as `offers`, keyed by the creature and the spell's name, case blind, so another ask from that spell replaces it, and an ask with no pool at its level ends it. Its group is named "Hold Person: Cast at level 2.", and Dismiss "Dismiss the slot offer for Hold Person". The fallback line stands at the top of the creature's options for every offer whose spell has no row.
- The room search finds Classes, Spell slots and Hit Point Dice on a character's page only, not in the token panel. The DM finds Spell slots and Hit Point Dice on every character's page, as the rests, and Classes stays with the character's players (SLOTS-O-03).
- A player lent only a character's token gets the Short Rest note without its classes, since they hold no Classes control (SLOTS-O-04).
- The Long Rest note for a character with classes but no slots leaves out "every spell slot back". The party card names each kind any of the party has spent ("It also restores every class resource and spell slot.").
- The DM guide's two pictures, spell-slots-turn.webp and short-rest-dice.webp, come from scripts/guide-slots.ts, in a room named "Guide examples", as the guide's other scripted pictures do.
- RecentRolls.tsx needed no change: a Hit Point Die roll has no Again because `againInput` returns none for it.
- Alignment: the page's slot rows, the Classes sheet with a Fighter and an Other row and its lowering line, the Short Rest card with two die sizes, its typed field and a landed roll, the turn card's folded row open and the drawer's Restore a slot… are in the sweep (alignmentRoom.ts slotScreens, at the combat screens' sizes). The turn card's folded row closed and the slot offer are measured in slotsdice.e2e.ts at 390 x 844.
