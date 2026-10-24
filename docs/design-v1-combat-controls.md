# raccoon-vtt v1: combat controls

Status: built. Draft 5, 2026-10-23, revised for design review rounds 1 to 4 (findings CC-OPUS and COMBATCTL-ASTRA), and the build follows it with the differences under "As built" below. Code is cited from main at `ac82b9e3`. The build rebases onto the change that keeps each log audience in its own ring (op version 19, snapshot version 21), which lands first, so this design names only that change's helper calls.

**As built.** Where the build differs from the text below:

- **Keys** (2.1): a slug is cut over 44 characters, to 37 plus `-` and 6 hex digits, not over 40 to 33. The wererat's "Hand Crossbow (Humanoid or Hybrid Form Only)" slugs to 42, so the 40 rule would have moved an SRD key. A test rebuilds the old key rule and checks that no SRD roll key moves.
- **Spells stay out** (2.1): only entries named "Spellcasting" or "Innate Spellcasting" are spell lists. A name that merely holds the word, such as the pit fiend's "Hellfire Spellcasting (Recharge 4–6)", is the block's own recharge ability.
- **Cost** (2.1): the uses list cuts "(Costs 2 Actions)" from the name and shows the cost on its button ("Wing Attack (2)"). The Dice panel's row keeps it in the name, as it printed before, since that row has nowhere else to show it. Keys never hold it.
- **The recharge card** (4.5) takes the ability's name and range from its mark while there is one, else from the block's recharge entry, else the key. Once Mark ready or a roll clears the mark, the mark alone would leave only the key to show.
- **The uses list** (4.2, 5, 6): every row's buttons take a line of their own under its words. Beside the words where they fit, a row's height followed how many buttons it held, which the alignment check caught in one list.
- **The turn record** (2.3, 3.3): the saved step of a turn's start keeps each holder's block link (`TurnUses.link`), so Previous skips a holder relinked since. An HP take-back names the record it reopens (`HpRevert.record`). A stale record is removed at a start when the creature no longer needs one.
- **Recharge** (3.1, 4.5): spending a recharge ability while its turn's recharge roll is open settles that roll as ready, so a rest, a manual roll or a new block never reopens it.
- **Links** (3.2): one helper, `relinked`, drops marks whose block link changed, on a patch, a companion's detach or transfer and an import. A scene's copy keeps counted uses and drops the marks that last a turn, the damage types and the turn record, so its prompts are refused.
- **Permissions** (3.1): a class resource spent through a token that plays a character needs that character's ownership.
- **Log lines** (8): owners' projected `use` lines drop the `hidden` flag and keep the counts.
- **Regeneration** (4.3) on a dead creature with "Healing brings back the dead" off settles done with a total of 0 when Apply is pressed.
- **Class resources** (7.1, 7.2): the class level is a select of 1 to 20 rather than a stepper, which wrapped beside its label at 130%. A pool's give back is "Give back…", which opens the amount field. Update also offers the presets the new level unlocks, and Add, Update, Edit and Remove check the whole list against the server's limits before sending it.
- **Who acts now** (5, 13.1): one rule, `actsNow`, for the tracker row, a companion's sub-row and the token bar: the acting row is the creature's own, it is a companion that acts on that row's character's turn, or it has a current turn record, as a controlled mount does on its rider's turn.
- **Uses shows** (6) only where the list holds a row or the creature has class resources, so neither the group nor the drawer opens empty. Spent uses show at once while the block loads, over the list's loading line.
- **A recharge's words** (5) follow its mark: a roll's words stand only while the mark still says what the roll left, so a spend after a ready roll reads Used, and Mark ready after a used roll reads Ready. The prompt's card keeps its stored result.
- **Roll recharge from the list** (5) says why in the list's status line when its roll is refused or lost. The tag a uses list rolled is kept for the Room page, so the row's group and the bar's drawer show its result alike. With it the list keeps the turn it showed as it rolled (`turnKey`), and the line shows the newest failure by tag among the list's own rolls, once those a later tap silenced are left out, only while that turn is current. A list opened again never shows a failure a list already showed, and a roll sent with no turn says so only in the list open as it failed. A failure whose answer comes after its turn ended, which no list showed, goes to a toast once, in the receipts' own words (`listRollTrouble`, `tellPassed`).
- **In lair and joins** (3.1, 13.4): every path into a fight builds its rows with one rule, `joinEntry`: a saved encounter's drop, the tracker's Start a fight and Add to the fight, and a group's Start a fight and Add to the fight. A join, and the In lair switch, wait busy while an SRD block they need loads, and stay off beside the failure's reload when it did not load. A creature with no stat block keeps In lair with no counts. A saved encounter's line keeps its own choice, true or false, over the counts, which decide only for a line that holds none, since a block whose lair changes neither its counts nor its XP leaves them nothing to tell.
- **Toasts and the turn card** (4.6): the column also publishes `cover`, its first card's height counting a turn card, which only a toast keeps under, so a toast never lies over a lone turn card's Show. The bar's lane and a map pane still skip the turn card.
- **Column order** (4.6): concentration, save-ends, regeneration, death save, recharge, roll requests, time is up, notices, then the turn card. The turn card lasts the whole turn and gives way, and the bar's lane skips it, so drawn last it never stands above the first card the bar keeps whole. The summary row's order is unchanged, with the turn last. A bar stacked under the first card keeps 8 px and, while more cards follow, up to 48 px more for the column's "Scroll for more" fade (barDock.ts `COLUMN_FADE`, `firstFoot`), so the fade lies past that card and never over its words or its Dismiss.
- **A settled death save card** (4.4) shows its result alone, without the dying line and the pips.
- **The Dice panel's X/Day Use** (6) with none left says "No uses left" in its row's status line on a tap, and sends nothing.
- **A bar's Roll** (docs/design-v1-dice-pass.md 8): options that were not showing before the tap open already landed on the roll modes, with no glide, and a panel already showing still glides. The token bar now reads a creature's stat block for Uses as it opens, so a goblin's options drew in the panel's first frame and sat under the view for the whole glide, which CI caught.

The project owner, 2026-10-23: "For anything (sans things most characters have like spells) in combat it should be in the combat section. As an example there should be a "use legendary resistance"/"use legendary action" in the combat section for creatures that have them. These should also be in the token pop up menu for creatures that have them."

**The project owner's recorded picks**, fixed: legendary actions and lair counts, recharge as room state, counted X/Day uses, turn-start prompts (Death Save, Regeneration, recharge), once-per-turn legendary actions, class resource counters, and the placement (a turn card, the tracker row's options, the token action bar). Not picked, so out of scope: Use buttons for bonus actions and reactions with no dice, Action and Bonus Action used flags, Hit Point Dice counts, and spending Heroic Inspiration by itself. Spells stay out, as the request says. Everything else this doc settles is a recommendation from past decisions (section 13).

## 0. Today and the answer in short

