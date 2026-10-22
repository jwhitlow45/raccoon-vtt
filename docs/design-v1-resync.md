# raccoon-vtt v1: re-sync from D&D Beyond

Status: draft 1, for design review. Code is cited from main at `09651fbc7`. It builds on docs/design-v1-pc-stats.md ("the stat block note"), whose section 6 fills a block from D&D Beyond, and follows docs/design-v1-look-pass.md for every screen.

The project owner, 2026-10-22: "Another useful feature would be to have a "re-sync charcter sheet" feature that allows someone to re-sync their stats and spells from an existing sync. As part of this we should keep track of manual changes that were made to stats and other static values (such as spell casting ability, my druid is a charisma caster for examples), and note that these were not changed on the resync, while giving the option to overwrite them if desired. I'll let you come up with where this should live and the design but I think it should be pretty simple given the new data from dnd beyond just has to be "merged" intelligently."

## 0. Today and the answer in short

**Today.** The stat block editor's "Fill from" D&D Beyond step fetches a public character through `POST /api/rooms/:id/ddb-import` (server/http/ddbImport.ts), reads it with `readDdbCharacter` (shared/ddb/read.ts), and reviews it before Use it fills the draft and Save sends one `character.update`. `mergeFill` (shared/rules/pcFill.ts:64) replaces every part it read whole, drops the rolls marked `ddb` and keeps the rest. `alsoLines` (client/features/pcstats/fill.ts:37) ticks level, AC, max HP, speeds and senses on, and the name off. Nothing remembers what the import set, so a Spellcasting ability changed by hand, a corrected AC or a renamed weapon is replaced on the next import. An imported roll loses `ddb` when edited and is then kept, but it is never updated again.

**The answer.**

- **Where.** "Re-sync from D&D Beyond", a button beside Edit in the Stat block group, which the token panel and the character's page share (`PcStatBlock.tsx`). One tap fetches, a review says what comes in and what of yours stays, Apply sends one op, and Undo takes it back. The editor's own D&D Beyond step runs the same merge and review, ending in Use it.
- **The record.** A character remembers what its last sync set: `Character.ddbSync`, the values D&D Beyond gave for each field it read, and a short hash per roll it brought in. About 0.4 KB plus 78 bytes a roll, at most 6 KiB.
- **The merge.** Three ways per field and per roll: the last sync, the character now, D&D Beyond now. What only D&D Beyond changed comes in. What the player changed is kept and listed with Overwrite, and one Overwrite all takes D&D Beyond's for every kept item.
- **Versions.** A new optional field on the character and on `character.update`, so the next free op and snapshot pair, both, with identity steps. The server route and its budgets stay as they are.

## 1. Where it lives and the flow

### 1.1 Surfaces

- **The Stat block group** (`PcStatBlock.tsx:86-92`), on the token panel and the character's page alike. Its button row under the block gains "Re-sync from D&D Beyond" after Edit, for the DM and the character's players (`editsPcStats`, today's import rights). It shows when the character has a block and a D&D Beyond number: the record's `from`, else the digits of a D&D Beyond sheet link (`ddbCharacterId(actor.sheetUrl)`). An import sets that link when there is none, so characters imported before this feature have it. Under the row, with a record: "Last synced from D&D Beyond on Oct 20." as `Help`.
- **In a shape** the group shows the shape's body and the same row, so Re-sync is there too. AC and Speed are left alone in a shape (2.3).
- **The editor's "D&D Beyond" step** keeps its link field, Get it and pasted JSON. Its review becomes the re-sync review (3.3) and its button stays Use it: the merge fills the draft, and Save sends the new record with the block. So an import made in the editor also leaves a record.
- **Not here:** the tracker row, the action bar and the token window. A re-sync is a between-sessions task, and two places in reach of every editor (the panel and the page) are enough. "Paste text" writes no record, since pasted text is the player's own typing.

### 1.2 The steps

1. **Start.** The button opens the dialog "Re-sync Bree" and fetches at once with the known number, one request per press, as Get it spends today.
2. **Fetch.** `Loading` "Getting Bree from D&D Beyond…" after the shared 200 ms delay, and the footer's primary busy as "Getting it…". Cancel and closing abort it (the editor's rule, flow.ts).
3. **Review**, titled "Check what changes" (3.3). It follows the live character: an edit on another device while it is open changes its lines, and a choice whose line went away is dropped.
4. **Apply** sends one `character.update` with the merged parts against the character as it is at that moment, busy as "Applying…". On `taken` the dialog shows the done state.
5. **Undo the re-sync**, in the done state until the dialog closes, sends one `character.update` that puts back each part and field the re-sync changed and the record before it. It is offered only while the character still holds what the re-sync set, so it never undoes another device's later edit. The DM's re-sync is also on the DM's undo stack, "re-syncing Bree from D&D Beyond".

### 1.3 Characters in each state

