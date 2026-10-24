# raccoon-vtt v1: class resources from D&D Beyond

Status: draft 3, 2026-10-24, revised for design review round 1 (findings DDBRES-OP-1 to 16 and DDBRES-ASTRA-1 to 6, cited here as OP-1, ASTRA-1 and so on) and D-261024-30. Code is cited from main at `3579f37d8`, FU26's tip (op version 21, snapshot version 22), which changed the class resource rows. It builds on docs/design-v1-combat-controls.md ("the combat note", section 7 and Appendix A), docs/design-v1-pc-stats.md ("the stat block note", 6.3 and Appendix B) and docs/design-v1-resync.md ("the re-sync note", 2 to 4). It stacks after follow-up batch 28, which renames Give one back to Restore.

The project owner, 2026-10-24: "Is there any way for the class resources and their uses to be imported from beyond?"

Decided under guess mode as D-261024-25: yes. The D&D Beyond step and Re-sync gain a class resources part, read from the character's limited-use actions (name, maximum, the rest that resets it, and the uses spent), merged by name with the resources the character already has. This reverses the combat note's decision 9 ("no D&D Beyond fill"), whose only reason was the re-sync part this note adds.

## 0. Today and the answer in short

**Today.**
- A character's class resources (`Character.resources`, shared/model.ts:1006) are added by hand: a preset by class and class level (shared/rules/classResources.ts, 29 presets), or Your own. Up to 12, names up to 40 characters, counts 1 to 99, pools to 200.
- `character.update` sends the list whole with no `used`. The reducer keeps each `used` by id, clamped to the new count, and a new id starts at 0 (`keptResources`, shared/reducer/tokens.ts:766).
- The D&D Beyond reader (shared/ddb/read.ts) already walks `actions.race`, `actions.class` and `actions.feat` for rolls (`actionRolls`, :366) and reads `classes[].level`. It never reads `limitedUse`.
- A re-sync merges three ways against `Character.ddbSync`, a record of what the last sync read (the re-sync note 2.1). It knows fields and rolls, not resources.

**The answer.**
- **The reader** reads each limited-use action of the class, species and feats into a class resource: its name, its maximum worked out the way D&D Beyond's sheet does, its rest and its uses spent. Items' charges and spells stay out.
- **The merge** treats one resource as one item, as it treats a roll: the record gains a hashed entry per synced resource, so a change made here is told from one made there. A resource that matches an SRD preset by name and class takes the preset's rest, since D&D Beyond cannot say "one back on a Short Rest".
- **Uses spent** come in with a new resource. For one the character already has, the room's count stays, and a different count in D&D Beyond is an unticked line, so a re-sync never undoes a fight's spending unless someone ticks it.
- **UI.** The review gains a Class resources group, and Also set gains the unticked spent lines. No new screen, button or key.
- **Versions.** The next free op and snapshot pair, identity steps.

## 1. What D&D Beyond sends

D&D Beyond's character service is undocumented. The paths below come from open-source readers of the same JSON, read for this note: ddb-importer for Foundry (its source types, `getLimitedUses` and its class enrichers), D&D Beyond's own rules engine as copies of it in open-source projects show (`deriveMaxUses` and its enums), and sample bodies those projects publish. No real person's character was fetched. The build confirms each path against a public character made for the purpose, as the stat block note's build did, and keeps them in one table in the new reader file, with a fixture per row.

### 1.1 The fields relied on

All paths are under `data`. `A` is one of `actions.class[]`, `actions.race[]` and `actions.feat[]`, in that order. Any of them may be null. A class feature's own `definition.limitedUse` is not read: it is a `{ level, uses }` list that is mostly filler, holds no spent count, and D&D Beyond's sheet does not track from it. The spent count lives only on the action.

| Field | Path | Used for | Sure | Missing or unknown |
| --- | --- | --- | --- | --- |
| The lists | `A` | where limited uses live | high, read today for rolls | `actions` not an object: no resources read, the existing warning (3.3). One list null: read as empty |
| Name | `A.name` | the resource's name and key | high | not a string, or empty after cleaning: left out, counted in one warning |
| Limited use | `A.limitedUse` | marks an entry as a resource | high | null or absent: not a resource, silently. Most actions have none, Flurry of Blows' among them |
| Base count | `A.limitedUse.maxUses` | the count, already set for the class level by the server (Ki Points 8 at Monk 8) | high | absent or not a number: could not be read (3.2). Null or -1: 0 beside an ability or the bonus. With neither, 0 or -1 is not a resource, silently, and null could not be read (1.2) |
| Ability | `A.limitedUse.statModifierUsesId` | an ability modifier in the count, 1 to 6 as Strength to Charisma | high | null, absent or 0: none. Another number: could not be read |
| Its operator | `A.limitedUse.operator` | 1 adds the modifier, 2 multiplies | high | absent: 1 (1.2). Another number: could not be read |
| Proficiency | `A.limitedUse.useProficiencyBonus` | the proficiency bonus in the count | high | not `true`: none. Older bodies leave it out |
| Its operator | `A.limitedUse.proficiencyBonusOperator` | 1 adds, 2 multiplies | high | absent: 1. Another number: could not be read |
| Rest | `A.limitedUse.resetType` | the rest that brings it back (1.3) | high: 1 to 4 are the only values known | null, absent or another number: could not be read |
| Spent | `A.limitedUse.numberUsed` | uses spent in D&D Beyond, a pool's amount spent | high | not a whole number of 0 or more: unknown, so a new resource starts with none spent and no spent line is offered. Past the count: cut to it (D&D Beyond allows it) |
| Cost per use | `A.limitedUse.minNumberConsumed`, `.maxNumberConsumed` | a pool, for a resource with no preset, when one use costs more than 1. A range, the most over the least (`max(1, minNumberConsumed ?? maxNumberConsumed)`, as the engine reads it, OP-8), spends an amount. A fixed cost above 1, such as `{ minNumberConsumed: null, maxNumberConsumed: 2 }`, also comes in as a pool, its count the units, with the cost line (3.3), since a count here always spends 1 (shared/reducer/uses.ts:254, ASTRA-7, D-261024-34) | medium | not numbers: not a pool |
| Its source | `A.componentTypeId`, `A.componentId` | what granted it: 12168134 a class feature, 1960452172 a species trait, 1088085227 a feat. A class feature's id meets `classes[].classFeatures[].definition.id` | high for those three numbers | no match, as for an optional class feature whose id the body does not hold: the action stands alone (2.1) |
| The feature | `classes[].classFeatures[].definition.requiredLevel`, `.name` | the feature's level and its class | high, read today | not a number: the feature does not resolve |

Read today and reused: `classes[].level` and `definition.name` (each class's level, the character's level and so the proficiency bonus) and the six scores (for a modifier).