**Today.**
- `Actor.legendary` holds `actionsMax`, `actionsUsed`, `resistMax` and `resistUsed` (shared/model.ts:886). Only the DM changes them, with the pips in a row's options (Row.tsx:905-920) and the Stats steppers (StatsSection.tsx:217-245). Save cards spend Resistance through `actor.outcome`'s `resist` (reducer/outcome.ts:37-39). Nothing spends a pip for a legendary action.
- In lair sets `InitEntry.inLair` and nothing else (reducer/encounter.ts:301).
- Recharge "Used" lives in one tab's sessionStorage (dice/options.ts:391-423). The recharge card reads Used as the turn starts, from turn lines that arrive while the page is open (InitiativeStrip.tsx:1200-1250), so a reload or a second DM device loses it.
- X/Day is display text (dice/named.ts:215-231). Regeneration is not read. The token bar has no combat items (canvas/barButtons.ts:64-83). Characters have no class resources. Nothing prompts a death save.

**The answer.**
- **One list, `CombatUses`, in three places**: a **turn card** in the alerts column at the creature's turn start, a **Uses** group in its tracker row's options, and a **Uses** drawer in its token action bar.
- **Room state.** Spent abilities live on the actor (`Actor.uses`), class resources on the character. Every device sees them, and the reducer resets them on rests and turn starts.
- **A turn-start record.** At each creature's turn start the reducer stamps on its actor what is due that turn. Prompt cards read only that record, and each prompt is settled once, atomically, by the first roll or answer from any surface, and keeps its result.
- **Uses log as creature lines**, so a hidden creature's use never reaches a player, and their counts keep the readers they had when written.

## 1. The rules (SRD 5.2.1)

- **Legendary Actions**: "Immediately after another creature's turn" the creature can expend a use to take one, and it regains them all at the start of each of its turns. Some say "The dragon can't take this action again until the start of its next turn." SRD 5.2.1 prints no cost above 1. Older and custom blocks print "(Costs 2 Actions)".
- **Legendary Resistance (3/Day, or 4/Day in Lair)**: on a failed save, it can succeed instead. X/Day uses come back on a Long Rest.
- **Recharge X–Y**: "Each time the monster starts its turn, roll 1d6", and on a number in range it regains the use. It also recharges on a Short or Long Rest. One entry recharges only "after a Short or Long Rest".
- **Regeneration**: "regains 15 Hit Points at the start of each of its turns". The troll's stops for a turn after Acid or Fire damage, and it "dies only if it starts its turn with 0 Hit Points and doesn't regenerate". The oni's and the shield guardian's need "at least 1 Hit Point".
- **Death Saving Throws**: "Whenever you start your turn with 0 Hit Points, you must make a Death Saving Throw." Class resources: Appendix A.

## 2. State

### 2.1 What comes from the stat block

`limitedUses(view: StatBlockMonster): LimitedUse[]` (new, `shared/dice/uses.ts`) reads every block the Dice panel reads through `blockEntries` (named.ts:40-56). It reads entries, not rolls, so X/Day and legendary entries without dice are listed too. `blockActions` already keeps a Recharge entry without dice (named.ts:331-332).

| Fact | Printed as | Read as | SRD 5.2.1 |
| --- | --- | --- | --- |
| Legendary actions | The "Legendary Actions" entries after "Legendary Action Uses" | Each entry but that one | 30 monsters |
| Cost | "(Costs 2 Actions)" in the name | Cut from the name, 1 to 3. Else 1 | none |
| Once per turn | "can't take this action again until the start of its next turn", either apostrophe | A regex on the text | 41 entries on 27 monsters |
| Uses and lair counts, lair XP | `legendaryActions`, `legendaryResistance`, `xpInLair` | As today, `legendaryUses` for custom blocks (statBlock.ts:183-192) | 30, 32, 27 differ in a lair |
| Recharge X–Y | "(Recharge 5–6)", "(Recharge 6)", en dash or hyphen | `nameParts` (named.ts:219) | 86 entries, 13 Bonus Actions |
| Rest recharge | "(Recharge after a Short or Long Rest)" | New `nameParts` branch | 1 (the cloaker's Phantasms) |
| X/Day | "(2/Day)", "(1/Day; Requires Soul Bag)", any "(N/Day" but Legendary Resistance's | `nameParts`' `uses`, now with N, 1 to 9. Text that "regains" uses on "a Short or Long Rest" marks `short` | 28 entries on 26 monsters |
| Regeneration | A trait named "Regeneration" | The amount, the stop types ("takes A or B damage, this trait doesn't function"), `minHp: 1` ("at least 1 Hit Point") | 4, 2 with a stop |

- **Keys.** One bounded function, `entryKeys(view)` in shared/dice/named.ts, gives every entry its key before any filtering into rolls: `section:slug`, `-2` and up for a repeated name among all entries, and a slug over 40 characters cut to 33 plus `-` and 6 hex digits of a hash of the whole name. A key is at most 64 characters. `blockActions` and `limitedUses` both use it. A roll's suffixes, `:hit` and `:later` (named.ts:323-335), stay on the roll's key, never the ability's. No SRD 5.2.1 name repeats or passes 40 characters, so no SRD key changes (a test checks it).
- **Spells stay out.** X/Day items inside a Spellcasting entry (46) are spells. A block's own named X/Day entry counts even when it casts a spell, as the archmage's "Misty Step (3/Day)", since the block prints it as one of its actions.

### 2.2 New fields

```ts
type Actor = { ...,                       // legendary unchanged
  uses?: Record<UseKey, UseMark>,         // spent abilities, at most 16. Absent when none
  hurt?: DamageType[],                    // types taken since its record's start, each once, for the Regeneration note (3.4)
  turnRecord?: TurnRecord }               // its turn-start record (2.3)

type UseKey = string                      // entryKeys' key, 1 to 64
type UseMark = {
  kind: 'recharge' | 'rest' | 'day' | 'turn',
  name: string,                           // 1 to 120 as printed, the bound of a custom entry's name (protocol.ts:850)
  used: number, max: number,              // 1 to max. max 1 but for day, whose X is 1 to 9
  min?: number,                           // recharge: the low end of its range, 2 to 6
  short?: true }                          // day: a Short Rest brings it back too

type Character = { ..., resources?: ClassResource[] }   // at most 12, in the order added
type ClassResource = {
  id: string, name: string,               // a plain id. 1 to 40, one line, no lone surrogate
  max: number, used: number,              // 1 to 99, a pool to 200. 0 to max
  reset: 'long' | 'short' | 'shortOne',   // shortOne: a Short Rest gives one back, a Long Rest all
  pool?: true,                            // a Use spends an amount: Lay on Hands, Focus Points, Sorcery Points
  preset?: string, level?: number,        // its Appendix A preset and the class level its counts were read at
  atLevel?: number,                       // the character's level when it was added or updated
  edited?: true }                         // its count was typed by hand, so Update keeps it

type EncounterSnapshot = { ..., turnUses?: TurnUses[] }   // what one start replaced, per participant. Absent when nothing
type TurnUses = {
  holderId: TokenId | CharacterId,
  record?: TurnRecord | null,             // the record it replaced. null: it had none, so Previous removes the new one
  marks?: Record<UseKey, UseMark>,        // the turn marks it removed, whole, names included
  actionsUsed?: number,                   // pips of a participant other than the landing row's, whose stay in `legendary`
  link?: string }                         // its block link then (linkOf), so Previous skips a creature relinked since
```

- **Owners**: `uses`, `hurt` and `turnRecord` are on the actor (a token's inline actor, or a PC's character actor, which in a shape uses the shape's block). `resources` are on the character. The initiative entry gains nothing.
- **Projection**: non-owners get none of these. `projectActorPublic` (project.ts:551) and `projectCharacter` (683) are allowlists. Owners get them, as they get the whole actor today.

### 2.3 The turn-start record

```ts
type TurnRecord = {
  id: number,                             // the seq of the op that started the turn. Seqs only grow
  entryId: EntryId, round: number,        // the turn it belongs to. Its cards show only while that row acts in that round
  hp: number, life: LifeState,            // at the start
  took?: DamageType[],                    // `hurt` as the start closed it, each once (3.4)
  due?: UseKey[],                         // the recharge marks present at the start
  settled?: Record<string, Settled> }     // "regeneration", "deathSave", "recharge:<key>"
type Settled = { state: 'done' | 'skipped', total?: number,       // a roll's total, or a heal's amount
  outcome?: 'success' | 'failure' | 'twoFailures' | 'regain' | 'ready' | 'used' }   // from naturalOf (dice/roll.ts:136) for a death save
```

- **Participants**: the landing row's creature, the `shared` companions `clearCompanionReactions` clears (its character's, on the row token's scene, or the players' scene for a row with no token), and the controlled mounts joining at the start. They are fixed for the turn: a mount that dismounts mid-turn keeps its record and its card, and one that joins mid-turn gets none.
- **Which get a record**: every participant but the landing row's creature, since they are few. The landing row's creature gets one where a card or reset could apply: HP below its maximum, not alive, `due` non-empty, `hurt` non-empty, or marks, legendary counts or class resources. A healthy goblin with none of these gets none, so its token does not change every turn. The turn card shows the landing row's creature from its block, record or not, unless its row only marks time (its turn ran with its rider's), and the others by their record.
- **What is due**, read from the record, never live state:
  - **Recharge**: each key in `due` whose mark is still there, not settled. Mark ready settles it as done. A breath spent on its own turn is not in `due`, so it waits for the next start.
  - **Regeneration**: a participant whose block has the trait, with the record's `hp` below its maximum or its `life` not alive, and `minHp` met by that `hp`. The reducer cannot read the block (3.2), so it accepts a Regeneration settle for any participant, and the client asks only where the block has it.
  - **Death save**: the record's `life` was dying and the creature is dying now. One predicate, `deathSaveWaits`, holds every death save Roll (the card, the bar's and HpSection's, the Dice panel's row) disabled while this device shows the creature's Regeneration open.