| The character | Button | The merge |
| --- | --- | --- |
| No block | not shown. "Add a stat block", then the editor's D&D Beyond step | a first sync: everything read comes in |
| A block, no D&D Beyond number | not shown | none |
| A block from an import before this feature (no record, a D&D Beyond sheet link) | shown | no base: a roll marked `ddb` counts as untouched, and every other difference stays as it is, listed under "Different from D&D Beyond" with Overwrite (2.2, 2.4) |
| A block typed or pasted, with a D&D Beyond sheet link | shown | as the row above |
| Synced before | shown, with "Last synced" | three ways (2.2, 2.3) |
| A different character number than the record's, typed in the link field | shown | as no record, and the review says why |

**Failures** end in Appendix D's words of the stat block note, unchanged, and each keeps the dialog open with the D&D Beyond step's own field, Get it, "Open its data in D&D Beyond" and "Paste its JSON instead" (3.5):

- Private: `private`. Gone: `not_found`, with the field to paste a new link. Down, blocked, a timeout or 15 s on the device: `fetch_failed` and Try again.
- **D&D Beyond's format changing** shows two ways. A body that no longer reads is `unreadable`, and nothing changes. A body that reads in part leaves out what the reader could not read, and a part left out is never read as "removed" (2.2). A read that would take away many things at once gets a warning above the lists (3.3), since a moved path reads as empty lists.

## 2. The merge (`shared/rules/pcSync.ts`)

### 2.1 The record

```ts
// Character gains ddbSync?: DdbSync, beside stats and knownForms
type DdbSync = {
  at: string                       // when it was applied: the op's envelope time, written by the reducer when the patch has none
  from?: string                    // the D&D Beyond character number, 1 to 12 digits
  base: DdbBase                    // what D&D Beyond said at that sync, for each field it read
  rolls: Record<PcRollId, { k: string, h: string }>   // each roll that sync placed, by its id in the block, at most 40
}
type DdbBase = Omit<PcFillStats, 'rolls'> & {     // the fill's own parts and bounds (shared/rules/pcFill.ts)
  level?: number, name?: string, ac?: number, hpMax?: number, speeds?: Actor['speeds'], senses?: string }
```

- `k` is the first 12 hex digits of `hash128` (shared/project.ts:1989) of the roll's **key**: its kind's letter, its name in lower case with spaces collapsed, and a spell's level, as "w:longsword", "s:fireball:3", with "#2" on the second of two alike in the fill's order. The reader makes new ids on every read, so the key is what finds a roll again.
- `h` is the same hash of the roll's **content**: `stableStringify` of the roll without `id`, `ddb` and `save.onPass`. D&D Beyond never gives a pass's rule, so setting "On a pass" never makes a roll the player's change, and an update keeps the block's own `onPass`.
- **Why values for fields and hashes for rolls.** Field values are small (388 bytes for a typical druid) and let the review say what D&D Beyond said last time. Rolls are up to 12 KiB, and a character is resent on every HP change (stat block note 3.1), so a roll costs 78 bytes here instead of its whole copy. The ids are kept because an open ask for saves names its roll by id (`CastAsk.roll`), so a re-sync updates rolls in place.
- **Size** (Appendix A): 3.6 KB for a typical 40-roll block, 6,135 bytes at every bound with 64-character ids. `LIMITS.ddbSyncBytes` is 6 KiB, checked in the schema and by the reducer.

### 2.2 The three-way rule for a field

`b` is the record's base, `c` the character now, `n` D&D Beyond now. A value that is absent ("none", 0 for a bonus, off for a flag) is a value. A part the fill left out is not read.

| The record | The player changed it (`c` ≠ `b`) | D&D Beyond changed it (`n` ≠ `b`) | Outcome | The review lists it under |
| --- | --- | --- | --- | --- |
| any | any | not read | nothing, `b` kept | none |
| has `b` | no | no | nothing | none |
| has `b` | no | yes | takes `n` | Changes from D&D Beyond |
| has `b` | yes | no | keeps `c` | Your changes, kept |
| has `b` | yes | yes, to `c` | nothing, both reached it | none |
| has `b` | yes | yes, to another value | keeps `c` | Your changes, kept, tagged "Also changed in D&D Beyond" |
| none, and no block | | | takes `n` (a first sync) | Changes from D&D Beyond |
| none, with a block | `c` = `n` | | nothing | none |
| none, with a block | `c` ≠ `n` | | keeps `c` | Different from D&D Beyond |

- **Overwrite** on a kept item takes `n`. Nothing else ever replaces a value the player set.
- **After Apply** the base of every read field is `n`, kept or taken, and an unread field keeps its old base. So a kept Charisma stays listed as kept on every later re-sync, and a later change in D&D Beyond shows as "also changed".
- **"Manual" is by value.** A field or roll is the player's change while it differs from what the last sync set, whoever changed it and wherever (the editor, the light card, the panel's Stats, the HP entry's maximum). Edited back to the synced value, it is not a change, and the next re-sync updates it as untouched.

### 2.3 Each field

