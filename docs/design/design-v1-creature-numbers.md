# Creature numbers

Creatures that share a name read "Goblin 1", "Goblin 2" so that everyone at the table names the same one. From room format 46 and change format 60, the table gives those numbers: a creature takes its number when the party first sees it beside another creature of the name players read, and every device reads that number. The DM's board also shows, in brackets, the number a creature the party has not yet seen would take. This note gives the rules, what is stored, what each viewer reads, how older rooms come across, and where the build went its own way.

## 1. Words

- **Shown name**: `shownName(token)` in shared/numbering.ts, the name a player's copy of the creature carries. It is `publicName` (or "Unknown creature") while the name is hidden, and `name` otherwise. Every rule below groups creatures by it, so an Orc shown to players as a Goblin is a Goblin to every rule, and two creatures whose names are hidden are both "Unknown creature".
- **Numberable**: `numberable(state, token)`. The token is a monster or an NPC, and it is not a companion that players read as one (a companion of a character a player plays). A companion of a character no player plays is numbered as the plain creature it looks like.
- **Seen by the party**: the party's copy of the room holds the creature. It stands on the players' scene, on a floor players see, in sight of the party or on a scene where players see for themselves and a sight holder sees it, and no blackout is on. A creature the DM hides (`visibility: "dm"`) is never seen.
- **Scope**: a scene with all its floors, named by its main floor. Floors share one set of numbers, so a climb changes no number.

## 2. What is stored

- `Token.met`: the id of the group the creature was numbered in. The DM's alone.
- `Token.number`: as before, but it counts only beside a `met` that matches.
- `Scene.numbers`: on the main floor only, `{ names: { [shownName]: [groupId, given] } }`, where `given` is how many numbers that name has given on the scope. The DM's alone.
- `RoomState.numbering`: `{ rev, groups }`, the number of groups the room has ever made, under the `numbering` key. A new group takes `groups + 1`, so a group id is never used twice in a room. It reaches no device: every projection leaves it out, and a restore refuses it.
- **Member**: `memberOf(state, token)` holds only when the token has `met`, its scope has `numbers`, the shown name has an entry of its own there, and the entry's group is the token's `met`. `tableNumber(state, token)` is the token's `number` for a numberable member and nothing otherwise.
- A member is judged by the name and scope it has now. A creature renamed, its name hidden or shown, or moved to another scene and back while the party does not see it, returns as the member it was. In another scene its mark matches no group, so it is numbered there afresh when seen.
- A number on its own counts for nothing: a number from before change format 60, one under another shown name or scene, and a copied one all fail the member test.

## 3. The meeting

- From change format 60 `token.create` numbers nothing, and a client's `token.create` or `token.update` that sends `number`, `null` included, is refused. A companion attached to a character keeps its `number` and `met`.
- At the close of every batch that answered something, after the explore and map steps, the room runs the meet step (server/rooms/meet.ts) on the state the batch publishes, and appends a `sys.meet { tokenIds }` op for what it finds. The step reads from the batch's start and every key the batch touched, and runs once, never inside the batch where the steps run before a walk. A `sys.meet` op names at most 500 creatures, and a batch with more gets several. It is the server's own op, never refused, and replay applies it without working out sight.
- **Candidates**, in id order: every numberable creature the party sees that is not a member, and every numberable member with no number while its name has given 2 or more. The second kind is looked for among the creatures the batch touched, the creatures on the players' scene, and every creature after a change to a member or a character, since those can make a creature numberable without touching it.
- **The rules** (`sysMeet`, shared/reducer/numbering.ts), for each creature in order, skipping one that no longer fits:
  1. The shown name has no entry: it gets one with a new group and a count of 1, and the creature joins with no number. A creature seen alone reads "Goblin".
  2. The name has an entry and the creature is not a member: the count goes up by one, and the creature joins with that number. When the count becomes 2, the group's first member, which has no number, takes 1, if it still exists and is numberable.
  3. A numberable member with no number while the count is 2 or more takes 1. This is the first member brought back after the second was seen, or one whose kind or companion state changed back.