- **Settling**: each prompt is the occurrence `(record id, what)`, settled in the op that answers it, with its result. Every roll of an open occurrence settles it, from any surface: while the creature's current record holds an open death save or recharge, the card, the bar's and HpSection's death save Roll (HpSection.tsx:330-336, 439), the Dice panel's death save row (useRollOption.ts:134) and its Recharge 1d6 (RollOptions.tsx:743-744) all send `record`. Outside an open occurrence a roll stays manual.
- **Refusals** run in `canApply` before any die is drawn (server/rooms/actor.ts:1020-1028), and again in the reducer: "It was settled meanwhile." (`SETTLED_MEANWHILE`, permissions.ts:1058), "That turn is over." for a record that is not the creature's current one or whose row and round no longer act, and "Thorn is no longer dying."

### 2.4 Resets

| When | What resets |
| --- | --- |
| A participant's turn starts, from op 20 | A record where 2.3 says, `took = hurt` and `hurt` empties, its `turn` marks go, its pips refill. A landing row that only marks time (`markRound` is the round) starts nothing new: its mount's turn began with its rider's |
| A recharge roll meets `min` | That mark goes |
| Short Rest | `recharge` and `rest` marks go, `day` marks with `short` go. Resources: `short` all back, `shortOne` one back |
| Long Rest | Every mark, `hurt` and the record's `took`, legendary uses (today), every resource |
| `encounter.end`, from op 20 | Every actor holding turn-scoped state, removed creatures included (`tx.actors()`, tx.ts:349), loses its `turn` marks, `hurt` and `turnRecord` (its `took` with it). Counted uses, recharge marks, Resistance and pips stay, since a fight's end is not a rest. The DM's undo of End puts them back |
| In lair on or off | `actionsMax`, `resistMax` and `xp` to the op's counts, used clamped |
| The block link changes (`srdId`, `monsterId`, `blockId`, a shape) | `uses` goes |
| Duplicate | `uses`, `hurt` and `turnRecord` start empty, as legendary does (tokens/factory.ts:211) |

A turn passed over resets nothing. `encounter.start` and `encounter.add` clear nothing: a new fight always follows an end (encounter.ts:182), and a creature removed and added back in the same fight keeps its once marks and `hurt`. Damage types taken between fights stay, as the rules want. Limits (new `LIMITS` lines at the end): 16 marks, 12 resources, resource names 40, mark names 120, pools 200, 16 `due` keys. A spend that would add a 17th mark is refused: "Too many uses are spent. A rest brings them back."

## 3. Ops, versions and undo

### 3.1 Ops

| Op | Who | Notes |
| --- | --- | --- |
| `actor.use { target, use, back?, quiet? }` | The DM, and owners of the target | Kinds below. Refusals name the use: "No legendary actions left.", "Fiery Rays can't be taken again until the start of its next turn.", "Fire Breath is already used.", "No uses of Dominate Mind left.", "Rage has no uses left." |
| `actor.rechargeRoll { tag, target, key, name, min, record? }` | As `actor.use` | Resolved into `sys.dice` as `actor.deathRoll` is (reducer/dice.ts:24-35, dice/resolve.ts). One `dice` line, "Fire Breath recharge", `to` by `startsSecret`. `min` or more removes the mark. With `record`, it settles `recharge:<key>` with its total |
| `actor.deathRoll { ..., record? }` | As today | With `record`, it settles `deathSave` with its total and outcome |
| `actor.prompt { target, record, what, state }` | The DM, and whoever answers for the creature (4.1) | `skipped` is a card's Skip, and `open` is Reopen of a skipped prompt while its turn runs. A `done` one never reopens this way (3.4) |
| `encounter.update { entryId, patch, counts? }` | The DM | `counts: { actionsMax, resistMax, xp? }`, only beside `patch.inLair`, from the block's lair or base counts. No block, no counts |
| `character.update { patch: { resources } }` | The DM and owners | Items carry no `used`: the reducer keeps it by id, clamped. A new id starts at 0 |
| `actor.hp`, `actor.damageMany`, `actor.outcome` | As today | Each damage gains `types?` (3.4). `actor.outcome` gains `quiet?` for its `resist` line |
| `dice.roll` | As today | A roll gains `type?: DamageType` (3.4) |