| Field | One field per | Notes |
| --- | --- | --- |
| Ability scores | ability | |
| Save proficiencies | ability: proficient or not | |
| Skill proficiency and Expertise | skill: none, Proficient or Expertise | Expertise is the skill's own value, not a field apart |
| Jack of All Trades, Alert, Evasion, Critical hits on | each | |
| Bonuses (`adjust`) | key: each save, each skill, all saves, all checks, Initiative, Passive Perception, spell save DC, spell attack | a typed total stores its difference (stat block note 3.3), so a typed Perception total is its bonus here |
| Spellcasting ability | one | the request's example: a druid set to Charisma by hand is kept, listed, and offered Overwrite |
| Defenses | damage type: none, Resistant, Immune or Vulnerable | |
| Level | one | the character's `level`, which moves the Proficiency Bonus |
| Max HP | one | applied by the HP rule below |
| AC | one | left alone while in a shape: the actor holds the creature's, and `unshaped` the character's (W7B-P-9) |
| Speed | kind: walk, fly, swim, climb, burrow | Hover is never touched, where today's fill replaced `speeds` whole and dropped it. Left alone in a shape |
| Senses | the whole text | the reader sets it only with Darkvision, so without it the field is not read |
| Name | one | always an offer, unticked, as today: a name typed in the room often differs on purpose. Its base is still kept |
| Sheet link | none | set only when the character has none, as today |

**Max HP** follows the companion design's rule (docs/design-v1-companion-stat-blocks.md 5.2), as `alsoPatch` does now (fill.ts:79): a living character at its maximum stays at its new maximum, and any other keeps its HP, cut to the maximum if higher. A re-sync never brings a character back or puts one down, and never sets current or Temporary HP.

### 2.4 Rolls

| Case | Record | Block | D&D Beyond | Outcome | Listed |
| --- | --- | --- | --- | --- | --- |
| D&D Beyond added it | no entry with its key | no unlinked roll with its key | has it | added with `ddb`, recorded | Changes: "Added Moonbeam (level 2)" |
| D&D Beyond removed it, untouched | entry | content = `h` | gone | removed, entry dropped | Changes: "Removed Shortbow" |
| D&D Beyond removed it, edited | entry | content ≠ `h` | gone | kept, entry dropped, so it is the player's own from then | Kept: "D&D Beyond no longer has it.", Remove it |
| D&D Beyond changed it, untouched | entry | = `h` | ≠ `h` | updated in place, id and `onPass` kept | Changes: "Changed Shillelagh: …, was …" |
| The player edited it | entry | ≠ `h` | = `h` | kept | Kept, Overwrite |
| Both changed it | entry | ≠ `h` | ≠ `h` and ≠ the block's | kept | Kept, tagged, Overwrite |
| Both reached the same | entry | ≠ `h` | = the block's | nothing, `h` updated | none |
| The player deleted it | entry | no roll with that id | has it | stays deleted, entry kept | Kept: "You removed it.", Add it back |
| Deleted here and in D&D Beyond | entry | none | gone | entry dropped | none |
| The player made it | no entry | no key match | | kept, never recorded | "Keeps your 2 own rolls." |
| The player made one of the same name | no entry | an unlinked roll with the key | has it | kept and recorded as linked | Kept or Different, Overwrite |
| Imported before this feature | no record | roll with `ddb` and the key | has it, or not | updated in place, or removed, as untouched | Changes |
| No room | | own and kept rolls fill 40 | more | left out and not recorded, so they come in once there is room | Check these: "3 more rolls were left out. At most 40 rolls fit." |

Overwrite on a kept roll replaces its content and keeps its id. Add it back uses the recorded id. One roll is one item: a roll is a small thing, and a part-by-part merge inside a roll would need its parts matched too. The review's size check refuses an Apply that would take the block past 12 KiB, before it is sent (3.3).

## 3. UI/UX

Every screen is the one dialog shell (components/Dialog.tsx): the whole screen below 600 layout px ("fill", as the editor), a centered card from 600 (width `lg`, 720 px), so a phone held sideways (844 x 390) and a tablet get the card. The title changes per state and takes focus (`useStepFocus`). The review reuses the fill review's parts and the panel kit's: `SectionLabel`, `Section` folds with summaries, `Checkbox` lines, `Tag`, `Notice`, `RowList`, and no style of its own. Bree is Ana's level 5 druid in the examples.

### 3.1 The entry point

```
 phone 390 x 844, token panel sheet          desktop 1440 x 900, side panel (380 px)
+--------------------------------------+    +-----------------------------------+
| (B) Bree                           x |    | (B) Bree                          |
|     Level 5 character . Medium (5 ft)|    |     Level 5 character . Medium    |
|     [15]  30 ft  PP 15  Init +2 Sheet|    |     [15]  30 ft  PP 15  Init +2   |
| v Stat block          [Take a shape] |    | v Stat block      [Take a shape]  |
|   Level 5, proficiency +3            |    |   Level 5, proficiency +3         |
|   ...the block, as today...          |    |   ...the block, as today...       |
|   [Edit] [Re-sync from D&D Beyond]   |    |   [Edit] [Re-sync from D&D Beyond]|
|   Last synced from D&D Beyond on     |    |   Last synced from D&D Beyond on  |
|   Oct 20.                            |    |   Oct 20.                         |
| > Combat                HP 38/38     |    | > Combat              HP 38/38    |
```