- A count never goes down and a group never gives a number twice. A deleted creature's number is not used again.
- **Caps**: 100 names a scope (a name seen alone counts) and 10,000 numbers a name. Past either, a creature that would start a new entry or take a new number stays unnumbered for everyone. A member's 1 under rule 3 is never capped.
- **The skip**: the step does nothing when the batch touched no key of a token, scene, character, member, the room's meta, fog, explored ground, sight holders, opened floors, played scenes, build chunks or lights, and moved no sight on the players' scene.
- A step that throws is logged, and the batch commits with nothing numbered.

## 4. What each viewer reads

- **A player**, owner or not, gets `number` only when `tableNumber` gives one, and never `met`. A member whose name is hidden is numbered under its shown name: players read "Unknown creature 2".
- **The DM** gets the creature with `met`, and with `number` only when it is the table's, worked out each time the creature is sent. A copy that differs from the stored creature is kept per creature and per number, so a member's kind change, which can make a companion numberable without replacing its token, sends the other copy.
- `tableNumber`, `memberOf` and `numberable` read the server's state. On a device the labels read `number` as sent, and only the DM's device reads the scenes' `numbers`, for its previews.

## 5. Labels

| Who | Creature | Reads |
| --- | --- | --- |
| Everyone | Numbered by the table | "Goblin 2" |
| Everyone | Seen alone, or with no namesake | "Goblin" |
| Players | Name hidden, numbered | "Unknown creature 2" |
| DM and owners | Shown to players under another name | "Orc (as Goblin 2)", with initials and badge "G2" |
| DM | Not yet seen, with namesakes | "Goblin (3)", with an outlined badge and outlined initials "G3" |
| DM | Shown under another name, not yet seen | "Orc (as Goblin (3))" |

- shared/numbering.ts holds the label rules for the server and the device. `publicLabel` (shown name and table number) is what every stored text and every op uses. `ownLabel` (real name and table number, or the "(as ...)" form) is for the DM and owners, and server-made DM text uses it. `boardLabel` adds the preview, only when the viewer's role is the DM's. The server never makes a preview.
- **Previews**: `previewNumbers(view, scopeId)`. For each shown name, the numberable creatures of the scope that are not members, in id order, take the next numbers after those the name has given. A name with no entry and one such creature has none, and there is none past a cap. A companion players read as one is never ranked. So brackets say what the meet step would give if the party saw them all now, and no two creatures share a label.
- **The device** (client/state/labels.ts) works out a label map once for each view and role, keeps each entry's object while it does not change, and `displayName(token, labels)` (client/lib/scene.ts) reads it everywhere a creature is named. `initialsOf(label)` (client/lib/tokenView.ts) gives the initials and whether they are a preview.
- **Words shown.** The token panel says, under the name of a creature with a preview, "Not yet seen by the party. It takes this number when they see it, if they have seen no other first.", under a numbered disguise "Players read Goblin 2.", and on a scope at its cap "The party has met 100 creature names on this scene, the most it keeps numbers for. New names get no number here."
- **Screen readers.** A preview reads "Goblin, would be 3, not yet seen by the party". A disguise reads "Orc, shown to players as Goblin 2". The token panel's heading reads these words, and the bar's name keeps the label's text.
- **Large interface sizes.** When a label is cut, the name is cut first, and the " 2", " (3)" or " (as Goblin 2)" after it stays. An "(as ...)" part that still does not fit is cut inside before its number: "Orc (as Gob… 2)". Outlined badges and initials keep the boxes of filled ones.

## 6. Older rooms