`use` kinds, every `name` 1 to 120:
- `legendary { cost: 1 to 3, key?, name?, once?: true }`: `actionsUsed + cost` may not pass `actionsMax`, and a key with a `turn` mark is refused. With `once` it adds the mark. No key is the plain "Spend one" for counts set by hand.
- `resist {}`: one more `resistUsed`.
- `ability { key, name, limit: 'recharge' | 'rest' | 'day', max, min?, short?, ifReady?: true }`: spends one. `ifReady` is the Dice panel's mark (6): on an ability already used it changes nothing and refuses nothing.
- `regenerate { key, amount: 1 to 999, record }`: heals by `applyHeal`'s rules and settles `regeneration` with the amount.
- `resource { id, amount? }`: a character target, or a token whose actor is a character's. `amount` 1 to 200, only for a pool.

`back: true` gives one back: the pips and the `turn` mark, one Resistance, one `day` use or the whole mark, or the amount. On a recharge it is Mark ready, and it settles the key's open occurrence as done in the same op. With nothing to give back it changes nothing and writes no line. `quiet: true` says the use follows a secret roll, which hides its line from players (8). Permissions follow `actor.deathSave` (permissions.ts:707-714): `GONE` for a target the sender cannot see, `NOT_YOURS` for one they do not own, so a player can never probe a monster's uses.

### 3.2 The reducer never reads a stat block

The blocks live in the half-megabyte SRD chunk, the room's monsters and the companion blocks, and the reducer stays a function of state and op, as replay needs. So the sending device reads the block, and the op carries the facts: cost, once, X, `min`, the lair counts, the amount. Schema bounds keep them small. The DM is trusted with monsters, and an owner can only overstate their own companion. A block edited after a use leaves marks under keys it no longer lists. They still show by their stored name under **Other used**, with Give one back.

### 3.3 Turn starts, Previous and replay

- **One initializer.** `startTurn(tx, encounter, landing, snapshot)` (new, encounter.ts) writes the records and resets of 2.4 for every participant. It starts nothing new on a landing row that only marks time. `encounterNext` calls it, and so does `removeEntries` when removing the active row passes the turn on (encounter.ts:225-252), which a token delete (tokens.ts:338, 810) and a companion's removal (companions.ts:182) reach too. Durations still tick only on Next, as today. A start passed on by a removal keeps Reactions as today (`withMounts(..., false)`, encounter.ts:244-245, on purpose). It pushes no history entry, so it saves no `turnUses`, and the DM's Undo of the removal, not Previous, takes it back.
- **The gate.** Every turn-start write of this design sits behind `combatUses(opVersion)` in migrate.ts, shaped as `attaches` (migrate.ts:838): the records, the resets, the pips of other participants, the marked-time rule, `turnUses`, the type sets, and the clear at `encounter.end`. Before op 20, Next writes exactly what it writes today, the landing pips included on a row that marks time, and a removal start writes no actor. Stored restores are guarded by value hashes (tx.ts:265-285), and a refused one fails the whole replay (persistence.ts:90-99), so nothing less would do.
- **Previous** (`encounterPrev`), for each participant in `turnUses`: the old record comes back, or the new one goes for `null`, the removed marks come back whole, and the pips come back from `legendary` or `turnUses`. `hurt` becomes the union of the removed record's `took` and the current `hurt` (3.4). It skips a holder deleted, converted or relinked since, as `companionReactions` does (encounter.ts:499-504). Marks go back only while the 16-mark bound holds, and one that would not fit is left off, which can only let an action be taken again. Uses spent during the turn stay spent: Previous takes back the turn, not what happened in it.
- `actor.outcome`'s `resist` writes its use line only from op 20, behind the same gate, since an extra line in a stored op would shift every later line id of that op (tx.ts:216).

### 3.4 Damage types and the Regeneration note

- **Types actually taken.** The group save sends the types of each row's positive adjusted parts, its `byPart` after immunity, resistance, vulnerability and rounding (groupSave/outcome.ts:111-118), which the plan keeps beside its total (plan.ts:210). A part that comes to 0 adds nothing, and damage of 0 writes nothing (actors.ts:34). An untouched HP chip sends its lines' positive component types as rolled (dice/options.ts:479-492), since the HP entry applies no defenses. An edited chip clears them, as an edit clears its source (HpSection.tsx:163). HP typed by hand sends none. Temporary HP that took the damage still counts.
- **Why `type` on the dice line**: the Dice panel already rolls one roll per damage type (dice/options.ts:318-334), but its label's ", Fire" is cut to fit (`cutLabel`) or typed by hand, so a label is no contract.
- **Two sets, each at most the 13 types.** `hurt` holds the types taken since the creature's record's start, and the record's `took` the types of the window that start closed. A damage of at least 1 adds its types to `hurt`, as the op carried them: the reducer filters none against a block, which it cannot read. A turn start sets `took = hurt` and empties `hurt`. Previous makes `hurt` the union of the removed record's `took` and the current `hurt`, then brings the old record back. An HP take-back changes neither set, so a taken-back hit still counts. `encounter.end` and a Long Rest clear both. Import drops both.
- **The note is advisory, and incomplete both ways.** The Regeneration card shows "Recorded Fire damage may stop Regeneration." when `took` holds one of the trait's stop types. A taken-back hit can leave a note that no longer holds, and these leave no note where one belongs: damage with no types (typed by hand, an edited chip, the group HP entry's separate `actor.hp` ops, groupHp.ts), Fire in a fight's last round when a new fight starts at once (the clear at `encounter.end`), import, and a start passed on by a removal followed by Previous (that start saves no `turnUses`, 3.3, so the types it closed sit in a `took` no later window reads). An absent note never says Regeneration works, and the card offers Apply and Skip either way.
- **Regeneration's take-back.** Its heal's `revert` keeps `record`, and taking it back reopens the prompt while that record is current, so the card returns. HP take-back stays the DM's (`undo` with `log`).

### 3.5 Undo

- **The DM.** Each new op is a DM step: "using Fiery Rays for Adult Red Dragon", "using Legendary Resistance for Lich", "giving back Fire Breath for Young Red Dragon", "Regeneration for Troll", "skipping Troll's Regeneration", "using Rage for Thorn", "putting Adult Red Dragon in its lair", "changing Thorn's class resources". Its restore is guarded by value hashes of the entities it touched, so it is refused once someone else changed them since.
- **Players get no Undo for uses.** `actor.use` stays off `onPlayerUndoStack`. A player's restore may touch only their token poses and drawings (permissions.ts:884-917), and a whole-entity guard would tell them when the DM changed something hidden. **Give one back** is the player's correction for every kind, and **Reopen** for a skipped prompt until Next.
- **No back line for an undo**, as for every undo: the log is a record of what happened (tx.ts:275). The use's line stays, and the take-back shows in the counts.
- **Rolls** are on no stack (undoLabels.ts:318). A wrong recharge is fixed with Mark used or Mark ready.

### 3.6 Versions, migration and import