At 360 px the two buttons still share a line (about 262 px of 328). At 130% they wrap, Re-sync under Edit. Both are `SmallButton`s, 44 px on touch.

### 3.2 Fetching, and each fetch error

```
 phone 390 x 844: fetching                   every fetch error, here private
+--------------------------------------+    +--------------------------------------+
| Re-sync Bree                       x |    | Re-sync Bree                       x |
|--------------------------------------|    |--------------------------------------|
| (o) Getting Bree from D&D Beyond…    |    | ! D&D Beyond would not share that    |
|                                      |    |   character. Set its privacy to      |
|                                      |    |   Public in D&D Beyond, then try     |
|                                      |    |   again, or paste its JSON.          |
|                                      |    | Share link or character number       |
|                                      |    | [dndbeyond.com/characters/12345678]  |
|                                      |    | Open its data in D&D Beyond  ->      |
|                                      |    | [Paste its JSON instead]             |
|--------------------------------------|    |--------------------------------------|
| [Cancel]              [Getting it…]  |    | [Cancel]                   [Get it]  |
+--------------------------------------+    +--------------------------------------+
```

The right is every fetch error: its Appendix D words in a danger `Notice` with `role="alert"`, then the D&D Beyond step's own parts. `fetch_failed`'s Get it reads Try again. Read it on pasted JSON goes straight to the review.

### 3.3 The review

```
 phone 390 x 844, a level-up with two kept changes
+--------------------------------------+
| <  Check what changes              x |   Back: to the field (3.2)
|--------------------------------------|
| Read from D&D Beyond: Bree Tallow,   |
| level 6. Last synced on Oct 20.      |
| CHECK THESE                          |
| Whether a pass halves the damage ... |
| CHANGES FROM D&D BEYOND (6)          |
|   Level 6, was 5                     |
|   Max HP 45, was 38. Bree is at full |
|   HP, so stays at full: 45 of 45.    |
|   Wisdom 18, was 16                  |
|   Perception: Expertise, was         |
|   Proficient                         |
|   Added Moonbeam (level 2)           |
|   Removed Sling                      |
| YOUR CHANGES, KEPT (2) [Overwrite all]
|   Spellcasting ability: Charisma     |
|   D&D Beyond says Wisdom.            |
|   [ ] Overwrite with Wisdom          |
|   Shillelagh, as you changed it      |
|   [Also changed in D&D Beyond]       |
|   Yours: +6 to hit, 1d8+3            |
|   Bludgeoning. D&D Beyond: 1d10+3.   |
|   [ ] Overwrite with D&D Beyond's    |
| NAME                                 |
| [ ] Rename to Bree Tallow            |
| Keeps your 2 own rolls.              |
|--------------------------------------|
| [Cancel]                    [Apply]  |
+--------------------------------------+
```

- **Order:** what was read, Check these (the reader's warnings and the review's own, below), Changes from D&D Beyond, the kept items, Name, then one muted line for own rolls and rolls left out.
- **Changes from D&D Beyond** runs in this order of groups: Level and Hit Points, Ability scores, Saves and skills, Bonuses, Spellcasting, Features, Defenses, AC, Speed and senses, Rolls. Each line is "<what> <new>, was <old>" in the editor's words: "Dexterity save: Proficient, was not", "Stealth: Proficient, was none", "Perception bonus +2, was +0", "Fire: Resistant, was none", "Critical hits on 19 and 20, was 20", "Walk Speed 35 ft, was 30 ft", "Senses Darkvision 60 ft, was none", "Sheet link dndbeyond.com/characters/12345678". AC adds "Worked out from the armor: check it." to its own line, so the reader's AC warning moves out of Check these and shows only when AC comes in. A roll line is the view's reading (`rollReading`, client/features/pcstats/reading.ts): "Added Fire Bolt: +5 to hit, 2d10 Fire", "Changed Longsword, +1: +6 to hit, 1d8+4 Slashing, was +5 to hit, 1d8+3 Slashing", "Removed Shortbow".
- **The kept items** are one `RowList`, conflicts first, each row a group named by its first line (`role="group"`, `aria-labelledby`): the field and its value now, the "Also changed in D&D Beyond" `Tag` on a conflict, then "D&D Beyond says Wisdom." (with ", was Intelligence at the last sync." on a conflict), then its `Checkbox`: "Overwrite with Wisdom", "Overwrite with D&D Beyond's", "Remove it", or "Add it back" for "Shortbow: you removed it." All start unticked. With no record the label is "DIFFERENT FROM D&D BEYOND (12)", and a line above the rows says: "Bree has no record of a past sync, so a change of yours cannot be told from one in D&D Beyond. What differs stays as it is unless you overwrite it." A different character number says: "This is a different D&D Beyond character from the one Bree was synced from, so what differs stays as it is unless you overwrite it."
- **Overwrite all** sits in the label's action slot (`SectionLabel`, which wraps it under the label where the row is too narrow), ticks every kept row, and reads "Keep all of yours" once all are ticked, which unticks them. The name is apart from it: "Rename to Bree Tallow" starts off, as today.
- **The review's own checks** in Check these: in a shape, "AC and Speed stay as they are while Bree is in Wild Shape. Re-sync after the shape ends to update them." ("in a shape" for another one). A proficiency that comes in beside a kept bonus on the same save or skill: "Stealth gets proficiency from D&D Beyond and keeps your +3 bonus, so it rolls +8. Overwrite the bonus if it stood for the proficiency." A read that takes away 6 or more proficiencies, defenses or rolls, and at least half of those synced: "This takes away 14 proficiencies and 20 rolls. If they are still on the character in D&D Beyond, its format may have changed: Cancel, and check the character there."
- **Too big:** "This would make Bree's stat block 12.4 KiB of the 12 KiB it may hold. Remove a few of your own rolls first." as a danger `Notice` above the footer, and Apply disabled.
- **Nothing new:** when no part, field or record would change, the Changes section is "Nothing new from D&D Beyond." The kept rows still list, and the primary reads Done until a row is ticked, when it reads Apply. Done sends nothing.

