# raccoon-vtt v1: a Druid's known forms

Status: built. It reached consensus in design review round 2, and the build follows it with the round 2 notes applied: the import's empty list is stored as none in a named place (3.1), and the rename mapper serves an import only from before snapshot version 14 (3.4). Code is cited from the batch tip `1145718c`. It builds on docs/design-v1-pc-stats.md (sections 3.6 and 7.3, a shape on the character's own token) and on the "Druid level" filter being built beside it in `client/features/pcstats/ShapePicker.tsx` and `shapeLevel.ts` (`shapeLimit`, `fitsShapeLimit`, `byCrThenName`, `DRUID_LEVELS`), which this note uses as that build has it and does not redesign.

On 2026-10-18, right after asking for that filter, the project owner asked: "also as part of this druids should be able to pick a loadout of wild shapes they have prepared".

## 1. Summary

- **Data.** A character gains `knownForms`, up to 8 SRD ids, beside its `stats`. The DM and the character's players edit it, as they edit the stat block, and no one else receives it. One field of `character.update`, no new op.
- **The rule is shown, not enforced.** The count is read against the Beast Shapes table for the Druid level chosen in the picker, and a form outside that level's CR or Fly Speed limit is marked. Nothing is refused but the cap of 8. Replacing one form after a Long Rest is stated, not tracked.
- **UI.** Take a shape lists the known forms first, and one tap takes one as Wild Shape. "Change" opens a step that toggles forms in and out with the search, Beasts only and the Druid level. The token panel's Stat block group, and the character's card, show them as one-tap buttons.
- **Versions.** `OP_VERSION` 11 and `SNAPSHOT_VERSION` 15, identity steps, taken before movement, attach and traps take theirs.

## 2. The rule, from the SRD

The repository carries no class text (`shared/srd` holds the monsters, the rules glossary and spell tables), so this was checked against the SRD 5.2.1 document, Druid, "Level 2: Wild Shape". **Known Forms**: "You know four Beast forms for this feature, chosen from among Beast stat blocks that have a maximum Challenge Rating of 1/4 and that lack a Fly Speed." "Whenever you finish a Long Rest, you can replace one of your known forms with another eligible form." The **Beast Shapes** table: Druid level 2, 4 forms, max CR 1/4, no Fly Speed. Level 4, 6 forms, CR 1/2, no Fly Speed. Level 8, 8 forms, CR 1, Fly Speed. And: "When choosing known forms, you may look in other sources for eligible Beasts if the Game Master permits you to do so." The brief's numbers match.

## 3. Data

### 3.1 Where it lives and its shape

On the character, not its actor and not inside `stats`:

```ts
// Character gains (shared/model.ts)
knownForms?: string[]   // SRD ids (protocol's srdId pattern), 1 to MAX_KNOWN_FORMS, each once, in the order chosen. Absent is none, never []
// shared/protocol.ts, beside MAX_PC_ROLLS
export const MAX_KNOWN_FORMS = 8   // the Beast Shapes table's most
```