- **Op 20 and snapshot 22**, the next free pair after the log rings' 19 and 21, or the next free pair at build time.
- **Op 20** adds the ops and fields of 3.1, which an older build's strict schema refuses. Its replay rules are the gate of 3.3. The step is the identity.
- **Snapshot 22** adds 2.2's optional fields. The step is the identity, and an older build refuses the room. Rollback means restoring the backup taken before the deploy.
- **Import.** server/rooms/stateSchema.ts gains `resources`, `turnUses`, and `uses`, `hurt` and `turnRecord` through `actorSchemaForImport` only (protocol.ts:2166-2172), never an op's actor, as for `unshaped`. remap.ts maps `turnUses[].holderId` as `legendary.holderId` (remap.ts:397).
- **Imported ids are seqs of the old room**, and the new one counts from its snapshot at seq 0 (gateway.ts:101-104), as remap.ts:374-377 says of `turnStart.seq`. So import drops every actor's `turnRecord` and `hurt`, and each `turnUses` entry's `record` (left absent, so Previous leaves the record as it is). Imported HP lines already cannot be taken back: remap drops each one's whole `revert` (remap.ts:478-485).
- The per-tab `rvtt.rechargeUsed.<roomId>` marks are deleted on load and never read.

## 4. The cards

### 4.1 Who sees them

- **Per participant**: its players for a PC, a companion or a lent monster, the DM for any creature no player plays. A DM-controlled mount on a player's turn gives the DM a card, and the player gets their own. The DM also gets a player's character's death save card. **Skip** goes to whoever answers for the creature.
- **From state alone**: records, marks and counts, so a reload, a second DM device and a late join show the same cards and the same results ("Rolled 5" from `settled`).
- **Dismiss** on a turn, recharge, Regeneration or death save card hides it on this device for this turn. Only Skip settles a prompt for everyone. The save-ends card keeps its shared Dismiss (SaveEndsCard.tsx:149).
- **Loading**: rows that need a block show the shared `Loading` ("Loading the uses…", 200 ms delay) or `SrdLoadFailed` inline, as `RechargeWait` does. Counts on the actor show at once. A button is busy while its op is out, refuses a second tap, and shows a refusal in the card's status line.

### 4.2 The turn card

From the creature's turn start to its end. A dragon's card:

| Row | Shows | Button |
| --- | --- | --- |
| Header | "Adult Red Dragon's turn" | Dismiss |
| Legendary Resistance | 3 of 3 | Use |
| Legendary actions | 3 of 3, after other creatures' turns | none |
| Fire Breath, Recharge 5–6 | Ready, Used, or "Rolled 5: ready" | Use when ready |
| A skipped prompt | "Regeneration skipped" | Reopen |

- **No legendary action buttons on its own card**, since they come only after another creature's turn. They are in its row and bar (5, 6).
- An X/Day row reads "Dominate Mind, 2/Day, 2 left" with Use, and "0 left" with none. A PC's reads "Rage, 2 of 3" with Use, a pool "Lay on Hands, 25 of 25" with Use…, which opens an amount field (16 px, numeric, up to what is left) with Spend and Cancel.
- Each other participant the viewer answers for gets a block under its name.
- **Folded** to one 44 px row, "Adult Red Dragon's turn: 3 uses" with Show, under 600 px wide, and wherever the unfolded card would not stack above the docked bar's 120 px floor (`shareLane`, docs/design-v1-bar-dock.md 1.3). A turn card alone never forces the summary row or moves the bar. Where even its row would not stack, the lane leaves it out, and the same list stays in the row's options and the bar.

### 4.3 Regeneration

Due as 2.3 says, and shown before the death save card, since a troll "dies only if it starts its turn with 0 Hit Points and doesn't regenerate". The words follow the record's `life`:
- **Alive**: "Troll regenerates 15 HP." with Apply and Skip.
- **Dying** ("Monsters die at 0 HP" off): "Troll is at 0 HP and regenerates 15 HP." with Apply, which brings back a dying creature whatever "Healing brings back the dead" says (hp.ts:228-237).
- **Dead**: with "Healing brings back the dead" on, "Troll regenerates 15 HP and gets up." with Apply. With it off, it says so, with Skip alone.
- **The note** (3.4), when the record's `took` holds a stop type: "Recorded Fire damage may stop Regeneration." Its help text says damage typed by hand is not counted. Apply and Skip stay as above whatever the note says, and the healing and settle rules do not change.
- Once settled: "Regenerated 15 HP." or "Regeneration skipped" with Reopen.

### 4.4 Death save

Due as 2.3 says: "Thorn is dying. Death save: 1 success, 2 failures." with read-only pips, **Roll** (open or secret as today), Skip and Dismiss. While Regeneration is open, every death save Roll waits (`deathSaveWaits`, 2.3), and the card reads "Waiting for Regeneration". The first roll anywhere settles it (2.3), and from its stored outcome the card shows "Rolled 14: a success.", "Rolled 1: two failures." or "Rolled 20: Thorn regains 1 HP." A `deathSave` line from damage at 0 HP (hp.ts:205-212) settles nothing. Healed from another device, the card goes, and a roll sent meanwhile is refused before its die. A monster gets it only with "Monsters die at 0 HP" off.

### 4.5 Recharge

Today's card (RechargeCard.tsx), now from the record: one per key due. "Fire Breath can recharge (5–6)." with Roll, Mark ready and Dismiss. The result stays: "Rolled 5: Fire Breath is ready." or "Rolled 2: Fire Breath stays used." with Done. Two devices rolling at once count one roll, and a roll sent after Next is refused.

### 4.6 The column, the summary row and toasts

- **Order**: concentration, save-ends, regeneration, death save, recharge, roll requests, the turn card, time is up, notices. What someone waits on comes first, then the turn's prompts, then the turn's menu, which lasts the whole turn.
- **The summary row** (`alertsSummary`, pages/fold.ts) gains `deathSave`, after concentration ("Thorn makes a death save"), and `turn`, last ("Adult Red Dragon's turn"). Regeneration and recharge go as notices, as recharge does today.
- **Toasts** keep their rule: 8 px under the column's first card (`toastTop`). No use writes a toast. `FoldStatus` speaks each new card once.

### 4.7 Next, Previous, skipped turns

- **Next** ends the cards. Nothing unanswered happens by itself.
- **Previous** puts back the replaced records, so the resumed turn's cards return as they were left, with their results.
- **Next after Previous** starts the turn again with a new record, so its prompts come again, as pips refill again today.
- **A skipped turn** starts nothing. With "Skip defeated creatures" on, a troll at 0 HP is dead and passed over, so it cannot regenerate. The DM turns Skip off for a troll fight.

## 5. The tracker row

**Options** (`RowMenu`, Row.tsx:806-967) gain a **Uses** group where the pips stand (905-920), holding them, in its off-turn form:
- Legendary actions as buttons: "Pounce", "Fiery Rays", and "Wing Attack (2)" for an older block's cost of 2. A once-marked one is disabled, "Until the start of its next turn". Too few pips: "Needs 2". On the creature's own turn: "After another creature's turn".
- **Use Legendary Resistance (2 left)**, and the pips as today.
- A recharge ability: Use when ready, or **Roll recharge** and **Mark ready** when used. An X/Day ability: Use, and **Give one back**. **Other used**: marks the block no longer lists (3.2).
- Class resources (7.2). Regeneration as a line, "Regeneration: 15 HP at the start of its turn".
- **In lair** applies the lair counts, busy while the block loads.