**A long list on a phone.** One line per change, wrapped, 14 px, never a table. The footer stays in view. With 10 lines or fewer, Changes is one plain list in the groups' order. Past 10, each group with a line becomes a `Section` fold, folded, its summary its count and its first line, as "Rolls (40): Added Longsword, and 39 more". A roll group's lines run weapons, spells by level, then other rolls, as the view sorts. So 40 new rolls take one row of the first screen. The kept items are never folded, since they are where the choices are, and the label carries their count. They run long only on a first sync over a typed block, where Overwrite all sits at the top of them. At 360 px every line wraps and Overwrite all goes under its label.

```
 phone 360 x 780, the editor's first import with 40 rolls
+----------------------------------+
| <  Check what was read         x |
|----------------------------------|
| CHANGES FROM D&D BEYOND (58)     |
| > LEVEL AND HIT POINTS (2)       |
|   Level 7, was not set, and 1 ...|
| > ABILITY SCORES (6)             |
|   Strength 8, was 10, and 5 more |
| > ROLLS (40)                     |
|   Added Longsword, and 39 more   |
| NAME                             |
| [ ] Rename to Bree Tallow        |
|----------------------------------|
| [Back]                  [Use it] |
+----------------------------------+
```

```
 phone 844 x 390: the card, 720 wide
+------------------------------------------+
| <  Check what changes                  x |
|------------------------------------------|
| CHANGES FROM D&D BEYOND (6)              |
|   Level 6, was 5                         |
|   (the body scrolls, about 4 lines)      |
|------------------------------------------|
| [Cancel]                        [Apply]  |
+------------------------------------------+

 tablet 820 x 1180 and desktop 1440 x 900: the card, 720 wide
+----------------------------------------------------------------+
| <  Check what changes                                        x |
|----------------------------------------------------------------|
| Read from D&D Beyond: Bree Tallow, level 6. Last synced on ... |
| CHANGES FROM D&D BEYOND (6)                                    |
|   ...one line each...                                          |
| YOUR CHANGES, KEPT (2)                         [Overwrite all] |
|   Spellcasting ability: Charisma                               |
|   D&D Beyond says Wisdom.           [ ] Overwrite with Wisdom  |
|----------------------------------------------------------------|
| [Cancel]                                              [Apply]  |
+----------------------------------------------------------------+
```

From 600 px a kept row's checkbox goes beside its D&D Beyond line where both fit, else under it. The card's body scrolls with its header and footer fixed. A tablet held upright keeps panels as 560 px sheets (look pass 2.8), so the entry point looks as on the phone, and the dialog is the card.

### 3.4 Apply, done and Undo

```
+--------------------------------------+    +--------------------------------------+
| Bree is re-synced                  x |    | Re-sync undone                     x |
|--------------------------------------|    |--------------------------------------|
| (v) 6 changes came in, and 2 of your |    | (v) Bree is as she was before the    |
|     changes stayed.                  |    |     re-sync.                         |
|--------------------------------------|    |--------------------------------------|
| [Undo the re-sync]           [Done]  |    |                              [Done]  |
+--------------------------------------+    +--------------------------------------+
```

- Apply is busy as "Applying…", refuses a second tap and keeps the review still while it waits. The done line counts Overwrites with what came in, and leaves out its second part when nothing was kept.
- Undo is busy as "Undoing…". When the character no longer holds what the re-sync set, it is disabled with `Help` under it: "Bree changed after the re-sync, so it cannot be undone here."
- Done or closing ends the dialog, and focus returns to Re-sync.

### 3.5 Every error after the fetch

