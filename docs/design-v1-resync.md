# raccoon-vtt v1: re-sync from D&D Beyond

Status: draft 2, revised for design review round 1 (findings RS-O, RS-ASTRA and RS-UX) with the coordinator's decisions, which section 7 lists. Code is cited from main at `09651fbc7`. It builds on docs/design-v1-pc-stats.md ("the stat block note"), whose section 6 fills a block from D&D Beyond, and follows docs/design-v1-look-pass.md for every screen.

The project owner, 2026-10-22: "Another useful feature would be to have a "re-sync charcter sheet" feature that allows someone to re-sync their stats and spells from an existing sync. As part of this we should keep track of manual changes that were made to stats and other static values (such as spell casting ability, my druid is a charisma caster for examples), and note that these were not changed on the resync, while giving the option to overwrite them if desired. I'll let you come up with where this should live and the design but I think it should be pretty simple given the new data from dnd beyond just has to be "merged" intelligently."

## 0. Today and the answer in short

**Today.** The stat block editor's "Fill from" D&D Beyond step fetches a public character through `POST /api/rooms/:id/ddb-import`, reads it with `readDdbCharacter` (shared/ddb/read.ts) and reviews it ("Check what was read") before Use it fills the draft and Save sends one `character.update`. `mergeFill` (shared/rules/pcFill.ts:64) replaces every part it read, drops the rolls marked `ddb` and keeps the rest. `alsoLines` (client/features/pcstats/fill.ts:37) ticks level, AC, max HP, Speed and senses on, and the name off. Nothing remembers what the import set, so a Spellcasting ability changed by hand is replaced on the next import. The reader also fills a missing source with defaults: no classes reads as level 1, no modifiers as no proficiencies (read.ts:401-449).

**The answer.**

- **Where.** "Re-sync from D&D Beyond", beside Edit in the Stat block group, which the token panel and the character's page share. It fetches, reviews, applies in one op, and offers Undo. The editor's D&D Beyond step shares the merge.
- **The record.** `Character.ddbSync` keeps what the last sync read: a value per field and a pair of hashes per roll. About 2.6 KB for 40 rolls, at most 4,630 bytes, under a 6 KiB cap.
- **The merge.** Three ways, per field and per roll: what only D&D Beyond changed comes in, what the player changed is kept with Overwrite, and Overwrite all takes D&D Beyond's for every kept item. Level, Max HP, AC, Speed and senses keep today's ticks.
- **Safety.** The reader leaves out what it could not read, Apply and Undo carry a precondition the server checks, and Undo restores the exact HP.
- **Versions.** The next free op and snapshot pair, both, with identity steps. The route and its budgets are unchanged.

## 1. Where it lives and the flow

### 1.1 Surfaces

- **The Re-sync button** joins the Stat block group's row under the block (`PcStatBlock.tsx:88-92`), after Edit, as a `SmallButton` with `wrap`. The token panel and the character's page share that group. It is for the DM and the character's players (`editsPcStats`, today's import rights). It shows when the character has a block and a D&D Beyond number: the sheet link's digits when it is a D&D Beyond link (`ddbCharacterId`), else the record's `from`. On a phone the group starts folded (look pass 3.2), so the first time it is two taps. Under the row, with a record: "Last synced from D&D Beyond on Oct 20.", with the year when it is not this year, by `sessionLabel`'s rule (client/features/log/exportLog.ts:20).
- **In a shape** the group keeps the same row, so Re-sync is there too (AC and Speed, 2.3).
- **The editor's D&D Beyond step** keeps its link field, Get it, pasted JSON and its review's title, "Check what was read". With no record it fills, as today's import does, and its review adds "Replaces your changes": each value of the block it would replace, with an unticked "Keep mine" (3.3). With a record it runs the dialog's three-way merge, so a kept change stays unless overwritten. Use it fills the draft, and Save sends the record with the block. The "Save also sets …" line stays (PcStatsEditor.tsx:360).
- **Paste text** keeps today's review (its Also set ticks and `fillSummary`) and writes no record, since pasted text is the player's own. **Not here:** the tracker row, the action bar and the token window, since a re-sync is done between sessions.

### 1.2 The steps