A player's row options show their own creatures' uses. **Chips** (DM only, after LA and LR), from marks' names: "Fire Breath used", and "Dominate Mind 1/2" (left over max, as LA's) for a spent X/Day. At most 3, then "+2 more". Player rows gain none. A companion's sub-row and `CompanionMenu` get the same.

## 6. The token action bar and the Dice panel

- **One place**: a **Uses** button in the play row after Roll (barButtons.ts), opening a **Uses** drawer, the same off-turn list as the row's group. `Drawer` (TokenActionBar.tsx:138) gains `"uses"`, so it opens where Conditions does, and one tap closes either.
- **Who**: the DM on any creature with a use, owners on theirs. The group bar is unchanged.
- **Shown early**: the button shows at once for an actor with `legendary`, `uses` or `resources`. For a creature whose block is still loading, its place is held, then dropped if the block has no use, so Light and Attach do not jump. A creature with none shows nothing new.
- **On a phone** the drawer's rows are 44 px and scroll inside the bar's room, with "Scroll for more" when cut. At 390 px a dragon's drawer holds three rows: "Legendary actions 2 of 3" with Pounce, Commanding Presence and Fiery Rays, "Legendary Resistance 3 of 3" with Use, and "Fire Breath, Used" with Roll recharge and Mark ready.
- **The Dice panel** (RollOptions.tsx): an X/Day ability is spent only by an explicit Use. Damage, Group save and rerolls never spend it. A recharge action's Damage or Group save still marks it used (713, 761, 806), with `ifReady`, and only when this device shows it ready, so it never draws a refusal. The row's Recharge 1d6 becomes `actor.rechargeRoll`, settling an open occurrence (2.3). GroupSave.tsx:343 (Apply of a save filled from the action) sends `actor.use` the same way. A legendary action rolled there spends no pip. An explicit Use that fails shows its refusal where it was tapped.

## 7. Class resources

### 7.1 Picking them

The app knows a character's level and, with a stat block, its scores. It does not know its classes: the D&D Beyond read sees them (shared/ddb/read.ts:171) but keeps only the level. So the player picks.
- **Add a class resource**: pick one of the 12 SRD classes, set the class level, tick that class's resources at that level (Appendix A fills each count), and Add. The Level stepper starts at the character's level, or at 1 when it has none, with "Set the character's level in Stats to fill this in."
- **Counts from a modifier** (Bardic Inspiration, Tireless, Nature's Veil, Wholeness of Body, Dark One's Own Luck) read the block's score, or ask for the modifier. At least 1.
- **Your own**: name, count, which rest brings it back, and "Spend an amount" for a pool. Superiority Dice (the Battle Master is not in SRD 5.2.1), species traits and feats go this way.
- **Edit**: name, count (which sets `edited`), rest, pool, and Remove (a second tap confirms).
- **Levels.** Each preset stores the character's level when added (`atLevel`). When `Character.level` rises past it, the section shows "Your level went up. Update Barbarian resources?" with **Update**, which asks for the new Barbarian level, prefilled with the old class level plus the rise, then sends one `character.update` with the new counts. Counts marked `edited` are kept. A multiclass character is never handed counts for the wrong class level.

### 7.2 Where they show

- The Token panel's Combat group, a **Class resources** section after Rest (panelOrder.ts:80), and the character's page: each with its count, Use or Use…, Give one back, Edit, and Add.
- The turn card, the row's Uses group and the bar's Uses drawer.
- Its players and the DM only. The DM may spend them for a player who is away.
- Rest names what a rest brings back: "A Short Rest also gives back one Rage and all Focus Points."

## 8. Log lines and visibility

A creature line, written with `tx.addActorEvents(resolved, [event])` (reducer/tx.ts:257), which stamps `seen`:

```ts
| (AboutCreature & { type: 'use', what: 'legendary' | 'resist' | 'ability' | 'resource',
    name?: string, cost?: number, left?: number, max?: number, back?: true, hidden?: true })
```

| Use | The DM and owners read | Other players read |
| --- | --- | --- |
| A legendary action | "Adult Red Dragon used Fiery Rays (legendary action, 2 of 3 left)." A cost above 1: "used Wing Attack (2 actions, 1 of 3 left)." | "Adult Red Dragon used Fiery Rays, a legendary action." |
| Resistance | "Lich used Legendary Resistance (2 of 3 left)." | "Lich used Legendary Resistance." |
| An ability | "Aboleth used Dominate Mind (1 of 2 left)." | The same, no count |
| A resource | "Bree used 5 of Lay on Hands (20 of 25 left)." | "Bree used Lay on Hands." |
| A give-back | "Young Red Dragon: Fire Breath is ready again." | Nothing |

- **Private parts**: `cost`, `left` and `max`. A public line never shows a cost, a count or an amount.
- **Readers when read**: `eventReach` (project.ts in the log rings change) gains `use` as `creatureReach(state, data, false)`, and `projectEventCtx` a `use` case: `holderOfEvent` first, no private part for non-owners, and no `back` or `hidden` line for them.
- **Readers fixed when written**: `partsOf` records the readers of the private parts as an `exact` part, and `withinParts` drops them for anyone not among them. So a player reads them only as one of the original readers who may still read them now: one lent the creature later never reads counts from before, and one who stops owning it loses them.
- **A hidden creature's use** has no `seen`, so no player but its owners reads it, and the rings' audience rule puts it with the DM's lines.
- **After a secret roll** (`quiet`, `hidden` on the line): DM and owners only. That covers the Dice panel's mark after a secret breath and a save card's Resistance after a secret save. A Use tapped on its own is public by name.
- Rolls write their `dice` line as today. Regeneration writes its HP line, and Skip writes nothing. `shared/logText.ts` gains the words.
- **No log numbering in an actor field.** No canonical log line id, or anything derived from log numbering, reaches an actor field a non-DM can read, since an owner's line ids move with hidden lines written earlier in the same op (the log rings change strips `copyOf` for this reason). `hurt` and `took` hold only type names.
- **Accepted**: the owner of a lent creature can learn a damage type from the DM's secret roll through `hurt` and `took`. It is a type, not a number, and the owner sees the HP change anyway.

## 9. Accessibility and alignment

- **Keyboard**: every button in Tab order. Cards keep `tabIndex={-1}` for `focusAlert`. The drawer opens on its first button, and Escape closes it.
- **Names**: the turn card is `role="group"`, "Adult Red Dragon's turn". "Use Fiery Rays, legendary action, 3 left", "Use Rage, 2 of 3 left". A disabled one keeps focus (`aria-disabled`) and reads why through `aria-describedby`. Results go to the card's `role="status"` line.
- **Touch**: 44 px buttons and rows, the amount field 16 px with `inputMode="numeric"`, nothing on hover or long-press.
- **No new keys** or key-plus-pointer combinations, so the shortcut registry stays.
- **Every new screen joins e2e/alignment.e2e.ts**: the DM's turn card open, folded and with a skipped prompt, the recharge card before and after its roll, both kinds of Regeneration card, the row's Uses group and chips, the bar's drawer, In lair busy, Pat's death save card waiting and rolled, his turn card with a pool's amount field, the Class resources section and the Add sheet. The folded card gets a `SOME_SIZES` count, and the sweep adds 844 x 390 and 480 x 320 at 130% for the lane rule.