| When | Shows | Then |
| --- | --- | --- |
| Apply refused | "Not re-synced: " and the server's words, a danger `Notice` above the footer | the review and its ticks stay |
| The bucket (`BLOCK_SAVES_TOO_FAST`) | its words, and "You can apply again in a few seconds." as the dialog's status | Apply disabled for the refill, as the editor's Save |
| The room too full | `BLOCKS_ROOM_TOO_FULL`'s words | as a refusal |
| `unknown` | "The connection dropped before the server answered. Check Bree's stat block before re-syncing again." | the review stays |
| An answer after closing | a toast: "Bree was not re-synced. <Reason>." or, for `unknown`, "The connection dropped before the server answered, so Bree may not have been re-synced. Check the stat block." | |
| The character deleted, or no longer the viewer's | a warning `Notice`: "This character was deleted or is no longer yours, so it cannot be re-synced." | Apply disabled |
| Undo refused or lost | "Not undone: " and the words, or the `unknown` line with "undoing" | Undo stays offered while it still applies |
| View as a player | the preview's own refusal, as the editor's Save gets | nothing is sent |

### 3.6 Keys, focus, screen readers and reach

- **Keys:** none added or changed. The dialog shell's keys hold (Escape closes, Tab moves), Space ticks a checkbox, and Enter in the link field is Get it, as today. The shortcut sheet and FEATURES.md's Shortcuts do not change.
- **Focus:** each state's title takes focus as it appears ("Re-sync Bree", "Check what changes", "Bree is re-synced", "Re-sync undone"). An error's `Notice` is an alert. Closing returns focus to the button that opened the dialog.
- **Names:** the button's name is its words. Each kept row is a group named by its first line, so a reader hears "Spellcasting ability: Charisma, group" before "Overwrite with Wisdom, checkbox". Folds are named by their label, with the count in the summary. The loading line is a status.
- **Reach:** every button, checkbox row and link is at least 44 px on touch, fields are 16 px, and nothing needs hover or long-press.

## 4. Data, protocol and versions

- **Model:** `Character.ddbSync?: DdbSync` (2.1). No new op, collection or key.
- **Protocol:** `character.update`'s patch gains `ddbSync: DdbSyncPatch | null`, the record whole, with `at` optional. `ddbSyncSchema` bounds it: the base by the fill's own part schemas (`pcFill` in shared/protocol.ts), `from` 1 to 12 digits, at most 40 roll entries, `k` and `h` 12 lower-case hex digits, `at` an ISO time, and 6 KiB serialized. `character.create` does not take it.
- **Reducer** (`characterUpdate`, shared/reducer/tokens.ts:527): stores the record as sent, writes `at` from the envelope when the patch has none, refuses one past 6 KiB with `quota`, and deletes it with `stats: null`, since its base then describes no block. A record may name a roll the block no longer holds: that is how a deletion is remembered. Replay applies the stored record, and `at` comes from the stored envelope, so no version gate is needed.
- **Permissions:** `OWNER_CHARACTER_FIELDS` gains `ddbSync`, on the server and in the client mirror (client/features/tokens/access.ts:53). Other players get `NOT_YOURS`, as for every field of a character they do not play. `writesPcStats` (server/rooms/actor.ts:234) counts a patch naming `ddbSync`, so every Apply and Undo spends one from the per-member bucket and reads in the block's words. A forged record could only change how its own character's next re-sync is listed, which its players may do by hand anyway.
- **Projection:** none to change. `projectCharacter` (shared/project.ts:647) gives the DM the character whole, its players the character whole with `rev` 0, and everyone else a fixed list without `stats` or `ddbSync`. A test pins that row, since the merge runs on the device and must have the record there. The table display never receives it.
- **`canApply`:** the field rule above and the bucket. Nothing reads D&D Beyond on the server's op path.
- **Undo and replay:** the DM's Apply is one op on the DM's stack. `server/rooms/undoLabels.ts:127` gains "re-syncing Bree from D&D Beyond" for a patch naming `ddbSync` and `stats`, and a restore puts back the whole character. A player's stack holds no character edit (stat block note 4.1), so a player's undo is the dialog's (1.2).
- **Export and import:** `room.json` carries the record. `server/rooms/stateSchema.ts:289`'s character takes it through `ddbSyncForImport`. Roll ids are the block's own, not entity ids, so remap leaves the block and the record alike, and a restored backup keeps re-syncing three ways.
- **Limits:** `LIMITS.ddbSyncBytes` 6 KiB, on its own line at the end of its group. A character at both caps is about 18.4 KiB. 50 of them are about 920 KiB of a DM's 3 MiB projected scene, and a real party's records about 15 KB.
- **The server route** stays as it is, with its budgets: a re-sync is one fetch per press, as Get it, and its answer is today's fill. The merge needs the record, which the device holds, so the route needs no room state.
- **Versions** (shared/migrate.ts, design 16.2): an older build's strict schemas refuse the new field in a snapshot and in an op, so this feature takes the next free op and snapshot pair at build time, both: OP 16 and SNAPSHOT 20 once attach (14 / 18) and traps (15 / 19) have landed. Both steps are identity steps, so an older build refuses the room cleanly and going back is the backup's restore. No older op can carry the field, so replay needs no gate.

## 5. Tests