Never read: `limitedUse.name` and `limitedUse.resetDice` (null in every sample), `description`, `snippet`, any notes, `activation`, `inventory[].limitedUse` with its `resetTypeDescription`, and `spells`. So no D&D Beyond prose enters a room, as the stat block note's reader rule says.

### 1.2 The maximum

D&D Beyond's own rule (`deriveMaxUses`), so the count is what its sheet shows. `pb` is the character's level's proficiency bonus, `m` the ability's modifier from the scores the fill reads.

1. `initial` = the base count, `least` = 1, `scaled` = 0.
2. With an ability: `scaled = m`. Its operator 2: `scaled = m × initial`, `least = initial`, `initial = 0`.
3. With the proficiency bonus, its operator 2: `scaled = (scaled + initial) × pb`, `least = initial`, `initial = 0`. Its operator 1: `scaled = scaled + pb`.
4. The count is `max(least, initial + scaled)`.

So Bardic Inspiration with Charisma 8 counts 1, D&D Beyond's floor of once, and a Breath Weapon of 0 plus the bonus counts 3 at level 5. ddb-importer writes a Foundry formula that skips the floor and can reach 0, so this note follows the engine, but for five choices, each with a fixture (OP-2, OP-9):
1. The floor is 1. The engine reads it from rule data (`minimumLimitedUseMaxUse`) that the character's JSON does not carry, and it is 1 today.
2. -1 reads as 0, as ddb-importer reads it. The engine keeps -1.
3. An absent operator is 1, since older bodies leave it out. The engine adds the base in step 3 only for an operator of exactly 1.
4. The bonus counts whenever `useProficiencyBonus` is true. The engine counts it only when the `statModifierUsesId` key is there, which older bodies also leave out.
5. A base of 0 or -1 with no ability and no bonus is not a resource, silently, as ddb-importer gives it no uses, where the engine's floor would show 1.

- Under 1 (only the multiply steps can give it): not a resource, silently.
- Over 99 for a count, or 200 for a pool: left out, warned. The bound applies after the preset match (3.4), which may make it a pool, so Lay on Hands at Paladin 20 is a pool of 100 (OP-14).
- An ability needs the scores' needs (the re-sync note 2.5), and the proficiency bonus needs the classes. Without them the entry is left out, warned, and resources are not read whole (3.2), so a linked one of that name is never removed for it.

### 1.3 Resets

| `resetType` | D&D Beyond says | Here |
| --- | --- | --- |
| 1 | Short Rest | `short`: back on a Short or Long Rest |
| 2 | Long Rest | `long` |
| 3 | Dawn | `long`, with a line under Check these (3.3). The app has no dawn, and a day's Long Rest ends near one |
| 4 | Other | left out, warned. D&D Beyond sends 4 for once-a-turn and other limits whose period is only in its text, such as several 2024 feats'. The one left-out rest that keeps the read whole (3.2) |
| null, absent, any other | unknown | could not be read: left out, warned, and the read is not whole, so a linked resource is never removed for it (OP-1) |

**A preset's rest wins.** A read resource that matches a preset (3.4) takes `presetReset(preset, classLevel)` (classResources.ts:139) when D&D Beyond says 1, 2 or 3. One `resetType` cannot say "one back on a Short Rest, all on a Long Rest", which the 2024 Rage, Channel Divinity, Wild Shape and Second Wind use, and ddb-importer adds that rule by hand for the same reason. The presets follow SRD 5.2.1, the rules the app plays by.

## 2. Which become resources