- **The numbering upgrade**, `numberingUpgrade(state)` in shared/reducer/numbering.ts, runs once where the map discovery upgrade runs: on load, just before the first stored op of change format 60, or after the last op when none is that new, and after an imported file's migration. It judges sight as change format 60 does, so a later sight rule cannot change a reload before the room's next save.
- On the players' scene, with no blackout on, each numberable creature the party sees that carries an old number and a shown name keeps it and joins its name's group, and the count becomes the highest kept. Of two creatures of one name with one number, the lower id keeps it. Up to 100 names keep their numbers, names holding a number first, then names seen alone, each in the id order of the name's lowest creature the party sees. Every other numberable creature the party sees then meets by rules 1 and 2.
- Elsewhere, and behind a blackout, no old number is kept, and no later visit, reveal or floor opening keeps one. A creature from before takes its number when it is seen.
- The first commit after a load that ran the upgrade saves the room at room format 46 in the same transaction as its rows. If that snapshot cannot be built or written, the commit fails and is tried again, so no row of change format 60 is stored without it, and an older build refuses the room rather than load numbers it would not keep.

## 7. Renames, undo and copies

- A creature the party sees whose shown name changes joins the new name at the batch's close. Changed back by hand, it takes that name's next number: "Goblin 2", "Orc 3", then "Goblin 4". Out of sight nothing changes, and the way back restores the number.
- **Undo and Redo are exact.** A restore that writes a creature uses `keepNumbering(stored, current)`: when the stored `met` makes the stored creature a member, it takes the stored `met`, and the stored `number` unless the current creature is in that group, whose number then stands. Otherwise it keeps the current fields. A restored scene keeps its current `numbers`, and a scene brought back returns with the numbers it was deleted with.
- A DM's undo of a move takes back the creature's `met` and `number` with its scene. Undo guards leave out `number`, `met` and a scene's `numbers`, so a meeting between a change and its undo refuses nothing.
- A duplicated creature and a duplicated scene carry no `number`, `met` or `numbers`. An imported companion keeps its `number` and `met`.
- An import keeps the room's `numbering`, and a file whose group count is below any group id it holds is refused.
- A party member's companion, a character whose player changes and a creature moved to another scene follow the same rules: the number counts the creatures the party has seen under the name players read.

## 8. Sizes

`sys.meet` writes after the size checks, so every check holds room for it. `numberingAdjust(state)` in server/rooms/sizeGuard.ts counts each monster and NPC with a `number` of 10,000 and a 16-digit `met` whatever it holds, and its `rev` at 16 digits, and each scene with its `rev` at 16 digits and without its `numbers`. The room's `numbering` counts nothing. The state measure, the measure from a stored snapshot, the room-level part of a scene, a token's part of its scene and the growth bound all use it, so a meeting moves no measure and grows nothing. A scene's numbers stay under their own bound of about 51 KB, from the caps.

An older room may hold a scene this puts over its limit. Its load logs "a scene is over its size limit once creature numbers are reserved" once for each such scene, with the room's and the scene's ids.

## 9. Formats

Room format 46 and change format 60 each step once. The room format's step is the identity, and the numbering upgrade is keyed to it (`needsNumberingUpgrade`). Change format 60 adds `sys.meet`, numbers nothing at `token.create`, refuses a sent `number` and keeps an attached creature's number. Stored ops from before replay as they ran. The update note is in [docs/self-hosting.md](../self-hosting.md).

## 10. As built

- A sent `number` is refused by the client op schema alone, so stored ops from before still parse.
- The label functions take the room's state or nothing first: the state judges the number, and on a copy the number is read as sent. A disguise with no number and no preview reads "Orc" alone.
- The label map is not a store field. `labelsOf(state)` keeps it per view object and role, and returns the previous map when no label changed, so the board lays labels out again only when one does.
- A disguise's bracket wraps between its words with "(as" kept with the first word and the number with ")" kept with the last. The name is cut first to four letters, then the shown name inside its brackets to three.
- The meet step runs once at a batch's close, on the state the batch publishes, with the batch's start and all the keys it touched. Candidates of the second kind also come from the players' scene. The skip's sight test compares the sight keys of the players' scene, which also catches daylight from the clock.
- The first save after an older snapshot is required for every snapshot below room format 46. A build that throws is tried again on the commit's back-off, and a room closing meanwhile drops the batch.
- The import runs the upgrade after its ids are renewed, on the players' scene the file names.