- **Unit, the merge** (`shared/rules/pcSync.test.ts`): a table with one row per field of 2.3 for each row of 2.2 (no record and no block, no record with a block, each of the five cases with a base, not read), and one row per case of 2.4. Also: the key for two alike and for "(two hands)", the hash leaving out `id`, `ddb` and `onPass`, Hover kept, AC and Speed in a shape, the HP rule at full, hurt, dying and dead, the name never ticked by default, a different `from`, rolls left out for room and not recorded, the 12 KiB check, the many-removed warning, the proficiency beside a kept bonus, and Overwrite all.
- **Randomized merge** (same file): many random triples of base, current and new over small domains for every field and up to 12 rolls, with random edits, deletions and Overwrite sets. Invariants:
  1. With no Overwrite ticked, every field and roll the player changed (current differs from base) ends as it was, and none the player deleted comes back.
  2. Every field and roll the player did not change ends as D&D Beyond's, where it was read.
  3. A field not read never changes, and its base stays.
  4. With every Overwrite ticked, every read field ends as D&D Beyond's, and the synced rolls equal its rolls plus the player's unmatched own.
  5. The new base is D&D Beyond's for every read field. Re-syncing at once with the same data lists nothing coming in and the same kept items.
  6. Ids of rolls that stay never change. The result has unique ids, at most 40 rolls, passes the stats schema and 12 KiB, and the record its schema and 6 KiB.
  7. The undo patch applied after the sync's patch gives back the character's block, level, name, AC, Speed, senses, sheet link, record, and its max HP by the HP rule.
  8. Every changed or kept item has exactly one line, and the done line's counts add up.