| Kind | Where | Held | Why |
| --- | --- | --- | --- |
| Class features with uses: Rage, Channel Divinity, Bardic Inspiration, Wild Shape, Second Wind, Action Surge, Indomitable, Arcane Recovery and the like | `actions.class` | yes | what class resources are for |
| Pools: Lay on Hands, Focus Points (Ki Points), Sorcery Points | `actions.class` | yes, as a pool | a Use spends an amount, as the presets' pools do. `numberUsed` is the amount spent |
| Species traits with uses: Breath Weapon, Relentless Endurance, Stone's Endurance, Healing Hands | `actions.race` | yes | today these are typed as Your own (the combat note 7.1), so a read saves typing |
| Feats with uses: Lucky's Luck Points and the like | `actions.feat` | yes | as species traits |
| An item's charges | `inventory[].limitedUse` | no | items are equipment, not class resources. Charges mostly come back at dawn by a roll, which no rest here gives, its `resetType` is a word, not a number, and a wand or two would fill the 12 |
| A free spell cast (Fey Touched's Misty Step), item spells | `spells.*[].limitedUse` | no | spells stay out, as the owner's words for combat say, and the combat note's decision 11 keeps features that only cast a named spell out of the presets |
| Spell slots, Pact Magic, Hit Point Dice, Heroic Inspiration | elsewhere | no | spells stay out, and the combat note's recorded picks leave the others out |
| `actions.item` and `actions.background` | `A` aside | no | an item's action spends its charges, and backgrounds grant no counted uses in SRD 5.2.1 |
| A limited use with no rest (`resetType` 4) | `A` | no | a class resource must say which rest brings it back (1.3) |

### 2.1 One feature, one resource

D&D Beyond lists some features on several actions. Bardic Inspiration comes once for each feature that changes it, and an action can share its feature with others that have no limited use. So, in this order:
1. **Above the level**: an action whose class feature resolves (1.1) with a `requiredLevel` past its class's level is dropped, since `classFeatures` lists features the class has not reached.
2. **One feature**: actions with a limited use and the same `componentTypeId` and `componentId` are one resource. It keeps the one named as the feature, else the first, and the highest `numberUsed` among them.
3. **One name in one class**: of resources with the same cleaned name in the same class (or with no class), the one whose feature has the highest `requiredLevel` stays, else the first. This is ddb-importer's rule for Bardic Inspiration, Channel Divinity and the like.
4. **One name in two classes**, such as a Cleric 6/Paladin 3's two Channel Divinities: two resources, each keyed by its class (4.1).

**Order and the cap.** Read in `actions.class`, then `actions.race`, then `actions.feat`, at most 200 entries a list as today (`MAX.actions`), then 2.1. Then class features sort by class in `CLASS_IDS` order, each class's in D&D Beyond's order, with unresolved actions after them, then species traits, then feats, and at most 12 are kept, the character's cap. A 13th is cut, warned, and resources are not read whole (3.2).

## 3. The reader

A new file, `shared/ddb/resources.ts`, called from `read()` (read.ts:539), so read.ts stays about rolls and the block. Same rules as the rest of the reader: named paths only, never a walk of the tree, every loop bounded, never throws, and a missing or mistyped value is skipped, never assumed.

### 3.1 The fill

```ts
// PcFill (shared/rules/pcFill.ts) gains
resources?: FillResource[]          // absent: not read (pasted text, or no actions). At most 12
read?: { weapon: boolean, spell: boolean, other: boolean, resource?: boolean }

type FillResource = {
  name: string                      // 1 to 40, as resourceName's schema takes it
  max: number                       // 1 to 99, a pool's to 200
  reset: 'long' | 'short' | 'shortOne'
  pool?: true
  preset?: string, level?: number   // a preset match (3.4): its id and that class's level
  classId?: ClassId                 // the class its feature resolved to, for pairing (4.2)
  used?: number                     // 0 to max. Absent: D&D Beyond's count was not read
}
```

`pcFillSchema` takes each resource as a strict object of exactly these fields (OP-4): `name` (`resourceName`), `max` (whole, 1 to 200, with `countFits`), `reset` (the three words), `pool` (`true`), `preset` (the preset id pattern), `level` (`characterLevel`), `classId` (an enum of `CLASS_IDS`) and `used` (whole, 0 to `max`), all but the first three optional, at most 12. `read.resource` absent while `resources` is there reads as false, so such a fill never removes. Each resource is checked against this before it joins the fill, so one bad name is left out with a warning and never makes the whole fill `unreadable`.

The cleaned name is cut on a whole character: today's `name()` (read.ts:50) cuts by code unit and can split a surrogate pair, which the resource name schema refuses, so the new file cuts by code point. Rolls keep today's cut: their name schema (`pcName`, protocol.ts:577) takes a lone surrogate, and a new cut would change their hashes.

### 3.2 Read whole

`read.resource` is true when `actions` came as an object, the cut took none, and every entry with a limited use became a resource or was left out for one of three read reasons: `resetType` 4, a base of 0 or -1 with no ability or bonus, or a count under 1 from 1.2's multiply steps. Anything else left out makes it false: a missing source (scores for a modifier, classes for the bonus), an absent or mistyped field, or an unknown value, `resetType` null among them (OP-1, OP-2). A merge removes a linked resource only when it is true, as for a roll's kind (the re-sync note 2.5).

### 3.3 Its warnings

Under Check these, one line each, at most 40 in all as today. They go right after the missing-source warnings, before the scores' and spells' lines, so the 40-line cut never drops them (OP-13). Names are listed up to 8, then "and others", as the spells' warning does:
- The missing actions warning becomes: "D&D Beyond did not send the character's actions, so other rolls and class resources were not read. They stay as they are."
- "Bardic Inspiration's count comes from an ability score, which was not read, so it stays as it is." and "Breath Weapon's count comes from the proficiency bonus, which needs the classes, so it stays as it is."
- "Cold Caster and Action Hero come back another way in D&D Beyond, so they were left out. Add one as your own if it counts."
- "Fey Step comes back at dawn in D&D Beyond. Here a Long Rest brings it back."
- "D&D Beyond has 14 class resources for Bree, more than the 12 a character holds, so 2 were not read. Class resources here that they would change stay as they are."
- "2 limited uses in D&D Beyond could not be read, so they were left out." for a name that does not read, a field absent or of the wrong type, a value not known, or a count past the bound.
- "Grit Points costs 2 a use on D&D Beyond: spend 2 each time." for a fixed cost above 1 (1.1).
- "Lay on Hands reads 5 in D&D Beyond, fewer than a Paladin 5's 25, so it reads 25 here. Check it." and "Wild Shape reads 2 in D&D Beyond, fewer than a Druid 6's 3 by SRD 5.2.1, so it reads 3 here. Check it." (3.4)

### 3.4 A preset match

A read resource takes a preset when its cleaned name, in lower case with curly apostrophes made straight, is the preset's name or one of D&D Beyond's own names for it below, and its class holds the preset at its level. Its class is the one its feature resolves to (1.1). An action that does not resolve takes the first class, in `CLASS_IDS` order, whose name (`CLASS_NAMES`) the character's D&D Beyond classes hold and which has the preset at that class's level. Species traits and feats match no preset.

**D&D Beyond's names**, the action names ddb-importer looks up, a fixed table in the reader:

| D&D Beyond names it | Preset |
| --- | --- |
| Focus Points (2024), Ki Points (2014) | Focus Points |
| Lay On Hands: Healing Pool (2024), Lay on Hands Pool (2014) | Lay on Hands |
| Font of Magic: Sorcery Points (2024), Sorcery Points (2014) | Sorcery Points |

Without the table the three pools would come in under D&D Beyond's names and, with `maxNumberConsumed` uncertain (1.1), maybe as counts, so Lay on Hands would spend 1 a tap. Any other name is matched as it is. A name in no row and no preset, such as a subclass feature of another book, comes in as named, with no preset, a pool only by `maxNumberConsumed`.

**What a match takes.** The name, the rest (1.3) and the pool flag come from the preset, so "Nature's Veil" with a straight apostrophe becomes the preset's "Nature’s Veil" and matches one added by hand. The count is D&D Beyond's, which counts what feats and items add, unless it is under `presetCount` at the class level (with the modifier from the read scores), when the preset's is taken with the warning above. ddb-importer distrusts D&D Beyond's Lay on Hands and 2014 Channel Divinity counts the same way, and the 2014 Paladin's Channel Divinity has no limited use at all. The same rule raises a 2014 character's counts to SRD 5.2.1's (D-261024-30): a 2014 Druid 6's Wild Shape reads 3, not 2, with the Check it line, and its rest is the preset's one back on a Short Rest. A matched resource carries `preset` and `level`, and once merged `atLevel` (4.4), as an Add would have made it.

## 4. Matching and merging

A new file, `shared/rules/resourceSync.ts`, beside pcSync.ts, with the same three-way rule. `planSync` calls it for its items and Also set lines, and `syncResult`, `syncPatch`, `afterSync` and `undoSync` for the list and the record. `SyncInput.character` and `SyncCharacter` gain `resources`, and `leavesAsIs` and `syncPatch`'s nothing-new test count the list.

### 4.1 The record and the key

```ts
// DdbSync gains, beside rolls
res?: Record<string, { k: string, h: string }>   // one entry per synced resource, keyed by hash12 of its id. At most 12
// gone may now also hold 'r:' markers: a resource the player removed that D&D Beyond still has
```

- **The key** (OP-3, OP-12): the name normalized as 3.4 does (lower case, curly apostrophes straight, spaces collapsed) after the name table, with the class first for a class feature ("paladin:channel divinity") and alone for a species trait, a feat or an action whose class is unknown. "#2" marks only a second of one key. So a Paladin's Channel Divinity keeps its key when the character gains a Cleric level. The class in the key binds only entries the record already holds (4.2, step 1). An own resource has no key of its own: it meets the read by name (step 2), and its entry then takes the read's `k`, class and all (OP-17).
- **`k`** is `r:` and `hash12` of the key. **`h`** is the hash of D&D Beyond's content as that sync read it, never the character's: `stableStringify({ name, max, reset, pool })`. `used`, `preset`, `level`, `atLevel` and `edited` stay out, so spending and bookkeeping never read as a change. The character's resource is compared by the same four fields.
- **`gone` is shared** (OP-10). The resource merge owns the `r:` markers and the roll merge `w`, `s` and `o`. Each passes the other's markers through in place, as `planRolls` already keeps a letter it does not know (pcSync.ts:625). New markers join the end, the rolls' then the resources', and the joint list keeps 40, the oldest of either kind going first, with the dropped-marker line in both kinds' words (6.1). A marker leaves once a whole read of its kind no longer has its key.
- **Entries never outnumber the resources.** An entry whose resource is gone becomes an `r:` marker on the next sync, whether that read is whole or not. So the record holds at most 12 entries.
- **Size**, counted as the re-sync note's Appendix A: an entry is 56 bytes, and 12 with their commas and the `"res"` key are 692. The re-sync note's bound of 4,790 bytes becomes 5,482, under 6 KiB.

### 4.2 The cases

**Who meets whom**, in order:
1. An entry whose resource is held claims the read of its `k`.
2. An own resource (no entry) meets an unclaimed read by name alone: both names normalized and run through 3.4's table, so a typed "Superiority Dice" with no preset meets the read "fighter:superiority dice" and no second copy comes in (OP-17). Of several own resources of one name, the one whose preset has the read's class goes first, then the list's order, and of several reads of one name, the classes go in `CLASS_IDS` order. Once linked, its entry takes the read's `k`. When that `k` is a removed entry's or a marker's, the own resource links in its place and the entry or marker goes (OP-7), so a Rage removed and added again by hand is the Rage, never "you removed it".
3. A removed entry or a marker whose key the read still has is "Removed here".

**Sources** (OP-11): `none` and `relinked` ignore `res` and the `r:` markers, as rolls ignore the record, so everything meets by step 2, differences go to Different in the dialog and Replaces in the editor (pcSync.ts:479), and Apply writes the resource part fresh. `first` (no block yet) is `none` for resources in both modes, since they live beside the block (ASTRA-8): every resource the character lacks comes in, and a typed one of the same name goes to Different in the dialog, kept unless ticked, and to Replaces only in the editor.

| Case | Record | Here | D&D Beyond | Outcome | Listed |
| --- | --- | --- | --- | --- | --- |
| Added there | no entry, not in `gone` | none meets it | has it | added at the end, with its spent count | Changes: "Adds Rage: 3 uses, one back on a Short Rest, all on a Long Rest, 2 of 3 left" |
| Changed there | entry | = `h` | ≠ `h` | updated in place: id and `used` kept, `used` cut to the new count | Changes: "Updates Rage: 4 uses, now 3" |
| Removed there | entry | = `h` | gone, read whole | removed | Changes: "Removes Divine Intervention" |
| Not read whole | entry | any | missing | kept, entry kept | none |
| Changed here | entry | ≠ `h` | = `h` | kept | Kept, Overwrite |
| Both changed | entry | ≠ `h` | ≠ `h` and ≠ here | kept | Kept, tagged "Also changed in D&D Beyond", Overwrite |
| Both reached it | entry | ≠ `h` | = here | nothing | none |
| Changed here, removed there | entry | ≠ `h` | gone, read whole | kept, entry dropped, so it is the player's own | Kept: "D&D Beyond no longer has it.", Remove it |
| Removed here | entry with no resource, or a marker | none meets it | has it | stays removed: the entry becomes a marker | Kept: "Rage: you removed it.", Add it back |
| Removed, added again | entry with no resource, or a marker | an own resource meets it by name | has it | linked in its place, the marker goes | as Same name |
| The player's own | no entry | meets no read | | kept, never recorded | none |
| Same name | no entry | meets it by name | has it | linked. Alike: nothing else. Else Different (dialog) or Replaces (editor), Overwrite or Keep mine | Different or Replaces |
| No room | | 12 resources | more | left out, not recorded | Check these: "2 class resources from D&D Beyond did not fit, since a character holds 12. They come in once there is room." |

- **Overwrite, Add it back and an update** write D&D Beyond's name, count, rest, pool, `preset` and `level`, set `atLevel` (4.4), and drop `edited`. Overwrite and an update keep the id and `used`, cut to the count. Add it back takes a new id and D&D Beyond's spent count.
- **No second copy.** A sync never adds or brings back a resource beside one that meets it by name (step 2). Two the player made alike stay two.
- **After Apply**, every read resource's entry takes D&D Beyond's `h`, kept or taken, so a kept change is listed again on every later re-sync, as fields are.
- **Manual is by value**: a resource edited back to D&D Beyond's content is untouched again, whether through Edit or the level-up Update.

### 4.3 Uses spent

Spending is play, not the sheet. So:
- **A new resource** (added, or Add it back) takes D&D Beyond's count, cut to its maximum, and the Changes line shows it ("2 of 3 left") when any is spent. With no count read, none is spent.
- **A linked one keeps the room's count.** When D&D Beyond's spent count differs from the room's, as read, Also set gets one **unticked** line for it, before the name: "Rage 3 of 3 left, now 1 of 3", help "Unticked keeps what was spent here." Ticking it sets the room's count to D&D Beyond's, cut to the count. The plan decides the line, and its words read the count the current ticks leave, from `syncResult`, as the Max HP line's help does.
- The record keeps no spent base. A rest in the app, a fight and a click in D&D Beyond all move the count, so a base would not tell whose change is whose, and an unticked default is the safe side.
- No log line is written for a spent count a sync sets, as none is for an Edit. Only the DM and the character's players see the count.

### 4.4 Levels

Every linked preset the read matches, kept or taken, takes the read's class level as `level` and the level the sync leaves as `atLevel` (D&D Beyond's when Level is ticked, else the character's) on every Apply (OP-6). This is outside `h` and makes no line, so a Barbarian 4 re-synced at 5, whose Rage count does not change, is not asked "Update Barbarian resources?" afterwards. `levelUps` (classResources.ts:186) asks only after the level rises here. The Update's counts are the presets', which the next re-sync lists as a change made here, with Overwrite, when they differ from D&D Beyond's.

## 5. Data, protocol, permissions and versions

- **`character.update`'s resources** gain `used?`, 0 to the resource's count. The reducer takes it when sent and otherwise keeps `used` by id as today: `used: r.used ?? min(before by id ?? 0, max)`, cut to `max` either way. Only a sync's Apply, its Undo and the editor's Save after a D&D Beyond fill send it, and only for a resource whose count they set. The schema comment and `keptResources`' comment change to say so. A player could already set any count with Use and Restore, so this grants nothing new.
- **`expect`** gains the part `resources`: the list whole, `used` included, hashed as the other parts are (permissions.ts:314), and `ExpectSubject` gains `resources`. It is a part the character's players hold whole (projection unchanged), so the precondition's rule holds. Apply, Undo and the editor's Save (6.2) send it whenever they write `resources` or change the record's resource part (`res` or the `r:` markers). So a Rage spent between the review and Apply refuses the Apply with `CHARACTER_CHANGED`, and the review rebuilds from the live character (the re-sync note 3.5), its spent line included.
- **The record**: `ddbSyncSchema` gains `res`, its keys and `h` 12 lower-case hex digits, `k` `^r:[0-9a-f]{12}$`, at most 12. `gone`'s pattern becomes `^[wsor]:[0-9a-f]{12}$`, and the rolls' `k` keeps `syncKey`'s `[wso]` (OP-10). The import's `ddbSyncForImport` is the same schema. Resource ids are the character's own and an import keeps them, so a restored backup keeps syncing three ways.
- **The fill**: `pcFillSchema` gains `resources` (3.1's fields) and `read.resource`. `checkedFill` is unchanged otherwise, and the route (server/http/ddbImport.ts) is unchanged: the answer grows by at most about 2 KB.
- **Undo** puts back the list whole, each `used` as it was, and the record before. `afterSync` works the list out by the reducer's rule from the list before and the patch sent, never from the view at the answer. The undo label is unchanged, since it reads `ddbSync` first (server/rooms/undoLabels.ts:144).
- **Permissions and bucket**: `resources` is already an owner field (permissions.ts:71). A sync's patch names `ddbSync`, so it already spends the block bucket. Projection does not change: the DM and the character's players get resources and the record, no one else.
- **Versions**: an older build's strict schemas refuse `used` in an op and `res` in a stored record, so this takes the next free op and snapshot pair at build time (op 22 and snapshot 23 today), both identity steps, in shared/migrate.ts.

## 6. UI

No new screen, button, key or setting. The re-sync dialog's review ("Check what changes") and the editor's ("Check what was read") gain the parts below, drawn by `SyncReview` from the plan as every other part is. No mockup is drawn: the lines are listed in order, in the words shown.

### 6.1 The review's new lines

**Groups.** `SYNC_GROUPS` gains "Class resources" after "Rolls". Changes, Kept, Different and Replaces list resources in that group, folded past 10 lines as each group is.

**A resource's reading**, for every line: `countWords` (client/features/resources/logic.ts:252), its first letter lowered, then the rest's words in lower case: "3 uses, one back on a Short Rest, all on a Long Rest", "a pool of 25, back on a Long Rest", "1 use, back on a Short or Long Rest".

| Where | Words |
| --- | --- |
| Changes, added | "Adds Rage: 3 uses, one back on a Short Rest, all on a Long Rest", and ", 2 of 3 left" when any is spent |
| Changes, changed there | "Updates Rage: 4 uses, now 3". Only what differs, new then "now" old: "Updates Bardic Inspiration: back on a Short or Long Rest, now back on a Long Rest", "Updates Superiority Dice: a pool of 6, now 6 uses" |
| Changes, removed there | "Removes Divine Intervention" |
| Kept, first line | "Superiority Dice, as you changed it: 5 uses, back on a Short or Long Rest" |
| Kept, D&D Beyond's | "D&D Beyond says 4 uses, back on a Short or Long Rest.", named first when the names differ: "D&D Beyond says Rage: 3 uses, …". On a conflict, the tag "Also changed in D&D Beyond" and the same line, as a roll's conflict reads (resync.ts:190), since the record keeps no earlier value (ASTRA-5) |
| Kept, its tick | "Overwrite with D&D Beyond's", "Remove it" ("D&D Beyond no longer has it."), "Add it back" ("Rage: you removed it.") |
| Different, group summary | "2: Rage, your own, differs from D&D Beyond's, and 1 more" |
| Replaces, a line | "Rage: 4 uses, back on a Long Rest, becomes 3 uses, one back on a Short Rest, all on a Long Rest", with "Keep mine" |
| Also set, spent | "Rage 3 of 3 left, now 1 of 3", unticked, help "Unticked keeps what was spent here." |
| Check these | the reader's lines (3.3), the no-room line (4.2), and a dropped marker in both kinds' words: "Your deleted Shortbow and Rage may come back on a later re-sync. Only 40 deleted rolls and class resources are remembered.", or unnamed, "A class resource you deleted …" and "2 rolls and a class resource you deleted …" |

- **The losses warning** also counts resources: a read that takes away 3 or more class resources that are at least half of those synced adds "and takes away 4 class resources" in its sentence.
- **The done line** counts resources with the rest: an addition, update, Overwrite or ticked spent line came in, a removal was removed, Add it back came back, and an unticked spent line stayed, as every unticked Also set line does (the re-sync note 8).
- **Overwrite all** covers resources' Overwrite, Remove it and Add it back. It never ticks a spent line, which is in Also set.
- **The Class resources section**'s empty help becomes "Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level, typed, or brought in with Re-sync from D&D Beyond." Nothing marks a synced resource, as nothing marks a kept field (the re-sync note's decision 7).

### 6.2 The editor's D&D Beyond step

The class resources are not in the stat block's draft, so the editor holds them beside it. The letters are OP-5's, for the build and the review to check one by one:
- **(a) Held.** Use it keeps the D&D Beyond fill in the editor's state with the resource part's result: the list, the hash of the list it was planned from, and the record's resource part. They stay until Save lands, the step reads again, or the editor closes.
- **(b) Planned against the live list.** The resource part always plans against the live character's resources and the saved record's `res` and `r:` markers, never a pending record from an earlier Use it, whose new ids the live list lacks. The record Save sends is the pending one with its resource part replaced by this plan's.
- **(c) Refused.** On `CHARACTER_CHANGED` nothing was saved. The editor opens "Check what was read" with only the Class resources group and its spent lines, planned from the held fill against the live list, under the danger Notice "Bree's class resources changed on another device before this saved, so nothing was saved. Check the review again." The draft, its rolls and Also set stay as they were. Use it then Save sends again, with no new fetch.
- **(d) Sent only when it changes something.** Save sends `resources` and `expect: { resources }` only when the held result changes the list or the record's resource part. A spend between Use it and Save then never refuses a Save that writes no resources. The rest of Save is today's: no other `expect`, and a later save wins.
- **(e) Unsaved.** A held result that changes either counts as unsaved for the leave prompt, and Save sends it even when the block and its record are as saved. Today `editorSyncUse` drops an equal record (flow.ts:79) and an empty patch sends nothing (PcStatsEditor.tsx:188), so a ticked spent line alone would be lost.

### 6.3 UI checklist

- **Loading**: no new slow path. The fetch, Apply and Undo keep their busy states and the shared delayed indicator ("Getting Bree from D&D Beyond…", "Applying…", "Undoing…"). The editor's rebuild after a refusal is in memory, so it shows no indicator.
- **Keys and focus**: none added. Space ticks a checkbox. A stale rebuild in the editor moves focus to the review's first line, by the re-sync note's rule (3.6).
- **Screen readers**: a kept resource row is a group named by its first line, as every kept row is. A spent line is a checkbox named by its words, with its help as its description.
- **Large interface sizes**: every line wraps at 14 px. The lines use the review's existing parts, `Checkbox`, `Notice`, `Help`, `Tag`, `Row`, so no new layout. Measured with `measureAlignment` at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, nothing over 1 px. e2e/alignment.e2e.ts does not cover the review: resync.e2e.ts measures it (rs-1, rs-3, rs-11), and the new step measures all six. The build adds the review's root to alignment.e2e.ts in the e2e commit.
- **Phones**: the dialog fills the screen below 600 px as today. Past 10 lines, Changes folds into its groups as today, so 12 new resources take one row, "Class resources", detail "12: Adds Rage, and 11 more".

## 7. Bounds and safety

- **The reader's limits**: 200 actions a list, read in three lists, 12 resources out, names 1 to 40 characters on one line with no control or direction characters, counts 1 to 99, pools to 200, spent 0 to the count. Every value is a number, an id or a cleaned name. No prose, no HTML, no description.
- **Sizes**: a character may already hold 12 resources at every bound, so the character's bounds do not change. The record grows by at most 692 bytes, to 5,482 of its 6 KiB. The stat block's 12 KiB is untouched, since resources live beside it. The route's 5 MiB body bound and budgets are unchanged.
- **What players see**: the same as a typed resource. The DM and the character's players read and use them. Other players, a token's lent player and the table display never receive them (`projectCharacter`, shared/project.ts:683, unchanged, and pinned by the existing projection test with a synced resource added).
- **Format changes**: a missing source is a warning and leaves the resources as they are, a missing field leaves out that resource or its spent count, and a cut or skipped entry never removes a linked one.

## 8. Edge cases

| Case | Expected | Test |
| --- | --- | --- |
| A Barbarian 5 whose Rage says Long Rest in D&D Beyond | Rage, 3 uses, one back on a Short Rest, all on a Long Rest, preset `barbarian-rage`, level 5 | reader |
| Bardic Inspiration: base 0, Charisma, Cha 8 | 1 use, D&D Beyond's floor | reader |
| Bardic Inspiration on two actions, from features at Bard 1 and Bard 5, at Bard 5 | one resource, the level 5 feature's, back on a Short or Long Rest | reader |
| Lay On Hands: Healing Pool, 25, 10 spent | the Lay on Hands preset, a pool of 25, 10 spent on a first sync | reader, merge |
| Lay on Hands Pool at 5 for a Paladin 5 | 25, with the check line | reader |
| `maxUses` -1 with the proficiency bonus | the bonus alone | reader |
| An action whose class feature is above its class's level | dropped | reader |
| `numberUsed` past the count | cut to the count | reader |
| A Breath Weapon by proficiency, level 5 | 3 uses, back on a Long Rest, no preset | reader |
| Scores not sent, Bardic Inspiration linked | left out with its warning, not removed, `read.resource` false | reader, merge |
| `resetType` 4 | left out with its warning, `read.resource` stays true | reader |
| `resetType` 7, null, absent or a string on a linked, untouched Rage | left out, warned, not read whole, Rage kept (OP-1) | reader, merge |
| `resetType` 3 | Long Rest, with the dawn line | reader |
| `maxUses` absent or a string on a linked Superiority Dice 4 | left out, warned, not read whole, kept at 4 (OP-2) | reader, merge |
| `maxUses` 0, no ability, no bonus | not a resource, read whole | reader |
| `{ minNumberConsumed: null, maxNumberConsumed: 2 }` with 8, `{ 1, 25 }`, and `{ 1, 1 }` | a pool of 8 with the cost line, a pool, and a count (OP-8, ASTRA-7) | reader |
| That pool of 8 in play | Use… spends 2 of 8, four spends empty it, a fifth is refused | reducer |
| Lay on Hands at Paladin 20, no cost fields | a pool of 100: the bound runs after the preset (OP-14) | reader |
| A 2014 Druid 6's Wild Shape of 2 | 3, one back on a Short Rest, with the Check it line (D-261024-30) | reader |
| 14 limited uses | 12 read, the cut warning, `read.resource` false | reader |
| A name of 41 characters with an emoji at the cut | cut on a whole character, schema passes | reader |
| Two actions of one feature, one named as the feature | one resource, that name, the higher spent count | reader |
| Cleric 6/Paladin 3, two Channel Divinities | two resources, each its class's preset, paired by class with the character's | reader, merge |
| A Paladin 3 with a linked Channel Divinity gains Cleric 2 | the Paladin's keeps its key and spent count, the Cleric's is added (OP-3) | merge |
| A Barbarian 4 re-synced at 5, Rage unchanged | `level` 5 and `atLevel` 5 written, no line, `levelUps` gives none (OP-6) | merge |
| Rage removed, then added again from the preset | linked in its place, the marker goes, no Add it back, one Rage after Overwrite all (OP-7) | merge |
| An own "Ki Points" typed by hand | meets the read as Focus Points and links (OP-12) | merge |
| A typed "Superiority Dice" with no preset, the read's class resolved to Fighter | linked, its entry takes `fighter:superiority dice`, no second copy (OP-17) | merge |
| A relinked sheet with `res` and `r:` markers | both ignored, linked by name, Different (OP-11) | merge |
| 40 markers of a roll kind not read, then a resource removed | the oldest roll marker goes, with the joint words (OP-10, ASTRA-9) | merge |
| Rage spent 2 here, 0 in D&D Beyond | kept at 2, unticked spent line. Ticked: 0 | merge, e2e |
| Rage spent in a fight between the review and Apply | Apply refused, review rebuilt, spent line shows the new count | server race, e2e |
| D&D Beyond raises Rage to 4, the player had typed 5 | kept 5, tagged, Overwrite | merge |
| The player removed Rage | stays removed, Add it back | merge |
| The character has 12 own resources | additions left out with the no-room line | merge |
| A first sync with no block, a typed Rage beside it | every resource the character lacks added with D&D Beyond's spent counts. Rage: Different in the dialog's mode, kept unless ticked, Replaces in the editor's (ASTRA-8) | merge |
| No record, a typed Rage preset alike | linked silently, recorded | merge |
| Undo after Apply | the list and every `used` exactly as before | merge, e2e |
| Undo after a spend since Apply | disabled with the re-sync note's help | server race |
| Editor Save after another device edits a resource | refused, only the resources part reviewed again, the draft kept, Save again saves | editor flow |
| Editor: Use it, then a spend, then Save of a held result that changes nothing | Save sends no `resources` and no `expect`, and lands | editor flow |
| Editor: only a spent line ticked | counts as unsaved, Save sends it | editor flow |
| Pasted stat block text | no resources part, the list untouched | merge |
| An older build | refuses the room cleanly (5) | migrate |

## 9. Tests

- **The reader** (`shared/ddb/resources.test.ts`, new): hand-built fixtures, one per row of 1.1's table and each path through 1.2 (an ability with each operator, the bonus with each, both together in all four pairs, the floor, under 1, over 99 and over 200, `maxUses` -1), each `resetType` and null, every row of 2.1, a preset match by name, by each of D&D Beyond's names (3.4) and by class (curly apostrophes, a subclass's, two classes by `componentId`, an unresolved `componentId`), a count under the preset's and a 2014 count, 14 entries, every missing source with its warning and `read.resource`, a bad name, and `numberUsed` missing and past the count. Also a row each for OP-1 and ASTRA-3 (`resetType` absent, null, a string and 7 make the read not whole, 4 does not), OP-2 and ASTRA-2 (`maxUses` absent, a string, null and -1 beside and without an ability or bonus, and 0 with neither), OP-8 and ASTRA-7 (a range, a fixed cost above 1 with its line, a cost of 1), each of 1.2's five choices (OP-9), OP-14 (the bound after the preset), and OP-13 (the resource lines survive 40 spell warnings). Each fixture is invented, in the service's shape, with only the paths read. `read.test.ts` gains the new words of the missing actions warning.
- **The merge** (`shared/rules/resourceSync.test.ts`, new): one row per case of 4.2, the spent rules of 4.3 (new, linked, cut to a lower count, ticked, unticked), Overwrite, Add it back and an update keeping the id and `used`, `atLevel` with Level ticked and unticked, the record's entries and `gone` markers, two Channel Divinities pairing by class, and the 12 cap. Also OP-3 and ASTRA-1 (a Cleric Channel Divinity gained beside a linked Paladin one, then lost again: each survivor keeps its id and spent count throughout), OP-6 (Barbarian 4 to 5, then `levelUps` gives none), OP-7 (removed and added again, each with an entry and with a marker), OP-11 (`none`, `relinked` and `first` with `res` and markers present), ASTRA-8 (`first` with a typed resource of a read's name: Different in `resync` mode, untaken with no tick, Replaces in `editor` mode), ASTRA-2 and ASTRA-3 (a linked, untouched resource whose `maxUses` disappears or becomes a string, and one whose `resetType` goes missing, becomes a string or reads 7: each kept as it was, its entry kept, the warning listed), OP-12 (curly apostrophes and an own "Lay on Hands Pool"), OP-17 (a typed own resource with no preset links to a read whose class resolved, with no duplicate). `pcSync.test.ts` gains the group, the losses count, the done line's counts, Overwrite all, and `syncPatch`, `afterSync` and `undoSync` with `resources` and `expect.resources`.
- **Randomized** (`pcSync.random.test.ts`): resources join the random triples, up to 12, with random spends, edits, removals, unread reads and ticks. New invariants (ASTRA-6): (9) a surviving resource, one with the same id before and after, without a ticked spent line ends with `used` = min(its previous `used`, its resulting `max`). Additions and Add it back take new ids and are outside it. (10) During a read that is not whole, every resource and entry whose source data was unavailable is kept as it was. (11) A re-sync at once with the same data brings nothing in. (12) Ids are unique, at most 12, the list passes `resourceStored`, the record its schema and 6 KiB. (13) Undo gives back the list exactly, every `used` included. (14) A sync never adds or brings back a resource beside one that meets it by name. (15) `gone` holds at most 40. Every marker of a kind not read whole is kept, but for those the 40 cap drops, oldest first, each with its warning, and each kind's markers keep their old order (ASTRA-9). The boundary has a fixed case too: 40 markers of an unread roll kind plus one new resource marker. The existing invariants 1 to 8 cover resources as items.
- **Beside the merge**: `protocol.test.ts` (`used` bounds, `res`, the `r:` marker in `gone` and never in a roll's `k`, the `resources` expect part, and the fill schema taking `classId` and refusing an unknown class, OP-4), `pcFill.test.ts` (a resolved Cleric 6/Paladin 3 fill passes `checkedFill` with both `classId`s, ASTRA-4), `reducer/resources.test.ts` (`used` sent, absent, past the count, a new id with `used`), `reducer/uses.test.ts` (a fixed-cost pool spends its amount, ASTRA-7), `permissions` (the expect part matched, missed and absent), `migrate.test.ts` (the identity steps), `stateSchema` (a record with `res` imports), `server/rooms/resync.test.ts` (the race above, on the room actor), `project.test.ts` (another player and the display get no synced resource), `client/features/pcstats/resync.test.ts` (every line of 6.1), `flow.test.ts` (6.2, one row each: the fill held after Use it, the plan against the live list and the saved record, the rebuild of the resources part alone with the draft kept, no `resources` or `expect` when nothing changes, and a held result alone counting as unsaved and sent, OP-5), `resyncFlow.test.ts` (unchanged invariants with resources in the review).
- **e2e**: resync.e2e.ts and pcstats.e2e.ts are being fixed in another lane, so the build adds these steps once that lands, labelled `ddbres-`. A fixture C, Bree as a Druid 6 with Wild Shape (2 spent), a Breath Weapon, Lucky and a wand with charges:
  - ddbres-1 (resync, Ana at 390 x 844): Re-sync lists "Adds Wild Shape: 3 uses, one back on a Short Rest, all on a Long Rest, 1 of 3 left", the Breath Weapon and Luck Points, and no wand. Apply, and the Class resources section shows them, Wild Shape 1 of 3.
  - ddbres-2: Ana uses Wild Shape in a fight, then re-syncs with fixture C again: Changes reads "Nothing new from D&D Beyond.", Also set holds the unticked "Wild Shape 1 of 3 left, now 0 of 3", and the one button is Done, which sends nothing and leaves 0 of 3. Re-synced again with the line ticked, Apply leaves 1 of 3.
  - ddbres-3: fixture C2, C with Luck Points raised to 4. The DM spends Breath Weapon while Ana's review is open: the status says Bree changed and an unticked Breath Weapon line appears. Apply lands with Luck Points 4 and the DM's spend kept.
  - ddbres-4: Ana edits Wild Shape to 4 uses, then re-syncs: Kept with Overwrite. Overwrite all, Apply, and Undo gives back 4 uses and the count spent.
  - ddbres-5 (pcstats, step 5's character): the editor's D&D Beyond step with fixture C lists the Class resources group, and Save adds them.
  - ddbres-6: fixture D, 14 limited uses: the cut warning, and the review with 12 resources at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%: `measureAlignment` finds nothing over 1 px, no sideways scroll, and Cy's device never holds the resources.
  - Run resync, pcstats, classresources and reach.
- **FEATURES.md**, the Class resources bullet gains: "Re-sync from D&D Beyond, and the stat block's D&D Beyond import, bring in the class's, species' and feats' limited uses with their counts and rests. A resource added this way takes the uses spent there. For one you already have, the count spent here stays unless you tick D&D Beyond's in the review. Items' charges and spells stay out." The Fill bullet's "It reads numbers, proficiencies, weapons and spells" becomes "numbers, proficiencies, weapons, spells and class resources".
- **docs/dm-guide.md**, in its own voice: the Class resources paragraph (about :1079) gains that a D&D Beyond import or re-sync brings them in, and the Re-sync section (about :1085) gains a short paragraph on the spent lines: "If a player spent a use here that D&D Beyond still shows as unspent, the review lists it unticked under Also set, so a re-sync never hands back a use spent in a fight. Tick it to take D&D Beyond's count."

## 10. Lane plan

One builder, after FU28 lands (it renames Restore in client/features/resources), on its tip:

1. `feat(characters): a sync record and a character update carry class resources`: shared/model.ts (`DdbSync.res`, the comments), shared/protocol.ts (`used?`, `res`, the marker, the expect part, the fill's fields), shared/permissions.ts (`expectValue`'s part), shared/reducer/tokens.ts (`keptResources`), shared/migrate.ts, and their tests. server/rooms/stateSchema.ts takes the record through `ddbSyncForImport`, so it needs no change of its own.
2. `feat(import): the d&d beyond reader reads limited uses as class resources`: shared/ddb/resources.ts and its test (new), read.ts (the call, the warning's words, `read.resource`), shared/rules/pcFill.ts (the types).
3. `feat(rules): a re-sync merges class resources`: shared/rules/resourceSync.ts and its test (new), pcSync.ts (the group, the plan, result, patch, after and undo hooks), pcSync.test.ts and pcSync.random.test.ts, server/rooms/resync.test.ts.
4. `feat(ui): the d&d beyond review lists class resources`: client/features/pcstats/resync.ts, SyncReview.tsx, Resync.tsx, PcStatsEditor.tsx, flow.ts and draft.ts (6.2), client/features/resources/ClassResourcesSection.tsx (the help), and their tests.
5. `test(e2e): class resources from d&d beyond`: the ddbres steps, once the e2e lane lands, and the review's root in alignment.e2e.ts.
6. `docs: class resources from d&d beyond in the feature list, the dm guide and the designs`: FEATURES.md, docs/dm-guide.md, docs/design.md (6's character, 8.1's `expect` parts gaining `resources`, 16.2's Versioning), "Changed by" lines in the combat note's 13.9, the re-sync note's 2.1 and the stat block note's 6.3 and Appendix B (the new paths), and this note's As built. The read.ts header comment names the new file in step 2.

Step 1 touches shared/model.ts, protocol.ts and migrate.ts, so no other lane may take a version pair in between. Nothing here touches client/canvas, the tracker or the bar.

## 11. Decided, with the options rejected

1. **Read limited uses from `actions.class`, `actions.race` and `actions.feat`, with D&D Beyond's own count rule.** Rejected: the class features' own `limitedUse` list, mostly filler with no spent count. Rejected: ddb-importer's formula, which skips the floor of once. Rejected: reading a description for the real period, which is prose.
2. **Class, species and feat uses become resources. Items' charges and spells stay out.** Rejected: items too, which come back at dawn by a roll no rest gives and would fill the 12. Rejected: free spell casts, since spells stay out by the owner's words.
3. **One resource is one item, matched by the record, else by name.** Rejected: field-by-field inside a resource, which needs its parts matched too, and name only with no record, which cannot tell a removal here from one there.
4. **A preset match takes the preset's name and rest, and D&D Beyond's count unless it is under the preset's.** Rejected: D&D Beyond's rest, which turns the 2024 "one back on a Short Rest" into all or none. Rejected: the preset's count always, which drops what feats and items add. Rejected: D&D Beyond's count always, which importers distrust for Lay on Hands and Channel Divinity.
5. **Spent: taken for a new resource, kept for a linked one, with an unticked line when they differ.** Rejected: never, which shows a mid-adventure import as fresh. Rejected: on every re-sync, which hands back a fight's spending. Rejected: three ways with a spent base, which rests and fights move on both sides.
6. **Dawn reads as a Long Rest, with a line. Other is left out.** Rejected: a new dawn rest, which no event in the app gives.
7. **`used` rides on `character.update`, guarded by `expect.resources`.** Rejected: one `actor.use` per spent change, which writes log lines and cannot be one atomic Apply.
8. **The editor's Save expects the resources and rebuilds on a refusal.** Rejected: no `expect`, which lets the editor overwrite a resource another device edited. Rejected: resources from Re-sync only, which makes a first import two steps.
9. **A fixed table of D&D Beyond's own names for three pool presets.** Rejected: none, which brings Lay on Hands in as "Lay On Hands: Healing Pool", maybe a count. Rejected: loose aliases or fuzzy names, which could merge two features.
10. **A fixed cost above 1 comes in as a pool of units, with the cost line** (D-261024-34). Rejected: a count, which spends 1 a tap. Rejected: skipping it, which loses a real resource. Rejected: a count of max ÷ cost, which spent units that are not a multiple cannot map.
11. **Up to 12, cut in the read's order, with a warning.** Rejected: reading more and picking, which loosens the reader's bounds.
12. **One feature, one resource (2.1)**, by its source ids, then one name in one class by the highest feature level. Rejected: one per action, which makes three Bardic Inspirations. Rejected: one per name, which merges a multiclass's two Channel Divinities.
13. **A class feature's key holds its class.** Rejected: "#2" across classes, which moves when a class is gained (OP-3), and `preset` in `h`, which would list a class change as D&D Beyond's.
14. **Only `resetType` 4, a base of 0 or -1 with nothing else, and a count under 1 are left out with the read whole.** Rejected: every left-out entry keeping it whole, which lets a format change remove a linked resource (OP-1, OP-2).
15. **A removed resource added again by hand links in place of its marker.** Rejected: keeping the marker, which offers Add it back beside the new one and doubles it under Overwrite all (OP-7).
16. **A 2014 character's counts rise to the preset's, with the Check it line** (D-261024-30). Rejected: keeping D&D Beyond's lower 2014 count, since the app plays by SRD 5.2.1. D-261024-30 also records that the read takes actions, not class features' own data.

## 12. As built

The builder fills this in the lane's docs commit with every place the build went its own way.