- **Not the actor**: a PC's tokens patch the actor through `token.update` too, under the actor's own owner field list and HP rules. Known forms are something the character knows, as its level is. **Not `stats`**: a druid with no stat block still takes shapes (pc-stats 3.6), and a block write spends the per-member budget and the 12 KiB bound, which 8 short ids do not need.
- **Only SRD ids**, as a shape is only an SRD link (pc-stats 3.6: a `monsterId` is not a shape, since a player's view lacks it).
- **Bounds**: `characterPatch.knownForms` is `z.array(srdId).max(MAX_KNOWN_FORMS)` with the `unique` refine `saves` uses. At most 8 ids of 80 characters, under 1 KiB on a character resent on every HP change. `character.create` does not take it: a new character knows none. The import schema (`server/rooms/stateSchema.ts`'s character) takes it with the same bound, `[]` included. The remap's character loop (`remapState`, `server/rooms/remap.ts`) stores `[]` as absent and leaves any other list as it is, since SRD ids are not room ids.

### 3.2 Ops, reducer, permissions, `canApply`

- **Op**: `character.update`'s patch gains `knownForms: string[]`, which replaces the list whole. An empty list removes the field, so none and absent are one state. Two co-owners editing at once: the later op wins, as with a stats part (pc-stats 10).
- **Reducer** (`characterUpdate`, `shared/reducer/tokens.ts:483`): sets or deletes the field. It reads no SRD data, so it never checks that an id exists or is a Beast, as it never checks a shape's `srdId`, and a replay never depends on data a later release may change.
- **Permissions**: `OWNER_CHARACTER_FIELDS` gains `knownForms` (`shared/permissions.ts:66`) and its client mirror (`client/features/tokens/access.ts:53`, with `canEdit`'s field list). The DM may edit any character. Another player, or a player who owns only one of its tokens, gets `NOT_YOURS` (`ownsCharacter`). It is no block op (`isBlockOp`, `server/rooms/actor.ts:221`): the socket's op rate bounds it as it bounds a name edit.
- **`canApply`**: nothing beyond the owner field rule. It does not look ids up in the server's SRD data either: the table decides what a form may be (section 4), and an id the data lacks reads as such in the UI (section 6).

### 3.3 Projection

No change. `projectCharacter` (`shared/project.ts:618`) gives the DM the character whole and its owners all of it but DM-only actor parts, so both receive `knownForms`. Anyone else gets a fixed list that lacks it: other players, a player who owns only one of its tokens, the table display, and "View as a player" previewing one of them. A blackout keeps it, as characters are not scene data. A `project.test.ts` row pins each viewer, so a later edit of that list cannot leak it. So the answer to "unless they already see the stat block" is exact: exactly the viewers who receive `stats` receive `knownForms`.

### 3.4 Undo and replay

- **Undo**: the DM's edits go on the DM's stack with the character's other edits, labelled "changing Bree's known forms" (`server/rooms/undoLabels.ts:123`), and an undo puts back the character whole under its guard, as any character edit. A player's go on no stack, by the rule for players' stacks. No log line, as for other card edits.
- **Replay**: no stored op before this build carries the field, and no older op's outcome changes, so the reducer needs no `opVersion` gate.
- **SRD renames**: `knownForms` joins the fields `shared/migrate.ts` maps when an SRD id is renamed (`SRD_ID_LIST_FIELDS`, beside `SRD_ID_FIELDS`, in `withMappedSrdIds`). The list's mapping maps each id, then drops repeats in order, keeping the first, so `["dragon-tur-t-le", "dragon-turtle"]` becomes `["dragon-turtle"]` and still passes the `unique` refine. That one mapper serves the live op (`withTodaysSrdIds`, `server/rooms/actor.ts:881`, which runs after the schema parse), stored-op replay, the snapshot steps and an import from before snapshot version 14, since a current-version file runs no rename step. So none of them stores or replays a repeat, which replay's schema check would refuse and leave the room read-only.

### 3.5 Versions, and the order with the Later three

By the repository's rule (design 16.2's Versioning paragraph, as op 9 and schema 13 did for a grid import's mark in `shared/migrate.ts`): a new optional field in a stored op and in the stored room, which an older build's strict schemas refuse (`characterPatch` and the state schema are strict objects), moves both numbers with identity steps. An older build then refuses the room cleanly instead of failing its replay or its export. So this takes **`OP_VERSION` 11 and `SNAPSHOT_VERSION` 15** (both 10 and 14 today), each step returning what it is given, with the usual deploy and rollback comment: back up just before, and going back is the backup's restore (README, Updating).

Known forms ships before movement, attach and traps. Each of those notes takes "the next free pair at build time" in the order movement, attach, traps (docs/design-v1-movement.md 248, docs/design-v1-attach.md 250, docs/design-v1-traps.md 245), so they become 12 and 16, 13 and 17, then 14 and 18, and their notes need no edit. Nothing here depends on the number: if another bump lands first, this takes the pair after it.

## 4. Enforce the rule, or show it

**Recommended: show it, and let the table decide.** The count reads against the Beast Shapes table for the Druid level chosen in the picker, with words that say when it is over, and a known form outside that level's CR or Fly Speed limit keeps its place with a mark and still takes in one tap. Only the cap of 8 is refused, by the schema.

- **Precedent**: pc-stats 3.6 and 7.3 show the rule and leave the call: Beasts only is a checkbox, the Druid level filter is optional, the Temporary HP are a checkbox, and Wild Shape's uses are not counted. The DM's size changes are never stopped either (FEATURES.md, tokens).
- **The rule bends at real tables**: the SRD lets the GM allow other Beasts, and subclasses outside the SRD raise the CR limit. A refusal would need a way around it.
- **Cost**: enforcing needs the Druid level stored on the character (multiclassing makes it differ from `level`), the server reading SRD data at `canApply`, and a DM override, for a check the table already makes.

**Replacing one after a Long Rest: not tracked.** The step's help states it. Tracking needs a mark that `actor.rest` clears, a reducer rule gated by op version, and exceptions for a level-up (level 4 adds two forms at once) and a DM's ruling. The app leaves Wild Shape's uses to the table the same way.

## 5. UI

### 5.1 Take a shape: the known forms first

```
 Take a shape                                         ×
 An SRD creature for Bree's token to take the shape of. …
 KNOWN FORMS        3 of 6 at Druid level 4     [Change]
 ┌ Black Bear     Medium Beast                CR 1/2 ┐
 ┌ Wolf           Medium Beast                CR 1/4 ┐
 ┌ Owl            Tiny Beast       [Fly Speed]  CR 0 ┐
 [ Search: wolf, cr 0-1                              ]
 [x] Beasts only      Druid level [ 4 ▾ ]
 Up to CR 1/2, no Fly Speed.
 ALL CREATURES
 ┌ Ape ...
```

- **The group** sits above the search, which filters only the list under it. Its label row holds "Known forms", the count (5.4) and "Change" (a `SmallButton`), wrapping as one row. The forms are `MonsterList` rows sorted by `byCrThenName`, and the list below is headed "All creatures".
- **One tap takes the form** as Wild Shape, with the Temporary HP by the step's default (5.5's Druid level, only where more than it holds, through `shapePatch`), sends the one `character.update` Take the shape sends, and closes the picker. A row's accessible name is "Wild Shape as Wolf". The full list keeps its step, for Polymorph and the checkbox.
- **Marks**: with a Druid level chosen, a form outside its limit gets a muted `Tag` before its CR (`ListedRow.tag`), "Over CR 1/2" or "Fly Speed", drawn whole (only a character's name in a tag is cut at 88 px), and the reason joins the row's name: "Wild Shape as Owl, has a Fly Speed".
- **Empty state**: one `Help` line, "Bree knows no forms yet. A Druid knows 4 Beast forms at level 2, 6 at level 4 and 8 at level 8.", and "Choose known forms" in place of Change.
- **Loading**: the rows need the SRD list's names, AC and speeds, so the group waits under the picker's existing "Loading the creatures…", and the SRD failure line covers both.

### 5.2 The step that chooses them

"Change" opens a step of the same dialog (`back`: "Back to the creatures", `phone="fill"`), titled "Bree's known forms":

- **Help**: "The Beast forms Bree knows for Wild Shape, listed first in Take a shape. By the rules a Druid replaces one after each Long Rest, and the DM may allow other Beasts."
- **The count**, live, under the help (5.4).
- **The same search, Beasts only and Druid level**, one state with the first page, so a level chosen on either carries to the other, and the limit line.
- **The list**: the known forms first, always listed with their marks whatever the search and the level filter, so a marked one can still be removed, then the creatures the filters keep. Each is a toggle row: `Row` gains `pressed` (`aria-pressed`, the `chosen` tint and outline without `chosen`'s `aria-current`, and a check in the leading slot), so a screen reader hears "Wolf, toggle button, pressed". A tap sends one `character.update` with the whole new list (`toggleKnownForm`), as a condition toggle sends its op: no Save, no discard question, and the prediction shows it at once. At 8, the unpressed rows are disabled. The rows are one keyed list, and a key press keeps the focus on the row it toggled, or, when the filters drop a form taken out, gives it to the row now in its place, else the count. A refusal shows in the server's words on whichever page of the picker is open when it comes, and Back and Change clear it.

### 5.3 The token panel and the card

`PcStatBlock` gains a "Known forms" `Section` first in the Stat block group, for the DM and the character's players (whoever sees the group, `statBlockShown`), when the character has known forms and is in no shape or in Wild Shape. The forms are `SmallButton`s in one wrapping row, sorted as above, each taking that form as in 5.1. Their visible text names them, and they pass no `label`, which would also set a native `title`. They read `useSrdList` for names, CR, AC and speeds, so the section shows a Loading line ("Loading the known forms…") while it loads and an inline `SrdLoadFailed` on failure, as `ShapeBody` does, and an id the list lacks shows as muted text with no button. In Wild Shape the buttons are toggles: the current form shows pressed and unavailable (`aria-disabled`, so a tap that made it current keeps the focus), and another changes to it, which is using Wild Shape again: the reducer keeps the first AC and speeds (`withUnshaped`), and the new form's Temporary HP go only where more than held (`shapePatch`). In another shape, such as Polymorph, the row is not drawn: End the shape first. The group's folded summary reads "4 known forms" where it would read "None yet". The character's card shows the same section, since it renders `PcStatBlock`. The action bar and the tracker do not change.

### 5.4 Words and phones

- **The count**, the first case that holds, with the label row's short form after it (`knownFormCount(level)` gives 4, 6 or 8 from level 2):
  1. A Druid level, over its count, in the warning tone: "7 known forms, 1 more than a level 4 Druid knows." Short: "7 of 6 at Druid level 4".
  2. A Druid level: "4 of 6 known forms at Druid level 4." Short: "4 of 6 at Druid level 4".
  3. Any, at 8: "8 known forms, the most there are." Short: "8 of 8".
  4. Any: "4 known forms." Short: "4".
- **Style**: sentence case for labels and buttons. SRD capitals for rules terms: Druid, Beast, Wild Shape, Long Rest, Fly Speed, CR, Temporary HP. "known forms" stays lowercase in prose, as the SRD writes it.
- **390 x 844**: the picker fills the screen and scrolls as one. Rows are 56 px with their detail line, so 8 forms take about 480 px and the search follows them. Panel buttons are 44 px and wrap. At 320 px or 130% text, a row's name cuts with an ellipsis and its mark stays whole.
- **Keys**: none added or changed, so the shortcut sheet needs no row.

### 5.5 The Druid level and the Temporary HP

- **Remembered per character on this device**, as the dice history is (`rvtt.druidLevel.<room>`, an object by character id, every read and write in try/catch). Picking a level remembers it, and picking Any remembers Any (null), so a player who uses Polymorph is not taken back to the character's level each time (decided in build review round 1). Another device starts from its own memory.
- **Where the select starts**: the remembered level or Any, else the character's level when it has known forms and is level 2 or more, else Any. A character at level 1 or with no level starts at Any, since the level lane's `DRUID_LEVELS` is 2 to 20 and offers no 1. The lane's rule stays: `shapeLimitMiss` gives `"cr"` at `maxCr === null`, so `fitsShapeLimit` still keeps no creature below level 2, though the select never offers one. A start level filters "All creatures" too, and Any removes the Druid level filter again, as Polymorph needs.
- **Temporary HP**: the Wild Shape step and the one-tap buttons, in the picker and the panel, give the remembered Druid level when one is set, else the character's level, as today (`shapeTempHp` gains the level). The step's checkbox help says which: "Druid level 4, as picked in Take a shape." or "The Druid level, read as Bree's level."

## 6. Edge cases

| Case | Outcome |
| --- | --- |
| A ninth form | The step disables the rest. Sent anyway, the schema refuses it |
| An id the SRD list lacks (a later rename, a crafted op) | Muted text, "cave-bear: not in this app's SRD list", with nothing to take. The step removes it |
| A level 1 character with known forms and no level remembered, reopened | Starts at Any: no Druid level filter, no marks |
| A tap by mistake | End the shape ends it. Wild Shape's Temporary HP stay by the rules, and the HP field sets them back |
| Ownership lost or the character deleted while choosing | The refusal's words, as for any character edit |
| A form over the chosen level's limit | Marked, kept, takes in one tap |
| No level chosen | Count without "of", no marks |
| Export, import, an older build | The field travels. An older build refuses the room (3.5) |

## 7. Tests

- **Unit, the rule** (`shapeLevel.test.ts`): `knownFormCount` at 2, 3, 4, 7, 8 and 20. `shapeLimitMiss(limit, m)` gives `"cr"`, `"fly"` or null, `"cr"` at `maxCr === null`, and `fitsShapeLimit` is its null case, so the mark and the filter never disagree.
- **Unit, the client** (`knownForms.test.ts`): `toggleKnownForm` adds, removes, keeps order and stops at 8, the count's four cases and short forms (5.4), the sort, an unknown id, the start level of 5.5 (remembered, level 9, level 1, none, storage that throws), and the Temporary HP from a remembered level and without one. `client/features/tokens/access.test.ts` gains the mirror's `knownForms`.
- **Unit, shared**: `protocol.test.ts` (8 accepted, 9 and a repeat refused, the id pattern, `[]`). `shared/reducer.test.ts`, beside its other `character.update` cases (set, replace, `[]` stored as absent, other fields kept). `permissions.test.ts` (DM, owner, co-owner, another player and a token-only owner refused). `project.test.ts` (3.3 as a matrix). `undoLabels.test.ts` (the label). `stateSchema` (imports, `[]` normalized to absent, 9 refused). `migrate.test.ts` (both identity steps, and `["dragon-tur-t-le", "dragon-turtle"]` becoming one id in a live op, a stored op, a snapshot and an import).
- **Integration**: no route changes, so no new itest. `pnpm -s test:int` runs in full.
- **e2e** (`e2e/pcstats.e2e.ts`, after step 4, labels `knownforms-a` on): Ana at 390 x 844 opens Take a shape, sees the empty state, taps Choose known forms, picks Druid level 4, adds Black Bear and Wolf ("2 of 6 known forms at Druid level 4."), picks Any, adds Owl, picks 4 again and goes back. The group lists Black Bear, Wolf and Owl, with Owl marked "Fly Speed" at level 4. One tap on Wolf takes Wild Shape ("In Wild Shape as Wolf"), and Bree's 9 Temporary HP stay, as the remembered level 4 gives fewer. The panel's Black Bear changes the form, and End the shape ends it. The DM's panel shows the same row. Cy's projected Bree has no `knownForms`. Shots `pcstats-known-forms` and `pcstats-known-forms-choose`. Run `pcstats`, `tokenpanel`, `characters` and `reach` during the build.

## 8. Build plan

One builder, after the Druid level filter lands:

1. `feat(characters): a druid's known forms on the character` (model, `MAX_KNOWN_FORMS`, the patch and import schemas, the reducer, both owner field lists, the undo label, the SRD id mapping, `OP_VERSION` 11 and `SNAPSHOT_VERSION` 15 with their steps, the shared tests).
2. `feat(ui): known forms first in take a shape, and a step to choose them` (`shapeLevel.ts`'s `knownFormCount` and `shapeLimitMiss`, `client/features/pcstats/knownForms.ts` with 5.5's memory, `shape.ts`'s `shapeTempHp` level, `ShapePicker.tsx`, `client/features/monsters/MonsterList.tsx`'s `ListedRow` gaining `label` (a row's own accessible name), `pressed` and `disabled`, `client/components/Row.tsx`'s `pressed`, client tests).
3. `feat(ui): a druid's known forms as one tap in the stat block group` (`PcStatBlock.tsx`, its loading and failure lines, the folded summary).
4. `test(e2e): a druid's known forms` (`e2e/pcstats.e2e.ts`).
5. `docs: a druid's known forms in the feature list, the dm guide and the design` (FEATURES.md's Take a shape bullet, docs/dm-guide.md's Take a shape paragraph, docs/design.md sections 6, 8.1 and 16.2's Versioning paragraph).

**Deploy**: back up the database just before, as for every bump. Nothing to run after.

## 9. Questions for the project owner

Each has the recommended answer, which the coordinator takes unless the project owner says otherwise.

1. **Enforce the Known Forms count and the CR and Fly Speed limits, or show them?** Recommended: show them (section 4). The count and the marks say what the table allows, and the DM decides.
2. **Track "replace one after a Long Rest"?** Recommended: no. The choose step states the rule, and any form can change at any time.
3. **Does a known form's tap take the shape at once, or open the Wild Shape step?** Recommended: at once, as Wild Shape with the default Temporary HP. A form is known only for Wild Shape, so the step's one other question is the Temporary HP checkbox, on by default. The full list keeps the step.
4. **Show the known forms in the token panel's Stat block group and the character's card too?** Recommended: yes, as one-tap buttons (5.3), which is where play happens. In Wild Shape they change the form.
5. **Where does the Druid level start, and do the Temporary HP follow it?** Recommended: as 5.5 says. It starts at the level this device remembers for the character, else the character's level from level 2 once it has known forms, else Any. Wild Shape's Temporary HP follow a remembered level, as the SRD reads, so a Druid 4/Fighter 5 who picks 4 gets 4, not 9. A start level also filters "All creatures", and Any removes the Druid level filter again for Polymorph. The other answer keeps Any always, and the Temporary HP the character's level.

## 10. Decided, and later

- **Decided**, for review to overrule: at most 8, the table's most. SRD ids only. No new op. No budget. `character.create` takes none.
- **Later**: a known form that names one of the token's other images, so taking it swaps the picture too (design 6, Other images). A Druid level stored on the character, if enforcing is ever wanted. Room monsters as known forms, once a shape can link one.