- **The dialog as a state machine** (`client/features/pcstats/resyncFlow.test.ts`), many random sequences of open, Get it, answers late, refused or aborted, Read it, ticks, Overwrite all, Apply, its answers, Undo, its answers and close. Invariants: at most one fetch in flight, and a newer one aborts the older. A stale or aborted answer never changes the review. Apply sends at most one op, never while one waits, never after close. Undo sends at most one op, only after a taken Apply and only while it applies. A refusal leaves the review and its ticks as they were. Ticks change only by a tick or Overwrite all. Nothing is sent or fetched after close.
- **Reducer** (`shared/reducer/tokens.test.ts`): stored, `at` written and kept when sent, `stats: null` drops it, the 6 KiB refusal, undo's label and restore. **Permissions:** owner, co-owner, DM, another player's `NOT_YOURS`, and the bucket on a patch naming `ddbSync`. **Projection:** the DM and owners receive it, another player, a player who owns only a token and the display never. **Protocol, stateSchema and migrate:** bounds, the import carrying it, the identity steps. **Reader:** the AC warning gone from `warnings`.
- **Integration:** no route changes, so `server/http/ddbImport.itest.ts` runs as it is.
- **e2e**, new `e2e/resync.e2e.ts`, D&D Beyond's answers given by `page.route` on the import route from hand-made fixtures:
  - rs-0: a DM's room, Ana playing Bree with a typed block and a D&D Beyond sheet link, and Cy.
  - rs-1 (Ana, 390 x 844): the editor's D&D Beyond step on a block with no record lists every difference under "Different from D&D Beyond". Overwrite all, Use it and Save leave "Last synced" under the buttons.
  - rs-2: Ana sets Spellcasting ability to Charisma, deletes Shortbow and edits Shillelagh, then saves.
  - rs-3: with the second fixture (level 6, Wisdom 18, Moonbeam, Shillelagh changed), Re-sync shows the loading line, then level, Wisdom and Moonbeam under Changes, Charisma and Shortbow under kept, Shillelagh tagged, all unticked.
  - rs-4: Apply shows "Bree is re-synced". The token panel and the DM's device show level 6 and Charisma, and Cy's device has neither `stats` nor `ddbSync`.
  - rs-5: Undo the re-sync brings level 5 back.
  - rs-6: Re-sync, Overwrite all and Apply give Wisdom and Shortbow back. A Re-sync right after reads "Nothing new from D&D Beyond." and Done sends nothing.
  - rs-7: a `private` answer shows its words, and pasted fixture JSON reaches the review. A `busy` answer shows its words.
  - rs-8 (the DM, 1440 x 900, Bree's page, keys only): Tab to an Overwrite, Space, Apply. Focus lands on "Bree is re-synced", and Escape returns it to Re-sync. The toolbar's Undo names "re-syncing Bree from D&D Beyond".
  - rs-9: a 40-roll fixture at 360 x 780, 390 x 844 at 130% and 844 x 390: no sideways scroll, "Rolls (40)" folded, Apply in view.
  - rs-10: no page logged an error.
  - Run resync, pcstats (its step 5 meets the new review) and reach.

## 6. Build plan

One builder, after attach and traps, on their tip:

1. `feat(characters): a character remembers what its last d&d beyond sync set`: shared/model.ts, shared/protocol.ts, shared/limits.ts, shared/migrate.ts and its test, shared/reducer/tokens.ts (`characterUpdate`), shared/permissions.ts, client/features/tokens/access.ts, server/rooms/actor.ts (`writesPcStats`), server/rooms/undoLabels.ts, server/rooms/stateSchema.ts, and their tests.
2. `feat(rules): a d&d beyond re-sync merges three ways`: shared/rules/pcSync.ts (new) and its test, the HP rule moved there from fill.ts, shared/ddb/read.ts and its test (the AC warning).
3. `feat(ui): re-sync a character from d&d beyond`: client/features/pcstats/Resync.tsx, resyncFlow.ts, SyncReview.tsx and resync.ts (the words) (all new) and their tests, open.ts (the dialog's slot beside the editor's, drawn by `PcStatsHost`, so client/pages/Room.tsx is untouched), PcStatBlock.tsx (the button and the line).
4. `feat(ui): the editor's d&d beyond step merges as a re-sync does`: PcStatsEditor.tsx, flow.ts, fill.ts, ddb.ts and their tests.
5. `test(e2e): re-sync from d&d beyond`: e2e/resync.e2e.ts (new), e2e/pcstats.e2e.ts step 5.
6. `docs: re-sync in the feature list, the dm guide and the design`: FEATURES.md, docs/dm-guide.md (the D&D Beyond paragraph, lines 852-854), docs/design.md (6's character, 8.1's owner fields, 16.2's Versioning, 16.4's export), and a "Changed by" line in the stat block note's 6.1.

**Shared with the lanes in flight.** Attach, in review, and traps after it both edit shared/model.ts, shared/protocol.ts, shared/limits.ts, shared/migrate.ts, shared/permissions.ts, shared/reducer/tokens.ts, server/rooms/actor.ts, server/rooms/stateSchema.ts, server/rooms/undoLabels.ts, FEATURES.md and docs/design.md. Each of those edits here is a character's field, the character patch, `characterUpdate`, one fields line, `writesPcStats` or one label line, apart from their token, move and trap code. The migrate constants and step lists, and 16.2's paragraph, are appended in build order, so this lane goes last and takes the next pair. Nothing here touches client/features/attach, panels/TokenPanel.tsx, tokens/CreatureHeader.tsx (attach's), panelOrder.ts, or any trap file: the token panel changes only through PcStatBlock.tsx, which neither lane edits.

**FEATURES.md**, in "## Characters and monsters", the fill bullet's "Importing again replaces what it read and keeps the rolls you added." becomes: "Re-sync from D&D Beyond, beside Edit, brings in what changed there since the last sync and keeps what you changed here, such as a Spellcasting ability or a renamed weapon. It lists each kept change with Overwrite, and Overwrite all, and Undo takes a re-sync back."

## 7. Decided, for the project owner to overrule

Asking is off. Each point takes the likeliest choice from the owner's words and the past decisions:

1. **It lives in the Stat block group, beside Edit**, on the token panel and the character's page, one tap to start. Rejected: inside the editor only (six taps: Edit, D&D Beyond, Get it, Use it, Save, close), the tracker row or the action bar (mid-fight places for a between-sessions task), the sheet link (it opens D&D Beyond).
2. **Apply sends at once**, after a review, and Undo is in the done state. Rejected: through the editor's draft and Save, which doubles the review.
3. **The editor's D&D Beyond step uses the same merge and review**, so there is one rule for D&D Beyond. Rejected: keeping today's replace-all fill beside it, which would undo kept changes through the other door.
4. **The record keeps field values and roll hashes on the character**, 6 KiB at most. Rejected: copies of the rolls (up to 12 KiB more on every HP resend), hashes for the fields too (larger than the values, and the review could not say what D&D Beyond said last time), a collection of its own (a key kind and a snapshot step for a small value), a per-field "edited" mark (every writer of a field would have to set it).
5. **Manual means different from the last sync, by value.** Edited back, it is untouched. Rejected: an edit history, which every surface would have to write.
6. **A character with no record keeps every difference**, listed as "Different from D&D Beyond", with Overwrite all one tap away. Every block imported before this feature is in this case, with any Spellcasting ability set by hand since. Rejected: taking D&D Beyond's for every difference, as the import did, which is the loss the request describes.
7. **A changed roll is one item.** Rejected: a merge part by part inside a roll. "On a pass" stays out of the hash, so setting it never makes a roll the player's.
8. **A roll the player deleted stays deleted**, listed with Add it back. Rejected: bringing it back as new.
9. **The name is always an offer, unticked**, as the import's today. **The sheet link** is set only when there is none.
10. **AC and Speed are left alone in a shape.** Rejected: writing the character's own values under the shape (`unshaped` is the reducer's).
11. **A player's Undo is the dialog's, until it closes.** Rejected: a player's undo stack holding character edits (it would let a player churn stored blocks past the bucket, stat block note 4.1), and a toast with an action (no toast has one).
12. **The server route and budgets are unchanged.** Rejected: merging on the server, which would need room state in the route and would freeze the merge into replay.

## Appendix A. Sizes

Measured with `JSON.stringify`, 36-character ids (uuidv7):

| What | Bytes |
| --- | --- |
| A typical druid's base (level 5, 4 skills, one bonus, Darkvision) | 388 |
| A base at every bound | 1,782 |
| One roll entry | 78 |
| A record with 32 rolls, typical base | 2,989 |
| With 40 rolls | 3,621 |
| 40 rolls, 64-character ids, every bound | 6,135, within 6 KiB (6,144) |