1. **Start.** The button opens the dialog "Re-sync Bree" and fetches at once, one request per press. It spends one of the hourly 20 a session has, as Get it does.
2. **Fetch.** `Loading` "Getting Bree from D&D Beyond…" after the shared 200 ms delay, the primary busy as "Getting it…". Cancel and closing abort it (flow.ts's rule).
3. **Review**, titled "Check what changes" (3.3). It follows the live character. When another device changes Bree while it is open, its lists rebuild and its status says so (3.3).
4. **Apply** sends one `character.update` with the merged parts and an `expect` of each part it writes, busy as "Applying…". The server refuses it when any of those parts changed since (4). On `taken` the dialog shows the done state.
5. **Undo the re-sync**, in the done state until the dialog closes, puts back each part and field the re-sync wrote, the exact HP and the record before it, under its own `expect` of what Apply wrote. The DM's re-sync is also on the DM's undo stack.

### 1.3 Characters in each state

| The character | Re-sync | The editor's D&D Beyond step |
| --- | --- | --- |
| No block | no button: "Add a stat block", then the editor | a first sync: everything read comes in, today's review |
| A block, no D&D Beyond number | no button | as with no record |
| A block, no record, with a D&D Beyond link (imported before this feature, or typed) | the no-record review: each difference kept, grouped, with Take these and Overwrite all (2.2) | fills, with "Replaces your changes" |
| Synced before, same number | three ways (2.2 to 2.4) | three ways |
| The sheet link names another number than `from` | a new source with no record: the read line says "This is a different character from the last sync, so nothing is compared with it." | as with no record |

With no record a D&D Beyond roll the block lacks comes in, one the player deleted after an old import included, since nothing records the deletion (2.4).

**Failures** keep today's words (stat block note, Appendix D): `private`, `not_found`, `fetch_failed` (with a timeout or 15 s on the device), `unreadable`, `busy` and the hourly `quota_*`. Each keeps the dialog open on the D&D Beyond step (3.2). **D&D Beyond's format changing** shows three ways: `unreadable` when the body does not read, parts left out with a warning when a source is missing (2.5), and the losses warning when a read takes much away (3.3).

## 2. The merge (`shared/rules/pcSync.ts`)

### 2.1 The record

```ts
// Character gains ddbSync?: DdbSync, beside stats and knownForms
type DdbSync = {
  at: string                // the envelope time of the op that wrote it, set by the reducer when the patch has none
  from?: string             // the D&D Beyond character number, 1 to 12 digits
  base: DdbBase             // what D&D Beyond said at that sync, for each field it read
  rolls: Record<string, { k: string, h: string }>   // one entry per synced roll in the block, keyed by a hash of its id, at most 40
  gone?: string[]           // the k of each roll the player removed that D&D Beyond still had, at most 40
}
type DdbBase = Omit<PcFillStats, 'rolls'> & { level?: number, ac?: number, hpMax?: number, speeds?: Actor['speeds'], senses?: string }
```

- Every hash is the first 12 hex digits of `hash128` (shared/project.ts:1989). An entry's key is the hash of the roll's id, so ids in any characters cost 12 bytes. **`k`** hashes the roll's key: its kind's letter, its name in lower case with spaces collapsed and a spell's level, as "w:longsword" or "s:fireball:3", with "#2" on the second of two alike in the read's order. The reader makes new ids on every read, so the key finds a roll again.
- **`h` is D&D Beyond's content, never the block's.** Every entry a sync writes takes `h` = the hash of D&D Beyond's roll as that sync read it, whether the roll was taken, kept, overwritten or added back. The content is `stableStringify` of the roll without `id`, `ddb` and `save.onPass`. So a kept roll reads as the player's change on every later sync, and a field's base works the same way (2.2).
- **No name in the base.** The name is always an offer (2.3) and its base is never read.
- **Size**, counted in UTF-8 as `serializedBytes` counts (Appendix A): 367 bytes for a typical base, 54 per roll, 2,640 for 40 rolls. Every string in the record is hex, digits, the time or a fixed ASCII word, except senses (80 units, at most 240 bytes). So 4,630 bytes is the most a valid record holds, under `LIMITS.ddbSyncBytes`, 6 KiB. The review still checks the finished record, its `at` included, before it enables Apply (3.3).

### 2.2 The three-way rule for a field

`b` is the record's base for the field, `c` the character now, `n` D&D Beyond now. An absent value ("none", 0 for a bonus, off for a flag) is a value. A part the fill left out is not read.

| Base | The player changed it (`c` ≠ `b`) | D&D Beyond changed it (`n` ≠ `b`) | Outcome | Listed under |
| --- | --- | --- | --- | --- |
| any | any | not read | nothing, `b` kept | none |
| `b` | no | no | nothing | none |
| `b` | no | yes | takes `n` | Changes from D&D Beyond |
| `b` | yes | no | keeps `c` | Your changes, kept |
| `b` | yes | yes, to `c` | nothing, both reached it | none |
| `b` | yes | yes, to another value | keeps `c` | Your changes, kept, tagged "Also changed in D&D Beyond" |
| none, and the character has no block | | | takes `n` (a first sync) | Changes from D&D Beyond |
| none (no record, or none for this field), with a block | `c` = `n` | | nothing | none |
| none, with a block | `c` ≠ `n` | | keeps `c` | Different from D&D Beyond. In the editor: takes `n`, under Replaces your changes |

- **The five ticked fields.** Level, Max HP, AC, Speed and Senses keep today's tick. A kept one (`c` ≠ `b`) follows the table, under Your changes, kept. Otherwise, whenever `n` ≠ `c`, with a record or without, its line is under Also set, ticked. Unticking keeps `c`. A field never shows in both sections.
- **Overwrite** on a kept or different item takes `n`, and "Keep mine" in the editor keeps `c`. Nothing else changes a value the player set.
- **After Apply** (or Use it, then Save) the base of every read field is `n`, whether it was taken, kept or unticked. An unread field keeps its old base. So a kept Charisma is listed again on every later re-sync, and a later change in D&D Beyond shows as "also changed".
- **"Manual" is by value.** A field is the player's change while it differs from the base, from any surface (the editor, the light card, the panel's Stats, the HP entry's maximum). Edited back to the base, it is untouched again.
- **Lists compare as sets.** Saves compare by membership and are written in `ABILITY_KEYS` order, so a part that did not change is never sent (`statsPatch` compares arrays in order, draft.ts:102).

### 2.3 Each field

| Field | One field per | Notes |
| --- | --- | --- |
| Ability scores | ability | |
| Save proficiencies | ability: proficient or not | |
| Skills | skill: none, Proficient or Expertise | Expertise is the skill's own value |
| Jack of All Trades, Alert, Evasion, Critical hits on | each | |
| Bonuses (`adjust`) | key: each save, each skill, all saves, all checks, Initiative, Passive Perception, spell save DC, spell attack | a typed total stores its difference (stat block note 3.3), so it is a bonus here |
| Spellcasting ability | one | the request's example: a druid set to Charisma by hand is kept and offered Overwrite |
| Defenses | damage type: none, Resistant, Immune or Vulnerable | |
| Level, Max HP, AC, Speed, Senses | one each | the ticked lines. Speed merges per kind (walk, fly, swim, climb, burrow) on one line and never touches Hover, which today's fill drops |
| AC and Speed in a shape | | **not read**: no line, base unchanged, Undo leaves them alone. The actor holds the creature's and `unshaped` the character's (W7B-P-9), so a re-sync after the shape ends compares them |
| Name | one | not in the base: always the last line of Also set, unticked, as today |
| Sheet link | none | set only when the character has none, as today |

**Max HP** comes in by the companion design's rule (docs/design-v1-companion-stat-blocks.md 5.2), as `alsoPatch` does (fill.ts:79): a living character at its maximum stays at its new maximum, and any other keeps its HP, cut to the maximum if higher. It never brings a character back or puts one down, and never sets Temporary HP. **Undo is exact:** it sends the current and maximum HP from before, since the rule run backwards would not give them back (35 of 38 becomes 30 of 30 when the maximum drops to 30).

### 2.4 Rolls

A block roll is **linked** when the record has an entry for its id. With a record, matching reads the record and ignores `ddb`. A `ddb` roll with no entry counts as the player's own. With no record, a `ddb` roll counts as linked and untouched, by key.

| Case | Record | Block | D&D Beyond | Outcome | Listed |
| --- | --- | --- | --- | --- | --- |
| D&D Beyond added it | no entry, not in `gone` | no unlinked roll with its key | has it | added with `ddb` | Changes: "Adds Moonbeam (level 2): …" |
| Removed there, untouched | entry | content = `h` | gone, its kind read whole | removed | Changes: "Removes Shortbow" |
| Removed there, edited | entry | content ≠ `h` | gone, its kind read whole | kept, entry dropped, so it is the player's own | Kept: "D&D Beyond no longer has it.", Remove it |
| Its kind not read whole (2.5) | entry | any | missing | kept, entry kept | none |
| Changed there, untouched | entry | = `h` | ≠ `h` | updated in place, id kept | Changes: "Updates Shillelagh: …, now …" |
| The player edited it | entry | ≠ `h` | = `h` | kept | Kept, Overwrite |
| Both changed it | entry | ≠ `h` | ≠ `h` and ≠ the block's | kept | Kept, tagged, Overwrite |
| Both reached the same | entry | ≠ `h` | = the block's | nothing | none |
| The player deleted it | entry, no roll with that id | | has it | stays deleted, its `k` into `gone` | Kept: "Shortbow: you removed it.", Add it back |
| Deleted, and listed in `gone` | `gone` | | has it, or not | stays deleted, or leaves `gone` | as the row above, or none |
| The player made it | no entry | no key match | | kept, never recorded | "Keeps your 2 own rolls." |
| The player made one of the same name | no entry | an unlinked roll with the key | has it | linked. Contents alike: nothing else. Else kept | Kept or Different, Overwrite. In the editor with no record: Replaces your changes |
| No room in the block | | 40 rolls | more than fit | left out and not recorded | Check these: "3 rolls from D&D Beyond did not fit, since a block holds 40. They come in once there is room." |

Overwrite and Add it back put D&D Beyond's roll in with `ddb`, so the editor's "(from D&D Beyond)" tag reads them. Overwrite keeps the roll's id. Add it back takes the read's new id. An update keeps the block's `onPass` only while the new roll still has a save. One roll is one item: a part-by-part merge inside a roll would need its parts matched too.

### 2.5 The reader: what it reads, and what it leaves out

Build step 2 changes `readDdbCharacter` so a missing or mistyped source leaves its parts out, rather than reading as empty:

| Source | Read when | When not, left out (and they stay as they are) |
| --- | --- | --- |
| `stats` | all six scores | the whole read: `unreadable`, as today |
| `classes` | an array with at least one class whose `definition` is an object and whose `level` is a number | level, Spellcasting ability, Critical hits on, Evasion, weapons and spells (Sneak Attack and a cantrip's dice need the classes), and max HP but an override |
| `modifiers` | an object | ability scores, save and skill proficiencies, bonuses, defenses, Jack of All Trades, Alert, AC, and max HP but an override |
| `inventory` | an array | AC and weapons |
| `classSpells` and `spells` | an array and an object | spells |
| `actions` | an object | other rolls |
| Speed, senses, name, sheet link | as today | as today |

- **Read marks.** `PcFill` gains `read?: { weapon: boolean, spell: boolean, other: boolean }`, true when that kind was read whole. The protocol's `pcFill` schema takes it. Absent reads as all true, as a pasted-text fill is.
- **The 40-roll cut stays.** The reader still keeps the first 40 of weapons, spells, then actions, so the fill and the record stay within 40 (`pcParts.rolls`). Every kind that lost a roll to the cut is marked false, so a cut read never removes a linked roll of it.
- **Its warnings**, under Check these: "D&D Beyond sent no classes, so the level, spellcasting, class features, weapons and spells were not read. They stay as they are.", in the same form for modifiers ("the scores, proficiencies, bonuses, defenses, AC and max HP"), the inventory ("AC and weapons"), the spell lists ("spells") and actions ("other rolls"). The cut: "D&D Beyond has 6 more rolls for Bree than the 40 that are read, so those were not read. Rolls here that they would change stay as they are." The AC warning leaves the list and becomes the AC line's help (3.3).

## 3. UI/UX

Every screen is the dialog shell (components/Dialog.tsx): the whole screen below 600 layout px ("fill", as the editor), a centered card from 600 (width `lg`, 720 px). So a phone held sideways (844 x 390) and a tablet get the card. Titles: the dialog's states are "Re-sync Bree", "Check what changes", "Bree is re-synced" and "Re-sync undone". The editor's review keeps "Check what was read". The parts are the fill review's and the panel kit's: `SectionLabel`, `Checkbox`, `Tag`, `Notice`, `Help`, and `Row` with `expanded` in a `RowList` for a group, the look pass's item level (2.6). So no fold sits inside a section of the same look, and the only headings are the sections' h3s. Bree is Ana's level 5 druid in the examples.

### 3.1 The entry point

```
 phone 390 x 844, token panel sheet          desktop 1440 x 900, side panel (380 px)
+--------------------------------------+    +-----------------------------------+
| (B) Bree                           x |    | (B) Bree                          |
|     Level 5 character . Medium (5 ft)|    |     Level 5 character . Medium    |
|     [15]  30 ft  PP 15  Init +2 Sheet|    |     [15]  30 ft  PP 15  Init +2   |
| v Stat block          [Take a shape] |    | v Stat block      [Take a shape]  |
|   ...the block, as today...          |    |   ...the block, as today...       |
|   [Edit] [Re-sync from D&D Beyond]   |    |   [Edit] [Re-sync from D&D Beyond]|
|   Last synced from D&D Beyond on     |    |   Last synced from D&D Beyond on  |
|   Oct 20.                            |    |   Oct 20.                         |
| > Combat                HP 20/38     |    | > Combat              HP 20/38    |
+--------------------------------------+    +-----------------------------------+
```

At 360 px the two buttons share a line (about 262 px of 328). At 130% or larger text Re-sync wraps under Edit, and its words wrap inside it. Both are 44 px on touch.

### 3.2 Fetching, and each fetch error

```
 phone 390 x 844: fetching                   an error, here private (DdbStep as it is)
+--------------------------------------+    +--------------------------------------+
| Re-sync Bree                       x |    | Re-sync Bree                       x |
|--------------------------------------|    |--------------------------------------|
| (o) Getting Bree from D&D Beyond…    |    | The character must be Public in D&D  |
|                                      |    | Beyond. The import reads numbers ... |
|                                      |    | Share link or character number       |
|                                      |    | [dndbeyond.com/characters/12345678]  |
|                                      |    | ! D&D Beyond would not share that    |
|                                      |    |   character. Set its privacy to      |
|                                      |    |   Public in D&D Beyond, then try     |
|                                      |    |   again, or paste its JSON.          |
|                                      |    | Open its data in D&D Beyond  ->      |
|                                      |    | [Paste its JSON instead]             |
|--------------------------------------|    |--------------------------------------|
| [Cancel]              [Getting it…]  |    | [Cancel]                   [Get it]  |
+--------------------------------------+    +--------------------------------------+
```

An error shows `DdbStep` as it is: its Help, the field prefilled with the link fetched, then the error's danger `Notice` (`role="alert"`) in today's words, the data link and pasted JSON. Each code's words: `private`, `not_found`, `fetch_failed` (whose Get it reads Try again), `unreadable`, `busy`, and the quota's "Too many imports this hour. Try again in 12 minutes, or paste the character's JSON." Read it on pasted JSON goes to the review, whose Back is "Back to the D&D Beyond link".

### 3.3 The review

```
 phone 390 x 844, Re-sync after a level-up, Bree hurt
+--------------------------------------+
| <  Check what changes              x |
|--------------------------------------|
| Read from D&D Beyond: Bree Tallow,   |
| level 6. Last synced on Oct 20.      |
| CHECK THESE                          |
| Whether a pass halves the damage ... |
| CHANGES FROM D&D BEYOND (4)          |
|   Wisdom 18, now 16                  |
|   Perception: Expertise, now         |
|   Proficient                         |
|   Adds Moonbeam (level 2): DC 15     |
|   Constitution save, 2d10 Radiant    |
|   Removes Sling                      |
| ALSO SET                             |
| [x] Level 6, now 5                   |
| [x] Max HP 45, now 38                |
|     Bree keeps 20 HP, now of 45.     |
| [ ] Name Bree Tallow, now Bree       |
| YOUR CHANGES, KEPT (2)               |
|                      [Overwrite all] |
|   Shillelagh, as you changed it:     |
|   +6 to hit, 1d8+3 Bludgeoning       |
|   [Also changed in D&D Beyond]       |
|   D&D Beyond says +6 to hit, 1d10+3  |
|   Bludgeoning.                       |
|   [ ] Overwrite with D&D Beyond's    |
|   Spellcasting ability: Charisma     |
|   D&D Beyond says Wisdom.            |
|   [ ] Overwrite with Wisdom          |
| Keeps your 2 own rolls.              |
|--------------------------------------|
| [Cancel]                    [Apply]  |
+--------------------------------------+
```

- **Order:** the read line, Check these, Changes from D&D Beyond, Also set, then Your changes, kept, Different from D&D Beyond or Replaces your changes, then one muted line for own rolls.
- **The read line** is today's (`readLine`) plus "Last synced on Oct 20." (with the year when it is not this year), or, for a relinked character, "This is a different character from the last sync, so nothing is compared with it."
- **Check these** holds the reader's warnings (2.5), rolls that did not fit, and two checks of the review's own:
  - In a shape: "AC and Speed are not compared while Bree is in Wild Shape. Re-sync after the shape ends to update them." ("in a shape" for another one).
  - A proficiency coming in beside a kept bonus on the same save or skill: "Stealth gets proficiency from D&D Beyond and keeps your +3 bonus, so it rolls +8. Overwrite the bonus if it stood for the proficiency."
- **The losses warning** is a warning `Notice` above the lists. It shows when a read lowers the level, takes away the Spellcasting ability, or takes away 6 or more proficiencies, defenses or rolls that are at least half of those synced: "This lowers Bree's level from 6 to 1 and takes away 14 proficiencies. If that is not what changed in D&D Beyond, its format may have changed. Cancel, and check the character there."
- **Changes from D&D Beyond** are plain lines, with no tick, in this order of groups: Ability scores, Saves and skills, Bonuses, Spellcasting, Features, Defenses, Rolls. Each says the new value, then "now" and the current one, as today's review does:
  - "Wisdom 18, now 16", "Dexterity save: Proficient, now not proficient", "Stealth: Proficient, now not proficient", "Perception bonus +2, now +0", "Fire: Resistant, now none", "Critical hits on 19 and 20, now 20".
  - A roll's line is the view's reading (`rollReading`, client/features/pcstats/reading.ts): "Adds Fire Bolt: +5 to hit, 2d10 Fire", "Updates Longsword, +1: +6 to hit, 1d8+4 Slashing, now +5 to hit, 1d8+3 Slashing", "Removes Shortbow".
  - On a first sync (no block) a line leaves out ", now …": "Strength 8".
- **Also set** is today's section, never folded: one `Checkbox` per line, ticked, in today's words ("Level 6, now 5", "AC 16, now 15", "Speed 35 ft, fly 30 ft, now 30 ft", "Senses Darkvision 60 ft, now none", "Sheet link dndbeyond.com/characters/12345678"), the name last and unticked. Two lines carry `help`: AC, "Worked out from the armor. Check it.", and Max HP, "Bree is unhurt and stays at full HP: 45 of 45." or "Bree keeps 20 HP, now of 45.".
- **Your changes, kept** is never folded. Conflicts come first. Each row is a group named by its first line (`role="group"`, `aria-labelledby`), and holds four things. First its value now, as "Spellcasting ability: Charisma" or "Shillelagh, as you changed it: +6 to hit, 1d8+3 Bludgeoning". On a conflict, the `Tag` "Also changed in D&D Beyond", tone warning, with `cut="100%"`. Then D&D Beyond's value, "D&D Beyond says Wisdom.", or on a conflict "D&D Beyond now says Wisdom. At the last sync it said Intelligence.", a roll in its full reading. Last its `Checkbox`, unticked: "Overwrite with Wisdom", "Overwrite with D&D Beyond's", "Remove it" or "Add it back".
- **Different from D&D Beyond** (no record, a relinked character, or a field with no base) starts with: "Bree has no record of a past sync, so a change of yours cannot be told from one in D&D Beyond. What differs stays as it is unless you overwrite it." Its rows are grouped by Changes' groups. Each group is a `Row` with `expanded`: the title is the group ("Ability scores"), and the detail is its summary, "3: Wisdom 16, D&D Beyond says 18, and 2 more". Beside the row, outside its button, sits a "Take these" toggle, which wraps under the row when the line is narrow. Without a base no row is a conflict, so past 10 rows in all every group starts folded. At 10 or fewer every group is open. The rows inside read as kept rows do.
- **Replaces your changes** is the editor's, with no record. One line per difference: "Spellcasting ability: Charisma, becomes Wisdom", each with an unticked "Keep mine". Its label action is "Keep all of yours". Past 10 lines it groups as Different does, every group folded.
- **The bulk buttons** ("Overwrite all", "Take these", "Keep all of yours") are secondary `sm` toggles with a fixed name and `aria-pressed`, pressed while every row they cover is ticked. Overwrite all also covers Remove it and Add it back.
- **A long list** stays readable on a phone. Every line wraps at 14 px, never a table, and the footer stays in view. Past 10 lines, Changes groups as Different does: "Rolls", detail "40: Adds Longsword, and 39 more", every group folded. So 40 new rolls take one row. Summaries wrap, never cut. The kept list and Also set never fold.
- **Too big:** a block past 12 KiB or a record past 6 KiB is refused before Apply, as a danger `Notice` above the footer, with Apply disabled: "This would make Bree's stat block 12.4 KiB of the 12 KiB it may hold. Remove a few of your own rolls first." or "Bree's sync record would be too large to save. Remove a few rolls first."
- **Nothing new:** when no part, field or record would change, Changes reads "Nothing new from D&D Beyond.", and the kept rows still list. Cancel goes, and the one button is Done until a row is ticked, when it is Apply. Done sends nothing. In the editor the footer stays Back and Use it, and Use it returns to the draft unchanged.
- **A live change:** when another device changes Bree while the review is open, the lists rebuild, and the dialog's status says "Bree changed on another device. The lists show the latest." It adds "Choices on lines that went away were dropped." when a tick was dropped.

```
 phone 360 x 780, Re-sync with no record         phone 390 x 844, the editor's Fill, no record
+----------------------------------+            +--------------------------------------+
| <  Check what changes          x |            | <  Check what was read             x |
|----------------------------------|            |--------------------------------------|
| Read from D&D Beyond: Bree       |            | Read from D&D Beyond: Bree Tallow,   |
| Tallow, level 6.                 |            | level 5.                             |
| CHANGES FROM D&D BEYOND (1)      |            | CHANGES FROM D&D BEYOND (2)          |
|   Adds Moonbeam (level 2): ...   |            |   Adds Longsword: +5 to hit, ...     |
| ALSO SET                         |            |   Adds Shortbow: +5 to hit, ...      |
| [x] Level 6, now 5               |            | ALSO SET                             |
| [x] AC 16, now 15                |            | [x] AC 16, now 15                    |
|     Worked out from the armor.   |            |     Worked out from the armor.       |
|     Check it.                    |            |     Check it.                        |
| DIFFERENT FROM D&D BEYOND (14)   |            | [ ] Name Bree Tallow, now Bree       |
|                  [Overwrite all] |            | REPLACES YOUR CHANGES (3)            |
| Bree has no record of a past ... |            |                 [Keep all of yours]  |
|  Ability scores               >  |            |   Spellcasting ability: Charisma,    |
|  3: Wisdom 16, D&D Beyond says   |            |   becomes Wisdom                     |
|  18, and 2 more   [Take these]   |            |   [ ] Keep mine                      |
|  Saves and skills             >  |            |   Stealth: Expertise, becomes        |
|  9: Arcana Proficient, ...       |            |   Proficient                         |
|                   [Take these]   |            |   [ ] Keep mine                      |
|  Rolls                        >  |            |   ...                                |
|  2: Longsword, your own ...      |            |--------------------------------------|
|                   [Take these]   |            | [Back]                     [Use it]  |
|----------------------------------|            +--------------------------------------+
| [Cancel]                [Apply]  |
+----------------------------------+
```

```
 phone 844 x 390 and tablet or desktop: the card, 720 wide (sideways, the body scrolls about 4 lines)
+----------------------------------------------------------------+
| <  Check what changes                                        x |
|----------------------------------------------------------------|
| YOUR CHANGES, KEPT (2)                         [Overwrite all] |
|   Spellcasting ability: Charisma                               |
|   D&D Beyond says Wisdom.           [ ] Overwrite with Wisdom  |
|----------------------------------------------------------------|
| [Cancel]                                              [Apply]  |
+----------------------------------------------------------------+
```

From 600 px a kept row's checkbox sits beside its D&D Beyond line where both fit, else under it. A tablet held upright keeps panels as 560 px sheets (look pass 2.8), so the entry point looks as on a phone, and the dialog is the card.

### 3.4 Apply, done and Undo

```
+--------------------------------------+    +--------------------------------------+
| Bree is re-synced                  x |    | Re-sync undone                     x |
|--------------------------------------|    |--------------------------------------|
| (v) 6 changes came in, and 2 of your |    | (v) Bree is as before the re-sync.   |
|     changes stayed.                  |    |                                      |
|--------------------------------------|    |--------------------------------------|
| [Undo the re-sync]           [Done]  |    |                              [Done]  |
+--------------------------------------+    +--------------------------------------+
```

- Apply is busy as "Applying…", refuses a second tap, and holds the review still while it waits. The done line counts Overwrites with what came in, and removals and restores apart. Examples: "1 change came in.", "6 changes came in, 1 roll was removed, 1 came back, and 2 of your changes stayed." It leaves out a part that is 0. Lines unticked in Also set count as kept.
- Undo is busy as "Undoing…". When the character no longer holds what the re-sync wrote, it is disabled with `Help`: "Bree changed after the re-sync, so it cannot be undone here." Done or closing ends the dialog, and focus returns to Re-sync.

### 3.5 Every error after the fetch

| When | Shows | Then |
| --- | --- | --- |
| Stale: the server's `expect` check failed | "Bree changed on another device before this applied, so nothing changed. Check the review again." as a danger `Notice` | the review rebuilds from the live character, keeps the ticks whose lines remain, and Apply stays enabled |
| Another refusal | "Not re-synced: " and the server's words | the review and its ticks stay |
| The bucket (`BLOCK_SAVES_TOO_FAST`) | its words, and "You can apply again in a few seconds." as the status | Apply disabled for the refill, as the editor's Save |
| The room too full | `BLOCKS_ROOM_TOO_FULL`'s words | as a refusal |
| `unknown` | "The connection dropped before the server answered. Check Bree's stat block before re-syncing again." | the review stays |
| An answer after closing | a toast: "Bree was not re-synced. <Reason>." or "The connection dropped before the server answered, so Bree may not have been re-synced. Check the stat block." | |
| Deleted, or no longer the viewer's | a warning `Notice`: "This character was deleted or is no longer yours, so it cannot be re-synced." | Apply disabled |
| Undo stale | the Help line of 3.4 | Undo disabled |
| Undo refused or lost | "Not undone: " and the words, or the `unknown` line with "undoing" | Undo stays while it still applies |
| View as a player | the preview's own refusal, as the editor's Save gets | nothing is sent |

### 3.6 Keys, focus, screen readers and reach

- **Keys:** none added or changed. The dialog shell's keys hold, Space ticks a checkbox, and Enter in the link field is Get it. The shortcut sheet and FEATURES.md's Shortcuts do not change.
- **Focus:** the shell's step focus (`useStepFocus`, Dialog.tsx:274) focuses the dialog itself, which reads its title, only when focus fell to the page. A control that survives a change keeps focus. So this dialog adds one rule. When an answer changes the state (the review arrives, Apply or Undo lands, a stale refusal rebuilds), and focus is on the dialog itself or on a control the change removed, focus goes to the new state's first line, with `tabIndex={-1}`. A surviving control keeps focus, and the change is heard from the status: the done line is `role="status"`, a refusal is an alert, and the live-change line is the status. Closing returns focus to Re-sync.
- **Names:** the button's name is its words. A kept row is a group named by its first line, so a reader hears "Spellcasting ability: Charisma, group" before "Overwrite with Wisdom, checkbox". A group's `Row` is a disclosure named by its title, with the summary as its description. "Take these" is named "Take these: Ability scores".
- **Reach:** every button, checkbox row, row and link is at least 44 px on touch, fields are 16 px, and nothing needs hover or long-press.

## 4. Data, protocol and versions

- **Model:** `Character.ddbSync?: DdbSync` (2.1). `PcRoll.ddb`'s comment becomes: "Made by a D&D Beyond import or re-sync. Without a sync record, editing the roll makes it the player's own. With one, the record decides (docs/design-v1-resync.md 2.4)."
- **Protocol:** `character.update` gains two fields:
  - `ddbSync: DdbSyncPatch | null` in its patch: the record whole, `at` optional. `ddbSyncSchema` bounds it: the base by the fill's part schemas (`pcFill`), `from` 1 to 12 digits, keys, `k`, `h` and `gone` as 12 lower-case hex digits, at most 40 entries and 40 in `gone`, `at` an ISO time, and 6 KiB serialized.
  - `expect`, beside the patch: `Partial<Record<ExpectPart, string>>`, a 12-hex hash of each part or field the patch writes, as the sender sees it, with an absent value hashed as null. `ExpectPart` lists each stats part (`stats.abilities` and so on, one per part `PcStatsPatch` names), `level`, `name`, `actor.ac`, `actor.speeds`, `actor.senses`, `actor.sheetUrl`, `actor.hp` (current and maximum), and `ddbSync`.
  - `pcFill` gains `read` (2.5). `character.create` takes neither.
- **The precondition** is checked live in `canApply` (shared/permissions.ts), against the staged state, and never in the reducer. So replay never runs it, and a later migration of a stored value cannot stop a room's load. Each hash covers one part the player's own projection holds whole. It never covers the whole character or actor, since owners lack `dmNotes`, `monsterId` and hidden effects (project.ts:554). So no player's Apply is refused for a DM's change, and a refusal tells nothing about one. Any mismatch refuses with one code, `invalid`, and one message whatever differed: `CHARACTER_CHANGED` in shared/limits.ts, which the dialog recognizes, as the editor recognizes `BLOCK_SAVES_TOO_FAST`.
- **Who sends `expect`:** the dialog's Apply, over what the review saw, and its Undo, over the character as the view holds it once Apply was taken. The editor's Save keeps today's rule, where a later save wins.
- **Reducer** (`characterUpdate`, shared/reducer/tokens.ts:527): stores the record as sent, sets `at` from the envelope when the patch has none, refuses a record past 6 KiB with `quota`, and deletes the record with `stats: null`, since its base then describes no block. A record may name a roll the block no longer holds. Replay applies the stored record with the stored envelope's time, so it needs no gate.
- **Permissions and the bucket:** `OWNER_CHARACTER_FIELDS` gains `ddbSync`, on the server and in the client mirror (client/features/tokens/access.ts:53). Other players get `NOT_YOURS`. In server/rooms/actor.ts both `writesPcStats` (:234, the bucket) and `savesPcStats` (:247, the block's words at :969 and :1148) count a patch naming `ddbSync`. So every Apply and Undo spends one and reads in the block's words. A forged record changes only how its own character's next re-sync is listed.
- **Projection:** no change. `projectCharacter` (shared/project.ts:647) gives the DM and the character's players the character whole, and others a fixed list without `stats` or `ddbSync`. A test pins it, since the merge runs on the device. The table display never receives it.
- **Undo labels** (server/rooms/undoLabels.ts:123-129) key on `ddbSync`, before `stats`, with `quoted(name, "a character")`. A sync's patch never carries `at`, since the server writes it. A patch whose `ddbSync` has no `at` is "re-syncing Bree from D&D Beyond", which covers Apply and the editor's Save after a D&D Beyond fill. One whose `ddbSync` carries `at`, or is null, is "undoing Bree's re-sync". A restore puts back the whole character. A player's stack holds no character edit (stat block note 4.1), so a player undoes in the dialog.
- **Export and import:** `room.json` carries the record. `server/rooms/stateSchema.ts:289`'s character takes it through `ddbSyncForImport`. Entries are keyed by hashes of block-local roll ids, which remap leaves alone, so a restored backup keeps syncing three ways.
- **Limits:** `LIMITS.ddbSyncBytes` 6 KiB, on its own line at the end of its group. A character at both caps is under 17 KiB. 50 of them are under 850 KiB of a DM's 3 MiB projected scene.
- **The route** keeps its code and budgets: one fetch per press, today's fill with `read` added. The merge needs the record, which the device holds.
- **Versions** (shared/migrate.ts, design 16.2): an older build's strict schemas refuse the new fields in a snapshot and in an op, so this takes the next free op and snapshot pair at build time, both: OP 16 and SNAPSHOT 20 once attach (14 / 18) and traps (15 / 19) land. Both steps are identity steps. An older build refuses the room cleanly, and going back is the backup's restore.

## 5. Tests

- **Unit, the merge** (`shared/rules/pcSync.test.ts`), as a table:
  - One row per field of 2.3 for each row of 2.2: no record and no block, no record with a block, a record with no base for the field, the five cases with a base, and not read. The five ticked fields ticked, unticked (base `n`, then kept on the next sync) and kept.
  - One row per case of 2.4. An own roll of the same name re-synced twice with the same data stays the player's, and `h` is D&D Beyond's after Overwrite, Add it back and a kept conflict.
  - AC and Speed in a shape: re-sync with a changed AC, end the shape, re-sync, and AC comes in under Also set.
  - The key for two alike and "(two hands)", the hash leaving out `id`, `ddb` and `onPass`, `onPass` kept only with a save, saves in a new order changing nothing, Hover kept, the name never ticked or in the base, and a relinked number.
  - A kind not read and a cut kind never removing, rolls that did not fit left out and not recorded, and 41 source rolls with a weapon added before the cut.
  - The editor's no-record mode with Keep mine, the 12 KiB and 6 KiB checks, the losses warning, the proficiency beside a kept bonus, and every bulk button.
- **Randomized merge** (same file): many random triples of base, current and new for every field and up to 12 rolls, with random edits, deletions, unread kinds, shapes and choices. Invariants, each with its exceptions:
  1. With a record and nothing ticked to take, every field and roll the player changed ends as it was, and none they deleted comes back. Exceptions: none.
  2. With a record, every field and roll the player did not change ends as D&D Beyond's where it was read. Exceptions: the name, an unticked Also set line, AC and Speed in a shape, and rolls left out for room.
  3. A field not read, or a roll of a kind not read whole, never changes, and its base or entry stays.
  4. With every Overwrite and Take these ticked, every read field ends as D&D Beyond's, and the synced rolls equal its rolls plus the player's unmatched own. Exceptions as in 2.
  5. The new base is D&D Beyond's for every read field. A re-sync at once with the same data brings nothing in. Its kept list is the same, except a roll D&D Beyond removed while edited, which is listed once and then is the player's own.
  6. Ids of rolls that stay never change. Ids are unique, there are at most 40 rolls, the block passes its schema and 12 KiB, and the record its schema and 6 KiB.
  7. The undo patch, applied after the sync's patch, gives back the block, level, name, AC, Speed, senses, sheet link, record, and exactly the current and maximum HP, a cut current HP included.
  8. Every changed or kept item has exactly one line, and the done line's counts add up.
- **The dialog as a state machine** (`client/features/pcstats/resyncFlow.test.ts`): many random sequences of open, Get it, late, refused or aborted answers, Read it, ticks, bulk buttons, live changes, Apply, its answers (stale included), Undo, its answers and close. Invariants:
  - At most one fetch is in flight, and a newer one aborts the older. A stale or aborted answer never changes the review.
  - Apply sends at most one op, never while one waits, never after close, and always with `expect`. Undo sends at most one op, only after a taken Apply.
  - A refusal leaves the ticks whose lines remain. Ticks change only by a tick, a bulk button or a line going away.
  - Nothing is sent or fetched after close.
- **The race** (`server/rooms/resync.test.ts`, on the room actor): the DM's edit of Bree's AC lands between Ana's review and her Apply, which is refused with `CHARACTER_CHANGED` and changes nothing, then is taken with the new hashes. The same for Undo. Ana's Apply on a character with `dmNotes` and a hidden effect is taken. HP: 35 of 38, a sync to a maximum of 30 gives 30 of 30, and Undo gives back 35 of 38.
- **Beside the merge:** `shared/reducer/pcStats.test.ts` (stored, `at` set and kept when sent, `stats: null` drops the record, the 6 KiB refusal). `shared/permissions.pcStats.test.ts` (owner, co-owner, DM, another player's `NOT_YOURS`, `expect` matched, missed and absent, no hash over a part a player lacks). `shared/project.pcStats.test.ts` (the DM and owners get the record, another player, a token's owner and the display never). `server/rooms/undoLabels.pcStats.test.ts` (a sync, an editor Save with a record, the dialog's Undo with `at` and with null). `server/rooms/pcStats.import.test.ts` (the record travels). `server/rooms/actor.test.ts` (a patch naming only `ddbSync` and `level` spends one and reads in the block's words). `shared/migrate.test.ts` (the identity steps).
- **Reader** (`shared/ddb/read.test.ts`): hand-made partial bodies with no `classes`, no `modifiers`, no `inventory`, no spell lists and no `actions`, each leaving out exactly 2.5's parts with its warning and read marks, and 41 rolls marked cut. The AC warning is no longer in `warnings`.
- **Integration:** the route's code does not change, and `server/http/ddbImport.itest.ts` gains one check that `read` is in the answer.
- **e2e**, new `e2e/resync.e2e.ts`, D&D Beyond's answers given by `page.route` on the import route from hand-made fixtures:
  - rs-0: a DM's room, Ana playing Bree with a typed block, Charisma as her Spellcasting ability, a D&D Beyond sheet link and 20 of 38 HP, and Cy.
  - rs-1 (Ana, 390 x 844): the editor's D&D Beyond step (fixture A, a Wisdom caster) shows "Check what was read" and lists Spellcasting ability under Replaces your changes. Ana ticks its Keep mine and unticks the AC line. After Use it and Save, "Last synced" shows.
  - rs-2: Ana deletes Shortbow and edits Shillelagh, then saves.
  - rs-3: fixture B (level 6, Wisdom 18, Moonbeam, Shillelagh changed). Re-sync shows the loading line. Changes has Wisdom and Moonbeam, and Also set has the Level and Max HP lines ticked, with "Bree keeps 20 HP, now of 45." Kept lists Spellcasting, AC, Shortbow and the tagged Shillelagh.
  - rs-4: Apply shows the done line. The panel and the DM's device show level 6 and Charisma. Cy's device has neither `stats` nor `ddbSync`.
  - rs-5: Undo gives back level 5, Wisdom 16 and 20 of 38 HP.
  - rs-6: Ana re-syncs, presses Overwrite all, unticks Level and applies. Spellcasting ability Wisdom and Shortbow come back, and level stays 5. A re-sync right after lists Level under kept, reads "Nothing new from D&D Beyond.", and offers only Done, which sends nothing.
  - rs-7: the DM changes Bree's AC while Ana's review is open. The status says Bree changed, and the AC row updates.
  - rs-8: the errors show their words under the field, which is prefilled: `private`, then pasted fixture JSON reaching the review, then `busy` and `quota_member`.
  - rs-9: Bree's sheet link moves to another number. Re-sync fetches it, the read line says it is a different character, and Take these on Ability scores ticks that group.
  - rs-10 (the DM, 1440 x 900, Bree's page, keys only): focus moves to the review's first line when it arrives, and Overwrite all reports `aria-pressed`. After Apply by Enter, focus stays on the surviving primary and the done status is present. Escape returns focus to Re-sync. The toolbar's Undo names "re-syncing Bree from D&D Beyond", and after the dialog's Undo, "undoing Bree's re-sync".
  - rs-11: a 46-roll fixture at 360 x 780, 390 x 844 at 130% and 844 x 390: no sideways scroll, the cut warning, "Rolls" folded with "40: Adds Longsword, and 39 more", h3 only for the sections, and Apply in view.
  - rs-12: no page logged an error.
  - Run resync, pcstats (its step 5 meets Replaces your changes) and reach.

## 6. Build plan

One builder, after attach and traps, on their tip:

1. `feat(characters): a character remembers what its last d&d beyond sync set`: shared/model.ts, shared/protocol.ts (`ddbSync`, `expect`, `read`), shared/limits.ts (`ddbSyncBytes`, `CHARACTER_CHANGED`), shared/migrate.ts, shared/reducer/tokens.ts (`characterUpdate`), shared/permissions.ts (the owner field and `expect`), client/features/tokens/access.ts, server/rooms/actor.ts (`writesPcStats`, `savesPcStats`), server/rooms/undoLabels.ts, server/rooms/stateSchema.ts, and the tests of section 5 for them, server/rooms/resync.test.ts included.
2. `feat(rules): a d&d beyond re-sync merges three ways`: shared/rules/pcSync.ts and its test (new), the HP rule moved there from fill.ts, shared/ddb/read.ts and its test (2.5), shared/rules/pcFill.ts (`read`).
3. `feat(ui): re-sync a character from d&d beyond`: client/features/pcstats/Resync.tsx, resyncFlow.ts, SyncReview.tsx and resync.ts (the words), all new, with their tests. Also open.ts (the dialog's slot), PcStatsEditor.tsx (only `PcStatsHost`, which draws the dialog), and PcStatBlock.tsx (the button and the line).
4. `feat(ui): the editor's d&d beyond step merges as a re-sync does`: PcStatsEditor.tsx (its step and review), flow.ts, fill.ts and ddb.ts, with their tests.
5. `test(e2e): re-sync from d&d beyond`: e2e/resync.e2e.ts (new), e2e/pcstats.e2e.ts step 5.
6. `docs: re-sync in the feature list, the dm guide and the design`: FEATURES.md, docs/dm-guide.md (lines 852-854), docs/design.md (6's character, 8.1's owner fields and `expect`, 16.2's Versioning, 16.4's export), and a "Changed by" line in the stat block note's 6.1.

**Shared with the lanes in flight.** Attach (in review) and traps also edit these files: shared/model.ts, protocol.ts, limits.ts, migrate.ts, permissions.ts and reducer/tokens.ts, server/rooms/actor.ts, stateSchema.ts and undoLabels.ts, FEATURES.md and docs/design.md. This lane's edits in them stay apart from token, move and trap code: a character's field, the character patch's fields, `characterUpdate`, `canApply`'s character branch, one fields line, the two bucket functions and one label case. The migrate constants and steps, and 16.2's paragraph, are appended in build order, so this lane goes last. Nothing here touches client/features/attach, panels/TokenPanel.tsx, tokens/CreatureHeader.tsx, panelOrder.ts or any trap file. The token panel changes only through PcStatBlock.tsx.

**FEATURES.md**, "## Characters and monsters": the fill bullet's "Importing again replaces what it read and keeps the rolls you added." becomes: "Re-sync from D&D Beyond, beside Edit, brings in what changed there since the last sync and keeps what you changed here, such as a Spellcasting ability or a renamed weapon. It lists each kept change with Overwrite, and Overwrite all, and Undo takes a re-sync back."

## 7. Decided, for the project owner to overrule

Asking is off. These are the choices most likely from the owner's words and past decisions. Those marked (C) are the coordinator's, after round 1.

1. **The button sits in the Stat block group, beside Edit**, on the token panel and the character's page. On a phone the first time is two taps. Rejected: the editor only (six taps), the tracker row or the action bar (places for mid-fight), and the sheet link (which opens D&D Beyond).
2. **Apply sends at once after a review, and Undo is in the done state.** Rejected: going through the editor's draft and Save, which doubles the review.
3. **(C) The editor's Fill fills.** With no record it takes D&D Beyond's values as today's import does, keeps today's ticks, and writes the record. "Replaces your changes" lists what it replaces, each with an unticked Keep mine. With a record it runs the three-way merge. Rejected: keeping every typed value until Overwrite all (draft 1), which made Fill not fill, and ignoring the record, which would undo kept changes through the other door.
4. **(C) Level, Max HP, AC, Speed and senses keep today's ticks**, on by default, in their own section on every sync. Unticking keeps the value while the base moves. Rejected: no ticks (draft 1), which lost today's choice, and ticks on every line.
5. **(C) The no-record review groups its differences by the Changes groups**, each with a summary and Take these, folded past 10 rows. Rejected: a flat list, many screens long on a phone.
6. **(C) Re-sync fetches what the sheet link names**, else the record's `from`. Another number is a new source with no record. Rejected: always the record's `from`, which keeps fetching a character the player replaced.
7. **(C) No lasting mark on kept fields** in the stat block. The review and the done line say what was kept. Rejected: a mark in the view between re-syncs.
8. **(C) Apply and Undo carry a per-part precondition**, checked live by the server, with one refusal. Rejected: a check on the device alone (it races), a whole-character hash (it refuses players and leaks the DM's hidden edits), and a check in the reducer (it would run on replay).
9. **(C) Undo restores the exact current and maximum HP.** Rejected: running the HP rule backwards.
10. **The reader leaves out what it could not read**, marks each kind of roll, and keeps its 40-roll cut. A cut kind never removes. Rejected: sending more than 40 candidates, which loosens the route's bounds and the record's 40.
11. **The record keeps field values and hashed roll entries on the character**, under 6 KiB. Rejected: entries keyed by raw ids (UTF-8 ids can pass any cap), copies of the rolls (up to 12 KiB more on every HP resend), hashes for the fields too, a collection of its own, and an 8 KiB cap with ids kept.
12. **Manual is by value.** Edited back, a field is untouched. Rejected: an edit history every surface would have to write.
13. **A roll is one item**, and "On a pass" stays out of its hash. Rejected: merging part by part inside a roll.
14. **A roll the player deleted stays deleted**, with Add it back. Rejected: bringing it back as new.
15. **The name is an unticked offer and not in the base.** The sheet link is set only when there is none.
16. **AC and Speed are not read in a shape.** Rejected: writing under the shape, or moving their base.
17. **A player undoes in the dialog, until it closes.** Rejected: a player's undo stack for character edits, which would let a player churn stored blocks past the bucket, and a toast with an action, which no toast has.
18. **The route and its budgets are unchanged.** Rejected: merging on the server, which needs room state in the route and would freeze the merge into replay.

## Appendix A. Sizes

Measured with `JSON.stringify`, counted in UTF-8:

| What | Bytes |
| --- | --- |
| A typical druid's base (level 5, 4 skills, one bonus, Darkvision) | 367 |
| A base at every bound, senses in 80 CJK characters | 1,748 |
| One roll entry | 54 |
| A record with 32 rolls, typical base | 2,200 |
| With 40 rolls | 2,640 |
| Every bound: 40 entries, 40 in `gone`, the base above | 4,630, under 6 KiB (6,144) |