## 10. Edge cases

- Two DM devices tap the same Use: the second is refused, and both cards show the room's state.
- Counts set by hand, no block: "Spend a legendary action" and "Use Legendary Resistance".
- A PC in a shape uses the shape's block, and the shape's end clears `uses`. Resources stay on the character.
- A lent monster: the player owns it, so they get its cards, group, drawer and counts.
- A hidden row: its cards are the DM's, and its lines follow 8. Behind a blackout, players' cards wait, as their alerts do.
- A creature removed mid-turn: its cards go with its row, and the next row's turn starts with records (3.3).

## 11. Tests

- **Parsing** (`shared/dice/uses.test.ts`) over all 330 SRD blocks: 2.1's counts, regeneration's stops and `minHp`, every SRD key unchanged, and custom blocks with "(Costs 2 Actions)", hyphen ranges, "1/Day each", a repeated name whose first copy has no dice, and a 120-character name, carried whole through `actor.use` and `actor.rechargeRoll`.
- **The record**: a breath on its own turn shows no recharge card until the next start. A reload mid-turn shows the same cards and results. A trap hit at 0 HP leaves the death save card up. Two devices rolling one recharge count one. A roll after Next is refused. A mount that dismounts mid-turn keeps its card. The bar's death save Roll and the Dice panel's Recharge 1d6 settle an open prompt, and a second roll from the card is refused. Healing from another device ends the death save and refuses its roll before the die. While the card says "Waiting for Regeneration", the bar's Roll and the Dice panel's death save row are disabled too. A natural 1 and a natural 20 with an extra show the same outcome after a reload and after Previous. Skip (by the DM and by whoever answers), Reopen, Mark ready and local Dismiss.
- **Starts**: the active row's removal and the active token's deletion, each with a mount sharing the turn, start the next turn with records, no duration tick and Reactions as today. A healthy goblin gets no record, while a healthy `shared` companion and a controlled mount, each with a ready recharge ability, get records and their blocks on the turn card. A recharge that fails on the rider's turn gets no second roll on the mount's marked row.
- **Reducer**: every `use` kind spent, given back and refused, `ifReady`, lair counts, resources kept by id, every reset, and `encounter.end`'s clear with a creature removed earlier. A dragon that takes Fire damage and uses Fiery Rays off its turn, then is removed and added back before its first turn, keeps both.
- **Previous**: full marks with names come back, a first record is removed, a relinked holder is skipped, and a full mark bound leaves extra marks off.
- **The type sets**: Fire during a turn, then Previous, unions it into `hurt`, and the next start notes it. A take-back of Fire leaves the note. `encounter.end` and a Long Rest clear both sets, and import drops both. Damage before a first turn, the row removed and added back, a removal start, then Previous and Next (ASTRA-31): no note, no error, and Apply and Skip both offered. Undo Regeneration (its card returns). Types from mixed damage, immunity, rounding to 0 and temporary HP in the group save, and from an untouched and an edited chip.
- **Replay**: consecutive stored op-19 Next ops, then the stored restore of an undo step, compared on complete state and history. A stored op-19 `actor.outcome` with `resist` followed by damage and effect lines keeps its line ids.
- **A randomized test** (`shared/reducer/uses.random.test.ts`), 3 seeds of 900 steps of spends, give-backs, prompt settles from every surface, Skip and Reopen, rolls, takes-backs, turn starts by Next and by removal with mounts and companions, Previous, rests, lair switches and block changes. Invariants: `0 ≤ used ≤ max` everywhere, `actionsUsed ≤ actionsMax`, at most 16 marks, no occurrence settled twice, no settle after its turn, Next then Previous restores every record and mark, nothing survives a Long Rest, and replay rebuilds the same state.
- **Projection**: no `uses`, `hurt`, `turnRecord` or `resources` for non-owners, and no log id in any owner's actor, with and without unrelated hidden lines in the same op. The whole projected event, `cost` included, with ownership gained after a public line, lost after it, and a member who joins later. `hidden` lines. The rings' audience test with `use` lines.
- **Permissions, import and versions**: owners and not, `GONE` for a hidden target, `counts` only for the DM with `inLair`, Skip for the DM and whoever answers. An import round trip with uses, resources, type sets and `turnUses`, then a new turn whose seq equals an imported record id. Migrate at 20 and 22. Each undo label.
- **Appendix A**: each preset at its unlock level and one below, and each count change.
- **e2e**: `e2e/combatuses.e2e.ts` (port +28): Fiery Rays from the row and the bar on a DM phone, greyed until the dragon's next turn, Resistance, Fire Breath used on the desk and seen on the phone, its recharge card and result after a reload, In lair counts, a troll's Regeneration card noting Fire, with Apply and Skip, Pat's death save card. `e2e/classresources.e2e.ts` (port +29): Pat adds Barbarian resources at level 5, uses Rage from his turn card, a Short Rest gives one back, a Long Rest all, a pool's amount.

## 12. Build lanes

**Contracts first** (lane A's first commit): shared/model.ts (2.2, 2.3, the `use` line), shared/protocol.ts (3.1), shared/limits.ts, shared/migrate.ts (versions and `combatUses`), and a client stub `client/features/resources/ResourceRows.tsx` exporting `ClassResourceRows({ characterId, form })`. Lanes B and C start from it.

| Lane | Owns | e2e it runs |
| --- | --- | --- |
| **A. Rules and server** | The contracts. shared/reducer.ts, shared/reducer/uses.ts (new), encounter.ts, dice.ts, actors.ts, many.ts, outcome.ts, hpUndo.ts, tokens.ts, companions.ts, shared/rules/rest.ts, shared/permissions.ts, shared/project.ts, shared/logText.ts, shared/dice/resolve.ts, shared/reads.ts, shared/testutil.ts, server/rooms/actor.ts (the canApply check), undoLabels.ts, stateSchema.ts, remap.ts, and their tests | None |
| **B. Monsters and the combat surfaces** | shared/dice/named.ts (`entryKeys`) and uses.ts, client/features/combat/ (new: `CombatUses`, `TurnCard`, `RegenerationCard`, `DeathSaveCard`), RechargeCard.tsx, CardRoll.tsx, saveCards.ts, InitiativeStrip.tsx, Row.tsx, pages/fold.ts, canvas/TokenActionBar.tsx and barButtons.ts, dice/RollOptions.tsx, options.ts, hpChips.ts, useRollOption.ts, dice/groupSave/GroupSave.tsx, outcome.ts and plan.ts, tokens/HpSection.tsx, groupHp.ts and factory.ts, panels/TrackerPanel.tsx and encounters/drop.ts (In lair rows) | `combatuses.e2e.ts` (new), combat.e2e.ts, dmphone.e2e.ts, alignment.e2e.ts |
| **C. Class resources** | shared/rules/classResources.ts (new: Appendix A as data), client/features/resources/ (the stub filled, the section, the Add sheet), tokens/panelOrder.ts, panels/TokenPanel.tsx, tokens/CharacterCard.tsx, tokens/RestSection.tsx | `classresources.e2e.ts` (new), tokenpanel.e2e.ts, characters.e2e.ts |

- Both client lanes also run `reach`, which neither edits. Step labels carry the lane (`cu-b-…`, `cr-c-…`).
- **Landing order**: A, C, B. B's last two commits stack on A and C: every new screen of both lanes in alignment.e2e.ts, then the docs for all three lanes, so no file has two owners.
- **FEATURES.md**: lines 287 and 288 (turn card, Uses group, In lair counts, recharge as room state, prompts), 330 (the Dice panel's recharge and X/Day), 367 (what rests bring back), the Tokens part (the bar's Uses), Characters (class resources) and the alerts lines (the turn card and its fold).
- **docs/dm-guide.md**: 572 (what Next does), 645 (the Used switch and Recharge 1d6), "Alerts during a fight" (the new cards, and the one-tab sentence goes), "Rows and what they hold" (the Uses group, chips, In lair counts), "Tokens" (the drawer), 1051 (class features are no longer only on paper), and the boss walkthrough at 1226-1246 (In lair now changes counts, Fiery Rays from Uses instead of a pip, the recharge card) with a new boss.webp. The guide pass after this run retakes alerts.webp.

## 13. Recommendations to check

Recommendations inferred from past decisions, apart from the recorded picks above. Each rejects the alternative named.

1. **No legendary action buttons on the creature's own card, and disabled in its row and bar on its turn.** Rejected: live everywhere. Why: the 2024 rule allows them only after another creature's turn, and the pips still override.
2. **Players read a monster's use by name, with no cost or count, unless it follows a secret roll.** Rejected: DM-only lines. Why: the table sees the dragon act, and counts stay the DM's as the LA and LR chips do.
3. **In lair also swaps the XP.** Rejected: uses only. Why: placement's "In its lair" swaps both (srd/monsters.ts:124).
4. **A creature placed in its lair joins a fight with In lair on**, from a saved encounter's lair line or from its counts against its block. Rejected: the switch off. Why: the switch must say what the counts say.
5. **The turn card folds on phones and where it would not stack above the bar.** Rejected: always open. Why: it lasts a whole turn, and past decisions keep clutter off phone maps.
6. **Only an explicit Use spends X/Day. The Dice panel marks a recharge only when it shows ready.** Rejected: spending on each roll, or once per turn. Why: a reroll is not a second use, and a legendary action can use an X/Day ability on another creature's turn.
7. **The old per-tab Used marks are dropped.** Rejected: a one-time import. Why: they were one tab's guesses.
8. **Players correct a use with Give one back and Reopen, with no Undo.** Rejected: a field-level player restore. Why: Give one back covers every kind with no new restore rule, and no refusal can hint at the DM's hidden edits.
9. **Class resources are picked by class and class level, or typed**, with no D&D Beyond fill. Rejected: a sync part. Why: the re-sync merge (docs/design-v1-resync.md) would need a new part.
10. **Superiority Dice, species traits and feats are typed.** Rejected: presets. Why: only SRD 5.2.1 content ships as presets.
11. **Features that only cast one named spell (Favored Enemy's Hunter's Mark, Paladin's Smite, Faithful Steed) are not presets.** Rejected: presets. Why: spells stay out.
12. **Rage's Use does not turn on Raging.** Rejected: one tap for both. Why: the picks were counters, and Raging has its own toggle.
13. **A dead troll's turn stays skipped under "Skip defeated creatures".** Rejected: a regenerating creature is not defeated. Why: `isDefeated` reads only `life` (rules/initiative.ts:130-132), and the reducer cannot read the block. The DM turns Skip off for a troll fight.
14. **The Regeneration note is advisory, from two type sets, and Apply and Skip stay either way.** Rejected: exact per-hit records with take-back and retention. Why: three review rounds found exact bookkeeping fragile, and the DM decides at the table.
15. **At most 3 new chips, none on player rows.** Rejected: one per use. Why: rows already wrap on phones.
16. **A fight's end clears only turn-scoped state.** Rejected: clearing every use, or clearing at a start or an add. Why: a fight's end is not a rest, pips survive fights today (encounter.ts:183), and a creature added back into the same fight keeps its once marks.
17. **Dismiss on the new prompt cards is local, and Skip is the shared answer.** Rejected: a shared Dismiss, as the save-ends card has. Why: the player's and the DM's devices both show a death save card, and one person's tidying must not answer the other's prompt.

## Appendix A. SRD 5.2.1 class resources

"Short, one": a Short Rest gives one back, a Long Rest all. "Short": either rest gives all back. A modifier count is at least 1. Lane C checks each row against the SRD 5.2.1 class text as it types the data.

| Preset | Class, level | Count | Rest |
| --- | --- | --- | --- |
| Rage | Barbarian 1 | 2, 3 at 3, 4 at 6, 5 at 12, 6 at 17 | Short, one |
| Intimidating Presence (Berserker) | Barbarian 14 | 1 | Long |
| Persistent Rage | Barbarian 15 | 1 | Long |
| Bardic Inspiration | Bard 1 | Charisma modifier | Long, Short from 5 |
| Channel Divinity | Cleric 2 | 2, 3 at 6, 4 at 18 | Short, one |
| Divine Intervention | Cleric 10 | 1 | Long |
| Wild Shape | Druid 2 | 2, 3 at 6, 4 at 17 | Short, one |
| Natural Recovery (Land) | Druid 6 | 1 | Long |
| Second Wind | Fighter 1 | 2, 3 at 4, 4 at 10 | Short, one |
| Action Surge | Fighter 2 | 1, 2 at 17 | Short |
| Indomitable | Fighter 9 | 1, 2 at 13, 3 at 17 | Long |
| Focus Points (pool) | Monk 2 | Monk level | Short |
| Uncanny Metabolism | Monk 2 | 1 | Long |
| Wholeness of Body (Open Hand) | Monk 6 | Wisdom modifier | Long |
| Lay on Hands (pool) | Paladin 1 | 5 × Paladin level | Long |
| Channel Divinity | Paladin 3 | 2, 3 at 11 | Short, one |
| Holy Nimbus (Devotion) | Paladin 20 | 1 | Long |
| Tireless | Ranger 10 | Wisdom modifier | Long |
| Nature's Veil | Ranger 14 | Wisdom modifier | Long |
| Stroke of Luck | Rogue 20 | 1 | Short |
| Innate Sorcery | Sorcerer 1 | 2 | Long |
| Sorcery Points (pool) | Sorcerer 2 | Sorcerer level | Long |
| Sorcerous Restoration | Sorcerer 5 | 1 | Long |
| Dragon Wings (Draconic) | Sorcerer 14 | 1 | Long |
| Magical Cunning | Warlock 2 | 1 | Long |
| Dark One's Own Luck (Fiend) | Warlock 6 | Charisma modifier | Long |
| Hurl Through Hell (Fiend) | Warlock 14 | 1 | Long |
| Arcane Recovery | Wizard 1 | 1 | Long |
