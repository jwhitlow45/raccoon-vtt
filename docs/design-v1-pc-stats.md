# raccoon-vtt v1: stat blocks for player characters

Status: draft 2, with design-wave7 round 1's findings and the project owner's answers of 2026-10-17 (section 16), for design review. Code is cited from the wave 6 design tip `da0e973d`, whose code is the wave 5 tip's. This is doc 2 of the four wave 7 designs. It builds on docs/design-v1-dice.md ("doc 1"), fills the `pcRollNumbers` that doc 1 section 6 leaves to it, and gives docs/design-v1-roll-options.md ("doc 3") a character's named rolls in doc 1's `NamedRoll`. docs/design-v1-roll-request.md ("doc 4") needs nothing of its own from here. Section 9 lists every change to another design, in one place. Sizes, the D&D Beyond paths and worked examples are in the appendices, which verify rounds need not re-read.

The project owner asked on 2026-10-17 for dice "for saves, attack rolls, ability checks, and any other rolls", and said: "I believe this will require adding support for pc stat blocks". Their answer the same day: PC stat blocks are "typed in with helpers (ability scores, level and proficiencies give modifiers, saves, skills, proficiency bonus, attacks and spells as named rolls, the Paste a stat block reader tried on pasted text), and import from D&D Beyond (a share link or its JSON, through the server's existing outbound proxy, best effort, since it is a third-party format that can change)."

## 1. Summary

- **A character may have a stat block**, `Character.stats`: six scores, proficient saves, each skill's proficiency or expertise, Jack of All Trades, Alert, a spellcasting ability, damage defenses, a critical range, small typed adjustments, and up to 40 named rolls (weapons, spells, other), whose attacks may carry riders such as Sneak Attack. It is a stat block, not a character sheet: no spell slots, inventory, feature text or builder.
- **Numbers follow the rules.** The level gives the proficiency bonus, scores give modifiers, and one pure function, `pcDerived`, gives every save, check, skill, initiative, Passive Perception, spell save DC and attack, on the client, the server and in the reducer alike. Each number is its derivation plus a stored adjustment. Typing a total keeps the difference as the adjustment, so a level-up moves every number and keeps a Cloak of Protection's +1.
- **Initiative and Passive Perception come from it.** Once a character has a stat block, the reducer writes the actor's `initBonus` and `passivePerception` from it, so the tracker, party sight and doc 1's initiative read the same numbers.
- **Who.** The DM and the character's players read and edit it, as its light stat card today (the project owner's answer). Other players and the table display never receive it. Rolls made from it still reach the log by doc 1's rules.
- **Wild Shape by the 2024 rule.** The DM or the character's players link an SRD beast to the character itself. Its rolls then take the beast's Strength, Dexterity and Constitution, keep the druid's Intelligence, Wisdom and Charisma, and use for each save and skill the higher of the druid's, proficiencies kept, and the beast's.
- **Rolls.** `pcRollNumbers` fills doc 1's `RollNumbers`, spell save DC and attack included, so a request's Roll and doc 3's options work for PCs. `pcNamedRolls` gives doc 3 the weapons, spells and other rolls as doc 1's `NamedRoll`s, ready to roll.
- **Fill it** by typing, from pasted text read by the existing "Paste a stat block" reader, or from D&D Beyond: a public character's share link, fetched by the server through the strict egress port to one fixed host, or its JSON pasted and read in the browser. One reader, in shared code. A fill shows what it read, what to check and what else it sets before anything is saved. It reads numbers and names, never D&D Beyond's text.
- **Where it shows.** The PC token's panel under the image, the character's card, the action bar's saves line and the tracker's "Stat block", for the DM and the character's players.
- **Bounds.** 12 KiB a stat block, so a character resent on every HP change stays small. Every player op that writes a block spends the companion blocks' per-member budget. D&D Beyond reads run at most two at once on a server and one per room. It rides the wave's one version bump, `OP_VERSION` 7 and `SNAPSHOT_VERSION` 11 (doc 4 7.5).

## 2. Today

- **A character** has a name, size, portrait, owners, an optional `level` (1 to 20, the XP budget's) and an actor (`shared/model.ts:745-759`). The actor holds `initBonus` and `passivePerception` as typed numbers (`:712-715`) and nothing about abilities, saves or skills. Doc 1 6: "Characters have no saves or skills (doc 2 adds them)."
- **Edits**: the owners may patch the name, portrait, level and the actor fields `hp`, `speeds`, `ac`, `initBonus`, `passivePerception`, `senses`, `notes`, `sheetUrl` (`shared/permissions.ts:64-65`, `:494-506`, mirrored in `client/features/tokens/access.ts:27-48`). `characterUpdate` copies the named fields and applies the actor patch (`shared/reducer/tokens.ts:460-478`). A PC token's actor patch writes the character too (`:229`).
- **Projection**: the DM gets the character whole, an owner all of it but DM notes and `monsterId`, and anyone else a fixed list: id, name, size, portrait and the public actor (`shared/project.ts:602-615`). So a new field reaches the DM and owners and no one else without a projection change.
- **The light card** says it "is not a character sheet: the D&D Beyond link is for that" (`client/features/tokens/StatsSection.tsx:10-16`). docs/features.md:661-662 rules out a sheet builder, and D&D Beyond import because "There is no public API, and scraping breaks its terms." The project owner's answer above now asks for that import, best effort.
- **The token panel** shows a "Stat block" section only where `statBlockShown` says (`client/features/monsters/statBlockLink.ts:64-68`): the DM on a monster or NPC, a companion's players, and an owner of an SRD-linked token (Wild Shape). A PC token shows its summary line (`client/features/tokens/panelOrder.ts:47-62`).
- **Wild Shape** today is an SRD monster token the player owns, with its own HP (docs/features.md:559, docs/design-v1-dm-tools.md:406), the 2014 way. The 2024 rule keeps the druid's HP and replaces only some of its numbers (SRD 5.2.1, Druid, Wild Shape). A character's actor may hold `srdId`, which its owners receive, but only the DM may set it.
- **The paste reader**, `parseStatBlockText` (`client/features/monsters/parse.ts:259`), reads 2024 or 2014 monster text into a `StatBlock`, never throws, and lists warnings.
- **Egress**: the strict proxy port allows exact host names only (`docker/squid.conf:29`), through an explicit undici dispatcher (`server/assets/egress.ts:24-41`). Openverse's JSON transport caps a body at 2 MiB with a time limit (`server/assets/openverse.ts:465-500`). `WindowLimiter` counts hourly budgets in memory (`server/assets/limits.ts:14`), and a `Semaphore` caps concurrent outbound image fetches (`server/assets/slots.ts:97`).
- **A player's block saves** spend a per-member bucket of 10, refilled one every 6 s, refused with `quota` and never `busy` (`server/rooms/actor.ts:878-886`, `shared/limits.ts:90-91`).

## 3. The model

### 3.1 Where it lives

On the character. Doc 1's `RollSources` already carries `characters`, and `creatureNumbers` sends a character or its token to `pcRollNumbers(character)`, or in a shape to 3.6's numbers, so no new collection, key or snapshot step is needed. The projection already gives it to exactly the DM and the owners (2). The cost is size: a character is resent whole on every HP change, so the block is bounded at 12 KiB (3.5). A separate collection, as companion blocks are, was weighed: it would save those resends but add a key kind, a snapshot version and a second entity per character for about 1 to 6 KB (Appendix A).

### 3.2 Types (`shared/model.ts`)

```ts
type PcStats = {
  abilities: Record<AbilityKey, number>              // scores, 1 to 30
  saves: AbilityKey[]                                // proficient saving throws, each once
  skills: Partial<Record<SkillKey, 'prof' | 'expert'>>   // a skill left out has neither
  jack?: true                                        // Jack of All Trades
  alert?: true                                       // proficiency on initiative (Alert)
  spellAbility?: AbilityKey
  critOn?: 19 | 18                                   // a weapon attack's critical range: Improved or Superior Critical
  evasion?: true                                     // Evasion (Rogue 7, Monk 7): a Dex save for half takes none on a pass, half on a fail
  adjust: PcAdjust                                   // what the derivation does not know
  defenses: Partial<Record<DamageType, 'resistant' | 'immune' | 'vulnerable'>>
  rolls: PcRoll[] }                                  // at most 40
type PcAdjust = { saves?: Partial<Record<AbilityKey, number>>, skills?: Partial<Record<SkillKey, number>>,
  allSaves?, allChecks?, init?, passive?, spellDc?, spellAttack? }   // integers, -20 to 20, absent is 0
type PcRoll = {
  id: PcRollId, name: string,                        // 1 to 60 characters, the single-line text rules
  kind: 'weapon' | 'spell' | 'other'
  ability?: AbilityKey | 'spell'                     // 'spell' reads spellAbility at the time
  attack?: { prof: boolean, bonus: number }          // an attack roll
  save?: { ability: AbilityKey, dc?: number, bonus?: number,   // the save it forces: dc fixed, else derived
    onPass?: 'half' | 'none' }                       // what a pass takes, typed or read, absent when not known (3.4)
  level?: number                                     // a spell's, 0 to 9, 0 for a cantrip
  dice: PcDice[]                                     // 0 to 4 parts, rolled together
  ddb?: true }                                       // made by a D&D Beyond import (6.1)
type PcDice = { formula: string,                     // dice and numbers, at most 40 characters: "1d8", "2d6+1"
  mod?: true                                         // adds the roll's ability modifier
  type?: DamageType | 'healing'                      // neither: a plain roll, as Bardic Inspiration's d8
  grows?: true                                       // a cantrip's dice, times 2 from level 5, 3 from 11, 4 from 17
  upcast?: string                                    // damage or healing dice added per slot level above its own: "1d6"
  optional?: true, name?: string }                   // a rider, rolled only when it applies, and its name: "Sneak Attack", 30 characters
// Character gains: stats?: PcStats
// A character's actor gains: wildShape?: true       // its srdId is a Wild Shape (3.6)
//   unshaped?: { ac, speeds, shapeTemp? }            // the reducer's: its own AC and speeds while shaped, and whether the temporary HP are Polymorph's
```

- A roll needs an attack, a save or dice. `dc` and `bonus` never stand together. A `PcRollId` is the protocol's `id`, unique in its block, so doc 3 can key a list by it.
- `DamageType` is doc 1's (`shared/rules/damage.ts`, doc 1 6), so the schema, the filters and doc 3 read one list. `upcast` stands only on a damage or healing part, since doc 1's plain `dice` never scales, and `name` only with `optional`.
- Formulas are text, as in doc 1 5.1. The schema bounds their length and characters (digits, `d`, `k`, `h`, `l`, `%`, `+`, `-`, U+2212, spaces) and parses nothing, so a later grammar never stops a replay (doc 1 4.1). The editor refuses a formula `parseFormula` refuses. One that stops parsing later shows as its text and offers no roll.

### 3.3 The derived numbers (`shared/rules/pcStats.ts`)

`pcDerived(stats, level)` returns every number below, with its parts for the editor's hints. Level is the character's, 1 while unset.

| Number | Rule (SRD 5.2.1) |
| --- | --- |
| Proficiency bonus `pb` | 2 + floor((level - 1) / 4): +2 at 1, +3 at 5, +4 at 9, +5 at 13, +6 at 17 |
| Modifier | floor((score - 10) / 2), as `abilityMod` (`shared/statBlock.ts:84`) |
| Save | mod + `pb` if proficient + `adjust.saves[a]` + `allSaves` |
| Check, no skill | mod + `allChecks` |
| Skill | the usual ability's mod (`SKILLS`, `shared/rules/skills.ts:23`) + 2 x `pb` for expertise, `pb` for proficiency, floor(`pb` / 2) with Jack of All Trades and neither, else 0, + `adjust.skills[s]` + `allChecks` |
| Initiative | Dex mod + `pb` with Alert + `allChecks` + `init`. Initiative is a Dexterity check, so the checks bonus counts. Jack of All Trades needs a skill, so it does not |
| Passive Perception | 10 + the Perception skill + `passive` |
| Spell save DC, attack | 8 + mod + `pb` + `spellDc`, and mod + `pb` + `spellAttack`, of `spellAbility`. None without one |

**The adjustment rule.** Every number above shows as one field holding its total, with its parts under it ("Dex +2, proficiency +3, other +1"). Typing a total stores total minus derivation as that number's adjustment. A changed score, level or proficiency moves the total and keeps the adjustment. Clearing the field sets the adjustment to 0. So the editor never asks which part a number came from, and a level-up never loses an item's bonus.

### 3.4 Named rolls

`pcNamedRolls(character)` gives each roll as doc 1's `NamedRoll` (doc 1 6), with `m` the modifier of its ability (`'spell'` reads `spellAbility`, and none is 0):

- **`key`** is the roll's id, **`section`** `spells` for a spell, else `actions`, and **`level`** a spell's level.
- **`attack`** = `m` + `pb` if `prof` + `bonus`. A spell's attack always counts `pb`, whatever `prof` says, and adds `spellAttack`, since a spell attack is the spellcasting modifier plus the proficiency bonus.
- **`save`**: `dc` as typed, else 8 + `m` + `pb` + `bonus`, + `spellDc` for a spell, and `onPass` as stored. An unset `onPass` is not known, never "none": it takes the SRD's rule for a spell of the same name from the table of every SRD spell that deals damage on a save, area spell or single target, read from each spell's text by `scripts/srd-import.ts` (`shared/srd/save-spells.json`, W7B-R2-3), then from the area presets' table for an area spell that deals no damage, else none for a cantrip and half for the rest (`unknownOnPass`), so an unset Fireball still halves and an unset Disintegrate or Sleep takes none. Where both tables name a spell, the save table's rule wins. The SRD's spell save DC, a Battle Master's maneuver DC and a breath weapon's DC are all this rule with the right ability.
- **Parts**: each part's dice count times the cantrip tier when `grows` (1, then 2 from level 5, 3 from 11, 4 from 17), plus `m` when `mod`, written by `formatFormula`, so the dice come already at the character's level. A typed part goes in `damage` with its `type`, its `upcast`, and for a rider `optional` and its `name`. Healing parts, joined by +, are `heal` with their `upcast`. Untyped parts, joined, are the plain `dice`.
- **Critical range**: a weapon roll carries the block's `critOn` as `NamedRoll.critOn` (section 9), which doc 3 sends with the attack. Spells and other rolls crit on 20 alone, since Improved Critical names weapon attacks and Unarmed Strikes.
- `recharge`, `uses`, `conditions`, `saveEnds` and `lasts` stay absent. **Order**: weapons, then spells by level then name, then other rolls by name, ties by id.
- **Slots**: `pcSlots(character, key)` is `{ from, at(slot) }` for a spell with any `upcast`, else null. `at(slot)` returns the whole `NamedRoll` cast at that slot: each damage part and `heal` gain `(slot - level)` x their `upcast`, the plain `dice` stays, and `level` stays the spell's own, so the stepper's range never moves. Doc 3's row takes its Damage, Heal and plain buttons from that one result.
- **While shaped** (3.6), `pcNamedRolls` keeps only the other rolls in Wild Shape, which casts no spells and wields no weapons, and gives none in another shape. The beast's actions come from its linked block, as for any linked token (doc 3).

### 3.5 Ops, limits and the reducer

- `character.update`'s patch gains `stats: PcStatsPatch | null`, every part optional. Each named part replaces that part whole. A part left out keeps its value, or the empty block's (`EMPTY_PC_STATS`: every score 10, nothing proficient, no adjustments, defenses or rolls) for a character without one. `null` removes the block, and the actor keeps its last initiative and Passive Perception as typed numbers. `character.create` may carry `stats` whole.
- **Bounds**: scores 1 to 30, adjustments -20 to 20, `dc` 1 to 50 (doc 1's `rollDc`), 40 rolls with ids unique in the block, 4 dice parts a roll, `upcast` 20 characters, every list without repeats. The patch is at most 12 KiB serialized in the schema (`LIMITS.pcStatsBytes`), and the reducer refuses a block that would end past it, with `quota`: "Bree's stat block can be at most 12 KiB. Remove a few rolls." A wizard's with 32 rolls is about 6.3 KB (Appendix A).
- **One rule writes the two actor numbers.** After every `character.create` and `character.update`, a character with stats has `actor.initBonus` and `actor.passivePerception` set to `pcDerived`'s, clamped to the actor's bounds (-20 to 40, 0 to 60). An actor patch that names either, through `character.update` or a PC token's `token.update`, on a character that ends the op with stats is refused `invalid`: "Bree's initiative and Passive Perception come from the stat block. Change them there." That holds for the DM too, since the next stats edit would overwrite the number anyway.
- **The block's room cost.** Characters are room-level, so the blocks count in the DM's projected scene (`LIMITS.projectedSceneBytes`, 3 MiB) as the rest of a character does. 50 characters at the cap would be 600 KiB, and a real party's about 20 KB. A save that the size guard or the state limit refuses reads in the block's words, `BLOCKS_ROOM_TOO_FULL`, as a companion block's does.
- **Undo**: the DM's stats edits go on the DM's stack with the character's other edits, "changing Bree's stat block" and "removing Bree's stat block", and an undo puts back the block and the two actor numbers together, since both are the character. A player's go on no stack, by the rule for players' stacks. The log gets no line, as for other card edits.
- **Versions**: doc 2 needs no bump of its own and rides the wave's one, `OP_VERSION` 7 and `SNAPSHOT_VERSION` 11 (doc 4 7.5). `stats` is an optional field whose absence reads as before, and every stored op from before this build ran on characters without it, so the derived write and the refusal never meet an older op. Rolling back means restoring the backup that README's Updating section takes first.
- **Export and import**: `room.json` carries the block. `server/rooms/stateSchema.ts`'s character takes it through the protocol's schema (`pcStatsForImport`), nothing in it names another entity, so remap leaves it, and normalizing a hand-made file sets the two actor numbers by the rule above.

### 3.6 Wild Shape and other shapes

The 2024 Wild Shape keeps the druid on its own token with its own HP. The beast's stat block replaces the druid's numbers, except that the druid keeps its Intelligence, Wisdom and Charisma and its save and skill proficiencies, used with its own proficiency bonus, and takes the beast's save or skill bonus where that is higher (SRD 5.2.1, Druid, Wild Shape). So a shape is a link on the character's own actor:

- **The link** is `srdId`, an SRD creature, with `wildShape: true` for Wild Shape. Without the mark it is another shape, such as Polymorph, which replaces every number. The character's players may set both, as the DM may (4.1). Only an SRD link is a shape. A `monsterId` the DM sets on a character is not, since a player's view lacks it, so the server and the player's device never disagree on a bonus.
- **Numbers**: `shapedNumbers(character, beast)`, with `beast` the creature's `RollNumbers` from doc 1's `SrdRolls`: Str, Dex and Con modifiers from the beast, Int, Wis and Cha from the druid. Each save and skill is the higher of the druid's rule (3.3) on those modifiers, proficiencies and adjustments included, and the beast's printed one. A check is the modifier plus `allChecks`. The spell DC and attack stay the druid's. `shapedInitiative(character, beast)` is the beast's Dex modifier plus Alert, `allChecks` and `init`.
- **Which numbers roll**, through doc 1's `creatureNumbers` and `creatureBonus` (section 9): Wild Shape with a block gives `shapedNumbers` and `shapedInitiative`. Wild Shape without a block, or another shape, gives the beast's own numbers, with initiative still the actor's, since such a spell is cast in a fight. No shape gives `pcRollNumbers`.
- **Rolls and defenses**: the beast's actions and defenses come from its block (doc 3). `pcNamedRolls` keeps only the other rolls in Wild Shape (3.4). `pcDefenses` gives no damage defenses while shaped, and keeps `evasion` in Wild Shape, a class feature the druid keeps, never in another shape.
- **What stays**: HP, conditions and the actor's `initBonus` and `passivePerception`, which the reducer derives from the druid's block and never from the SRD table, so a replay never reads data a later release may change. The view shows the shaped Perception, and party sight keeps the druid's.
- **Changing it**: a patch that sets `srdId` sets `wildShape` as it says, absent being off, and clearing `srdId` clears it. `wildShape` on another actor, or without `srdId`, is refused `invalid`. Size and picture change by their own controls, Size in the token window (docs/design-v1-token-window.md 8.6) and Other images.

## 4. Who edits, who reads

### 4.1 Permissions

- `OWNER_CHARACTER_FIELDS` gains `stats`, and a character's owner actor fields gain `srdId` (an SRD link only) and `wildShape` (3.6), on the server and in the client mirror. So the character's players and the DM edit the block and take shapes, with no room setting, and other players get `NOT_YOURS` as for any field of a character they do not play. A player's new character may carry it, since they could set it right after.
- **Every player op that writes a block spends one** from the per-member bucket the companion blocks use (`isBlockOp`, `server/rooms/actor.ts:200`), refused with `BLOCK_SAVES_TOO_FAST`: a `character.create` carrying `stats`, and a `character.update` naming `stats`, `null` included. A fill's Save is such an update. A player's undo never restores a character, since their stack holds only drawings, moves and resizes, and a test pins that. So creating and deleting characters cannot churn stored blocks, as creating and deleting blocks cannot. A block is up to 12 KiB and every op is stored, so the socket's rate alone would let a player write a quarter of a megabyte a second. The DM's ops are not counted.

### 4.2 Projection

| Viewer | Receives `stats` |
| --- | --- |
| DM, co-DMs | whole, as the character |
| The character's players, co-owners included | whole, with the character's `rev` 0 |
| Other players, a player who owns only one of its tokens | never: `projectCharacter`'s list has no `stats` |
| Table display | never |
| "View as a player" | the previewed player's projection |

Rolls made from the block reach the log by doc 1 5.2, as the project owner answered: a public roll's line shows its formula, so other players read that one bonus as they would at the table. `projectCharacter` needs no change. A test holds the third row, so a later edit of that list cannot leak the block. During a blackout the block stays, as characters are not scene data. Prediction is as for any `character.update`, but the editor still waits for the server (7.2).

## 5. The contract for docs 1, 3 and 4

```ts
// shared/dice/bonus.ts (doc 1 6)
pcRollNumbers(character)   // RollNumbers | null: null without stats. Every skill with its whole bonus, check only
                           // where it differs from mod, spellDc and spellAttack from spellAbility (absent without
                           // one), deathSave from allSaves where it is not 0. bonusFor needs no PC rule.
// shared/rules/pcStats.ts
pcDerived(stats, level)    // every number of 3.3, with parts
pcNamedRolls(character)    // doc 1's NamedRoll[], in 3.4's order. Empty without stats
pcSlots(character, key)    // { from, at(slot): NamedRoll } | null: a spell cast at a higher slot
pcDefenses(character)      // { defenses: Defense[], evasion }: doc 3 3.3's Defense, unqualified, source "Stat block"
shapedNumbers(character, beast), shapedInitiative(character, beast)   // Wild Shape (3.6)
// client/features/pcstats/open.ts
openPcStats(characterId)   // the editor, for the DM and the character's players
```

- **Doc 1**: every d20 roll is a `D20Test` (doc 1 6.1): `save` (with its `cause`, concentration or save ends, and `spell`), `deathSave`, `check`, `initiative` and `attack`. A PC needs nothing more for them. A save of any cause reads its ability's save, an attack its `NamedRoll`'s `attack`, initiative the actor's `initBonus` or `shapedInitiative`, and a death save `deathSave`, since a bonus to every saving throw, such as a Cloak of Protection, reaches a death save too, as doc 1 says of any rule about saving throws in general. The server reads the room's character, so a block edited between "Roll +5" and the roll rolls the new bonus (doc 1 11).
- **Doc 3** lists a PC's saves, checks and skills through `creatureNumbers`, its spell DC and attack from `RollNumbers`, its rolls from `pcNamedRolls` with riders as named optional parts and weapons' `critOn`, a spell's slots from `pcSlots`, and its defenses and `evasion` from `pcDefenses` into `CreatureRolls` (doc 3 3.4). Doc 3 3.3 applies Evasion, and not while the creature is Incapacitated or has a condition that includes it (Stunned, Paralyzed, Unconscious, Petrified), by doc 3's one incapacitation rule. A shaped character lists the beast's actions and defenses from its block (3.6). Doc 3 decides crits, labels and where results go, and owns `blockActions(view)`, which 6.2 calls.
- **Doc 4**: the card's Roll appears for a PC with a block through `creatureBonus`. Without one it offers "Roll d20" with a bonus the player types (decided for the project owner, doc 4), and "Add a stat block" through `openPcStats`.
- **The stat block view stays text this wave** (decided for the project owner, section 16): every roll is made in the Dice panel, where Advantage and secret stand.

## 6. Filling a stat block

### 6.1 The fill and its review

Pasted text and D&D Beyond both produce one shape, `PcFill = { stats, level?, name?, actor: { ac?, hpMax?, speeds?, senses?, sheetUrl? }, warnings }`, and one review step:

- **What it read**: "Read from D&D Beyond: Bree Tallow, level 5." or "Read from the pasted text.", then the warnings under "Check these", each one line, such as "AC 16 was worked out from the armor. Check it." or "12 more spells were left out. At most 40 rolls fit."
- **What it replaces**: the fill replaces every part it read, and keeps the rolls the player made: "Replaces the scores, proficiencies and the 14 rolls from the last import. Keeps your 2 own rolls." A roll from an import carries `ddb`. An imported roll edited in the editor loses the mark and becomes the player's own. Pasted text replaces the parts it found and adds its rolls beside the ones there, which the review counts: "Adds 3 rolls."
- **Also set**: one checkbox line for each other field that would change, new value then current, "AC 16, now 15": level, AC, max HP, speeds, senses, and the sheet link when it has none. All are on but the name, "Name Bree Tallow, now Bree", which starts off. The size is never set, since a player may not change it and a resize is docs/design-v1-token-window.md's.
- **Max HP by one rule**, the companion design's (docs/design-v1-companion-stat-blocks.md 5.2): a living character at its maximum stays at its new maximum, and any other keeps its HP, cut to the maximum if higher. A fill never brings a character back or puts one down, and never sets current or temporary HP.
- **Use it** fills the editor's draft and returns to it. Nothing is sent until Save, so a fill can be looked over, changed or cancelled whole.

### 6.2 Pasted text

The "Paste text" step runs `parseStatBlockText` on the text, then `statsFromBlock(block, level)` (`client/features/pcstats/fromBlock.ts`) reads each printed number as **the derivation it matches, else as typed**, by one rule: of the derivations a number could have, take the one nearest it (ties to the lower), and keep the rest as the adjustment.

- **Scores** as printed. **Saves**: proficient where the printed save is nearer mod + `pb` than mod. **Skills**: each one listed takes none, proficiency or expertise, whichever is nearest. **Initiative and Passive Perception** keep their differences as `init` and `passive`.
- **Actions**: the block goes through doc 3's `blockActions(monsterView(block))`, and each `NamedRoll` becomes a roll. An attack's bonus takes the ability whose mod + `pb` matches it, Dex first for a ranged attack, else Str with the difference as `bonus`. A damage constant equal to that modifier becomes `mod`. A save's DC is derived where an ability matches, else fixed, and `onPass` is kept. A part the reader marks `optional` becomes a rider, with its `name` where the reader gives one. A trait named "Evasion" sets `evasion`. `heal` becomes a healing part. Recharge, uses and conditions stay in the pasted text only. The Spellcasting trait's DC and attack, as doc 1's `blockRollNumbers` reads them, give `spellAbility` (the ability whose 8 + mod + `pb` is nearest the DC) and the adjustments.
- **Also set**: the AC, the HP average, the speed (`speedsOf`) and the senses, as the review lists them.
- `pb` is the character's level's. With none set, the step says "Set Bree's level first, so proficiency reads right." above "Read it", and reads with +2.

### 6.3 D&D Beyond

**The link.** The step's field, "Share link or character number", starts with the character's sheet link when that is a D&D Beyond one. `ddbCharacterId(text)` (`shared/ddb/link.ts`), used by both sides, takes a number of 1 to 12 digits, or the digits after `/characters/` in an https URL on `www.dndbeyond.com`, `dndbeyond.com` or `ddb.ac`. Anything else: "That is not a D&D Beyond character link. Paste one like dndbeyond.com/characters/12345678, or the character's number."

**The route**, `POST /api/rooms/:id/ddb-import { link }` with a link of at most 300 characters, in `server/http/ddbImport.ts`, for any member with a grant, under design 10.7's CSRF rule:

1. **Budgets**: 20 an hour per session, 60 per address (an IPv6 /64 as one), 300 per server, in a `WindowLimiter`, checked before and spent only when the request goes out. Spent: 429 `quota_member`, `quota_ip` or `quota_global`.
2. **A slot**: one from a `Semaphore` of 2 for the server and one from a `Semaphore` of 1 for the room, both taken before the fetch and held through the read and the schema check. Every end releases both: an answer, a refusal, a failure, the timeout, and the member's request closing, which also aborts the fetch. No slot: 429 `busy` with Retry-After 5. So at most two bodies of 5 MiB and their parsed objects are in memory at once, well within the container's memory.
3. **Fetch** `https://character-service.dndbeyond.com/character/v5/character/<id>`, built from the digits alone, so no member's URL is ever fetched. It goes through `egress.strict` (`server/assets/egress.ts:33`), whose squid list gains exactly `character-service.dndbeyond.com`. GET, no cookie or credential, `accept: application/json`, `accept-encoding: identity`, the Openverse transport's user agent, 10 s for the whole exchange, at most 5 MiB read and counted while streaming, no redirect followed.
4. **Answer**: 200 with JSON is read. A JSON body whose `success` is false, or a 401 or 403 with a JSON body, is `private`. A 403 without one is a block in front of D&D Beyond, not privacy. 404 is `not_found`. Anything else, a timeout, a body past 5 MiB or one that is not JSON (a challenge page) is `fetch_failed`, one code, so no answer says more about the network.
5. **Read** with `readDdbCharacter(json)` (`shared/ddb/read.ts`). The fill is checked against the protocol's stats schema before it is sent, and one that fails is `unreadable`. The answer is `{ fill }`, a few KB. The body is never stored or logged: the log line holds the status and the byte count.

**Pasted JSON.** "Paste its JSON instead", under the field, takes up to 5 MiB of text and reads it in the browser with the same `readDdbCharacter`, in a lazy chunk behind the shared delayed indicator. It takes the `{ success, data }` envelope or the bare `data`. Once a number is known, the step shows "Open its data in D&D Beyond", a link to the URL above in a new tab (`rel="noopener noreferrer"`), whose page can be copied whole. Either way the character must be Public in D&D Beyond.

**The reader** reads named paths of the JSON (Appendix B), never walks the tree, never throws, bounds every count it loops over, and reads numbers, ability ids, damage type names and the names of classes, weapons and spells. It never reads a description, snippet, note or any text field, so no D&D Beyond prose and no HTML enters a room. What it cannot read becomes a warning, and the fields stay as the editor had them. It takes scores with bonuses, overrides and "set" items, save and skill proficiencies, expertise, Jack of All Trades and Alert, the bonuses to saves, checks, initiative, Passive Perception and spells, defenses, the spellcasting ability of the first casting class, AC from equipped armor and shield (always a line to check), max HP, speeds and darkvision, and up to 40 rolls: equipped weapons, then spells with dice, an attack or a save (prepared, always prepared, known, and cantrips), then actions with dice or a save. A Versatile weapon gives a second roll, "Longsword (two hands)". Sneak Attack's dice become a rider on each Finesse or Ranged weapon, Improved or Superior Critical among the class features sets `critOn`, and Evasion sets `evasion`, each by name and only once the class's level reaches the feature's (Appendix B). A cantrip whose dice follow the tier rule gets `grows`, and any other scaling takes the dice at the character's level with a warning.

**Words**: each code's alert, under Get it, ends with the way out, in Appendix D's words.

**Terms.** docs/features.md:662 ruled this out for D&D Beyond's terms. The project owner chose it best effort. So the server fetches only on a member's tap, once per tap, only a character its owner made public and linked, keeps no copy, reads no text, and caps how often any server asks. An operator who wants none of it removes the host from `docker/squid.conf`, and the link import then answers `fetch_failed` while pasted JSON still works.

## 7. Surfaces

### 7.1 The character's card

The card (`client/features/tokens/CharacterCard.tsx`) gains a "Stat block" section after Rest, for the DM and the owners. It holds the same view and buttons as the token panel's (7.3), folded to start. Its Level field's hint gains "Sets the proficiency bonus too." With a block, the light card's Initiative and Passive Perception show as text, "+2, from the stat block", in the card and in the token panel's Stats fold (`StatsFields`).

### 7.2 The editor

`PcStatsEditor` (`client/features/pcstats/`), a dialog through the dialog shell: a bottom sheet on a phone, a card from 600 px. Title "Bree's stat block". Steps, each taking focus by `useStepFocus`: the block, "Paste text", "D&D Beyond", and the review. Fields are 16 px, targets 44 px, and it scrolls as one. **Narrow rows**: each ability and skill row is one wrapping line, its name and total first, then its controls as one group that drops under them when the row is too narrow for both (about 290 px, Appendix A), as at 320 px wide or 375 at 130%.

- **Fill from**: "Paste text" and "D&D Beyond", one row.
- **Level**, writing the character's `level` in the same op, and "Proficiency +3" beside it.
- **Abilities**: per ability, its score, its modifier, "Proficient" for its save, and the save's total field (3.3's adjustment rule).
- **Skills**: "Jack of All Trades" first, then 18 rows: the skill with its ability, a select of None, Proficient and Expertise named "Stealth proficiency", and the total field.
- **Other numbers**: Initiative with "Alert: add proficiency", Passive Perception, and "All saves" and "All checks", each a total field, and "Critical hits on" 20, 19 or 18 and up.
- **Spellcasting**: a select of None and the six abilities, then the save DC and attack totals.
- **Defenses**, folded with its count: "Evasion", then each damage type with a select of None, Resistant, Immune and Vulnerable.
- **Rolls**: Weapons, Spells and Other, each row a disclosure with its name and its reading ("+6 to hit, 1d8+3 slashing"), opening to its fields: name, kind, ability (with "Spellcasting ability"), Attack roll with Proficient (on a weapon or other roll, since a spell's always counts it) and Other bonus, Save with its ability, "Fixed DC" and "On a pass" (Not set, Half or None, with a line under it saying what Not set takes), the dice parts (formula, "Add the modifier", type, "Only sometimes" with its name for a rider, and for a spell its level, "Grows with level" for a cantrip and "At higher levels" on a damage or healing part), and Remove. "Add a weapon", "Add a spell" and "Add a roll" sit under their lists, "12 of 40 rolls" beside them. A new spell takes `'spell'` as its ability and, at level 0, `grows`.
- **Checks** list problems above the footer and disable Save while any stands: a formula in `FORMULA_ERRORS`' words, a roll with nothing to roll, a roll whose dice at level 20 and slot 9 would go past doc 1's bounds, and the size from three quarters of 12 KiB, as the monster editor shows its own.
- **Save** sends one `character.update`: the parts that differ from the block the editor opened with, and the Also set fields. So a part another device changed meanwhile is kept unless this draft changed it too, where the later save wins. It waits for the answer, busy as "Saving…", and closes on `taken`. A refusal shows above the footer with the draft kept. The bucket's refusal disables Save for a few seconds, as the companion editor does. `unknown` says "The connection dropped before the server answered. Check Bree's stat block before saving again."
- **Closing** with changes asks `DiscardQuestion`. Closed while the save waits, the save lands, and a late refusal is a toast in its words. A character that leaves the view, deleted or no longer theirs, shows "This stat block was deleted or is no longer yours, so it cannot be saved." with the draft kept and Save disabled.
- **Get it** is busy as "Getting Bree from D&D Beyond…" under the shared delayed indicator and refuses a second tap. A newer Get it, Back, or closing aborts the request, and an answer that is not the latest request's changes nothing. Read it on pasted JSON is busy while the chunk loads and reads.

### 7.3 The token panel

`statBlockShown` gains the PC: the DM and the owners of a PC token's character see the Stat block section, with its summary line and its remembered fold, first after the image, as on a companion.

| The character has | The section shows | Buttons |
| --- | --- | --- |
| No block | the summary line | "Add a stat block" on the heading's row |
| A block | `PcStatsView` | Edit |

**Shapes**: "Take a shape" on the heading's row, for the DM and the character's players, opens the SRD picker with Beasts filtered in, then one step: "Wild Shape: Bree keeps her Intelligence, Wisdom, Charisma and proficiencies" (the default) or "Polymorph or another shape: all of Brown Bear's numbers", a checkbox on by default, "Gain 9 temporary HP (Wild Shape)" (the level, read as the Druid level) or "Gain 22 temporary HP (Polymorph)" (the creature's HP), shown only where it is more than the character holds, and Take the shape, one `character.update` that also sets the creature's AC and speeds (W7B-P-9). The reducer keeps the character's own AC and speeds in `unshaped` from the patch that takes a shape and puts them back on the one that ends it, and takes away what is left of Polymorph's temporary HP while the pool is still the shape's. The pool is marked (`shapeTemp`) by the patch that gives it, damage keeps the mark, and any other source that sets the pool (a grant, a set that changes it, a Long Rest, another shape) takes it away, so the end never takes temporary HP that came from elsewhere (W7-SOL-06). An HP line taken back from the log puts the mark back with the numbers while the creature is still in that shape, and empties a shape's pool once the creature is in no shape, as End the shape would have (W7-SOL-07). Each line records whose the pool was before and after its change, and taking it back is refused when the pool's owner now differs from what the line left, even where the numbers match (W7-SOL-08). Ops stored before version 7 do none of this. While shaped, the section shows under either row "In Wild Shape as Brown Bear. Rolls use its Strength, Dexterity and Constitution, and each save and skill takes the higher.", the SRD block with today's view, and "End the shape".

`PcStatsView` reads as a 2024 block in the stat block view's type: "Level 5, proficiency +3", the six abilities with score, modifier and save (proficient saves named so for screen readers), "Skills" with every skill that has proficiency, expertise or an adjustment, "Initiative +2, Passive Perception 15", "Spellcasting Wisdom, save DC 13, attack +5", the defenses and "Evasion", then Weapons, Spells and Other rolls, one line each, as "Longsword. +6 to hit, 1d8+3 slashing." and "Fireball (level 3). DC 13 Dexterity save, 8d6 fire, +1d6 for each slot level above 3." The view is React text, never Markdown, so a later tap to roll can turn its numbers into buttons.

### 7.4 The action bar and the tracker

- **The action bar** of a PC token with a block or a shape shows the DM and its players the saves line over `creatureNumbers`, the numbers its rolls use, shaped or not, the defense lines from `pcDefenses` or, while shaped, the beast's block, and "Stat block", as for a monster (`useLinkedBlock`, `client/canvas/TokenActionBar.tsx:199`, `:309`, `:376`).
- **A PC's tracker row** offers "Stat block" in its options to the DM and the character's players when the character has a block. Both open the panel at the block through `openStatBlock`.

### 7.5 Keys

No key or key-plus-pointer combination is added or changed. The editor's fields and dialogs keep the field and dialog shell keys, so the shortcut sheet and FEATURES.md's "Shortcuts" need no change.

## 8. Security

- **The fetch** goes to one fixed host, built from digits, on the strict port's exact-name list, https with TLS checks on, no redirects, no credentials, 10 s, 5 MiB counted as it streams, identity encoding. Every network failure is one code. Budgets per session, address and server bound how often anyone, or the server as a whole, asks, and two slots, one a room, bound how many bodies are in memory at once.
- **What comes back** is read by named paths into bounded numbers and short names, checked by the op's own schema before it is answered, and saved only by the member's Save, through the op and every check it has. Raw JSON never reaches the room or the log.
- **Text**: names render as React text. No description, snippet or HTML is read.
- **Pasted JSON** stays in the browser, read by the same reader.
- **Who reads** is the character's projection, unchanged (4.2).
- **Rates**: the bucket for player saves, beside the socket's op rate and frame budget.

## 9. What this changes in other designs

- **docs/design-v1-dice.md 6** holds what doc 2 needs, as doc 1 now states it: `RollNumbers.deathSave` (6.1), which `pcRollNumbers` fills from `allSaves`, `NamedRoll.critOn` (6.2), which doc 2 sets on a weapon roll and doc 3 sends as `dice.roll`'s `critOn` (doc 1 5.6), the shape rule in `creatureNumbers` and `creatureBonus` (6.1), and `pcSlots` among 6.2's makers. `pcRollNumbers` fills `spellDc` and `spellAttack`. `DamagePart`'s `name`, `NamedRoll`'s `dice`, `level` and `upcast`, and `DamageType` are doc 1's. The contract gains 5's doc 2 functions.
- **docs/design-v1-roll-options.md**: reads 5's functions and owns `blockActions`. A PC's defenses come through `pcDefenses` in doc 3 3.3's `Defense` shape, and its `evasion` beside them, as 3.3 there asks. A PC's rider is an optional part whose `name` is the button's words, a weapon roll's `critOn` goes on its attack's `dice.roll`, and a shaped character lists its beast's actions. It puts no tap to roll on doc 2's view, which stays text (section 16).
- **docs/design-v1-roll-request.md**: the card without a block (5).
- **docs/design-v1-companion-stat-blocks.md 3.4 and 3.5**: the per-member bucket and the "too full" words also cover every player op that writes a PC's block.
- **docs/design-v1-token-panel.md 3.5**: the Stat block section also shows on a PC token for the DM and its players, with "Take a shape".
- **docs/design.md**: 6 gains 3.2's types, the derived write and `wildShape`. 8.1's owner fields gain `stats`, and a character's `srdId` and `wildShape`, and initiative and Passive Perception follow a block. 10.6's strict list gains `character-service.dndbeyond.com`. 10.8 gains the route. 17 records the project owner's answers of 2026-10-17.
- **docs/features.md**: 559's Wild Shape token stays for the 2014 way, beside the shape on the character. 661 stays (no sheet builder), and 662's D&D Beyond import moves into the features with the project owner's answer.
- **README**: the egress paragraph names the new host and how to turn the import off.

## 10. Edge cases

| Case | Outcome |
| --- | --- |
| Level unset | proficiency +2, and the editor says "Level not set: proficiency +2." |
| Level 4 to 5 | every proficient number +1, expertise +2, Jack of All Trades still +1, adjustments kept, initiative and Passive Perception rewritten by the reducer |
| Score 30, score 1 | modifiers +10 and -5 |
| Expertise with Jack of All Trades | expertise. Jack adds only where neither is set |
| A typed total, then a score change | the total moves with the score, the difference stays |
| The light card's Initiative on a PC with a block, or an old page sending it | not offered. Sent, refused with 3.5's words |
| Block removed | initiative and Passive Perception keep their last values, typed again |
| A total past the actor's bounds | the actor holds the clamped value, the editor shows it so |
| Another player, a display, a blackout | no `stats`. The owner keeps it through a blackout |
| Co-owners saving different parts | both kept. The same part: the later save wins |
| Ownership removed or the character deleted while editing | the editor's "no longer yours" line, the draft kept |
| A 41st roll, a 5th dice part, 12 KiB | Add disabled with "At most 40 rolls.", no fifth part, the size check |
| A formula a later grammar refuses | shows as text, no roll |
| A spell with `'spell'` and no spellcasting ability | `m` is 0, and the editor flags "Choose a spellcasting ability." |
| A slot below the spell's level | `pcSlots` starts at its own level |
| A plain roll, as Bardic Inspiration's d8 | `dice`, never offered to an HP entry |
| A healing-only spell, or one with damage, healing and a plain die, at a higher slot | each damage part and `heal` scale by their own `upcast`, the plain `dice` stays, `level` stays the spell's |
| A spell's attack with Proficient unticked, by an old draft or a crafted op | `pb` counts anyway |
| A Champion with `critOn` 19 | its weapon rolls crit on 19 and 20, its spells and other rolls on 20 |
| A critical with a rider | doc 3 doubles every part, the rider's included |
| Evasion on a Dex save for half, in Wild Shape, in Polymorph | doc 3 applies it: none on a pass, half on a fail, not while Incapacitated or with a condition that includes it. Kept in Wild Shape, gone in Polymorph |
| A cantrip that adds beams, not dice (Eldritch Blast) | untick "Grows with level". Each beam is its own roll |
| A request asks a PC with a block, or without | "Roll +5" through doc 1, or "Roll d20" with a typed bonus (doc 4) |
| Stats edited between the card's bonus and the roll | the server's bonus (doc 1 7) |
| Wild Shape with a block | `shapedNumbers` and `shapedInitiative` (Appendix C) on every device and the server |
| Wild Shape without a block, or Polymorph | the beast's own numbers. Initiative in Polymorph stays the actor's |
| Passive Perception while shaped | the actor's, the druid's. The view shows the shaped Perception |
| A `monsterId` on a character | not a shape: the PC's numbers on every device |
| The SRD rolls table still loading on a device | no shaped bonus offered there until it loads, under doc 3's indicator. The server holds it from boot |
| End the shape, or a new one | `srdId` and `wildShape` set or cleared together, in one op |
| A separate SRD token for Wild Shape, the 2014 way | a monster token with its own numbers, as today |
| A link that is not D&D Beyond's, or a URL with a path trick | `ddbCharacterId` takes digits only from the named hosts. The server builds its own URL |
| Private, missing, D&D Beyond down or blocking, a challenge page, 6 MiB | `private`, `not_found`, `fetch_failed` with words and the JSON way out |
| The operator removed the host | `fetch_failed`. Pasted JSON works |
| D&D Beyond changes its format | `unreadable` or warnings, never a throw. Typing still works |
| JSON of 5 MiB pasted on a phone | read in the lazy chunk behind the indicator. Over 5 MiB: refused before reading |
| Level 21 from a multiclass sum | 20, with a warning |
| Re-import after a level-up | scores, proficiencies, adjustments and imported rolls replaced, own rolls kept, max HP by its rule |
| An import while hurt, dying or dead | max HP only, current cut if higher, life unchanged |
| A DM imports for a player's character | allowed. The DM may edit any character |
| Get it twice, Back, or closing mid-fetch | aborted. A late answer changes nothing |
| The budget spent | the server's words, and the way out |
| A second import in a room, or a third on the server, while others run | 429 `busy`, and the way out |
| An import whose member closes the request | the fetch aborts and both slots free |
| A player creating characters with blocks past the budget | refused with `BLOCK_SAVES_TOO_FAST`, as a save is |
| Undo after the DM's edit | the block and the two actor numbers come back together |
| Export then import | the block travels, the actor numbers set from it |

## 11. Self-sweep

Swept as classes before reporting:

- **One derivation**: `pcDerived` feeds the editor, the view, the action bar, doc 1's bonus on both sides and the reducer's write. Every writer of `initBonus` and `passivePerception` on a character was found (the light card, the token panel's Stats fold, a PC token's actor patch, create, import, and `sys.restore`, which puts back the whole character) and each either derives, is refused, or restores both together. `applyActorPatch` is the only reducer line that sets them (`shared/reducer/tokens.ts:148-149`).
- **Visibility**: every viewer of 4.2, the preview and the blackout. The only path is the existing projection, now under a test.
- **Bounds**: per number, per roll, per op, per character, per room's DM snapshot, the frame and the bucket.
- **Replay**: new optional field, no op meets the new rules before it exists, no formula parsed in a schema.
- **The fill flow** as a state machine: fetch, abort, a newer request, close, a late answer, save, refusal, unknown. It gets a randomized test (12).
- **The third party**: every failure of D&D Beyond ends in words and a way out, and none can write the room without Save.
- **The shared shapes**: every name doc 2 calls from doc 1 or doc 3 (`RollNumbers` with `spellDc` and `spellAttack`, `NamedRoll`, `DamageType`, `blockActions`, `CreatureRolls`) is cited, not defined here. Evasion, the one class feature doc 3's rows read, is a field of the block, its paste and its import. Every PC roll field maps to a `NamedRoll` field or to `pcSlots`, and the two fields doc 2 needed from doc 1, `deathSave` and `critOn`, are doc 1's now (section 9). `pcDefenses` returns doc 3's `Defense`, so doc 3 reads a PC's defenses as a block's.
- **Every writer of a block** spends the budget: a create with `stats`, an update naming it, `null`, a fill's Save. A restore never comes from a player.
- **Every shape of a creature's numbers** goes through one dispatch (3.6): no shape, Wild Shape with and without a block, another shape, a `monsterId`. The bar, the card's bonus and the roll read the same numbers.
- **Every scaled part**: damage, healing and the plain roll, with the spell's level kept. **Every kind of d20 roll** in doc 1's `D20Test` has its PC number (5).
- **Every holder of server memory** in the import: two slots, freed on every end.
- An earlier take stored saves and skills as typed totals with proficiency marks. It lost the level-up, so the adjustment rule replaced it.

## 12. Tests

- **Unit**: `shared/rules/pcStats.test.ts`, every row of 3.3 and 3.4 (the bonus table, expertise and Jack, Alert, the checks bonus on initiative, spell numbers, `grows` tiers, a spell's attack always counting `pb`, riders, `critOn` on weapons alone, `pcSlots` on a healing-only and a mixed spell with `level` kept, the NamedRoll mapping of section, heal, dice and `onPass`, `pcDefenses` in doc 3's `Defense` shape with `evasion` kept in Wild Shape and dropped in Polymorph, `shapedNumbers` and `shapedInitiative` with Appendix C's bear, with and without a block, and Polymorph, the order) and the adjustment rule across level changes. `bonus.test.ts`: `pcRollNumbers` through `bonusFor`, a skill with another ability. `shared/reducer/tokens.test.ts`: parts replaced and kept, the empty block, the derived write on create, update and level, the refusal on both ops, `null`, the 12 KiB refusal, `wildShape`'s rules, undo. `protocol.test.ts`: bounds, formula characters, the largest op under the frame. `permissions.test.ts`: owner, co-owner, other player, DM, `srdId` and `wildShape` on one's own character but never `monsterId` or another's, and the bucket on a create with `stats`, an update, `null` and once spent, and a player's undo never restoring a character. `project.test.ts`: 4.2 as a matrix. `stateSchema` and normalize. `shared/ddb/link.test.ts` and `read.test.ts` over hand-made fixtures in the JSON's shape with invented characters and only the fields the reader reads, so no D&D Beyond text enters the repository: every path of Appendix B, missing and wrong types as warnings, the bounds. `client/features/pcstats/draft.test.ts` (totals, the patch against the opened block, checks) and `fromBlock.test.ts` (SRD-shaped 2024 and 2014 text through `blockActions`, the nearest rule and its ties).
- **Randomized** (`client/features/pcstats/flow.test.ts`): many random sequences of Get it, Read it, Back, Use it, edits, Save, close, and late, refused, `unknown` and aborted answers. Invariants: at most one fetch in flight. A stale or aborted answer never changes the draft. The draft changes only by an edit or Use it. A Save tap sends at most one op, never while one waits, never after close. A refusal leaves the draft as it was. After close nothing more is sent.
- **Integration** (`server/http/ddbImport.itest.ts`, with undici's `MockAgent` for D&D Beyond, no network): CSRF, the grant, the fixed URL whatever the link says, no redirect followed, the 5 MiB cap, the timeout, each status's code, the budgets, two requests at once in one room and three on the server (one `busy` each), both slots freed after a failure, the timeout and a closed request, nothing stored.
- **e2e**: new `e2e/pcstats.e2e.ts`: a player types scores and proficiencies and saves, the token panel and the DM's device show the totals, another player's device has none, a level change moves them, Take a shape changes the bar's saves line, AC and speeds and gives the temporary HP, and End the shape restores the rest, pasted JSON from a fixture fills the review. Touched: `characters.e2e.ts` and `tokenpanel.e2e.ts`. Run those three and `reach` during the build.

## 13. Build plan

One builder, after doc 1's steps 1 to 3 (the grammar, the server's rolls, `bonus.ts` with `NamedRoll`). Step 4 also waits for doc 3's `blockActions`:

1. `feat(characters): stat blocks for player characters` (model, schema, `LIMITS.pcStatsBytes`, `shared/rules/pcStats.ts`, the reducer's write and refusal, permissions and the bucket, the import schema and normalize, undo labels, `pcRollNumbers`, `pcNamedRolls`, `pcSlots`, `pcDefenses`, tests).
2. `feat(ui): the pc stat block editor and view` (the editor, the view, the card, the token panel, the light card's derived fields, the action bar, the tracker option).
3. `feat(characters): wild shape on the character's own token` (`wildShape`, the owner fields, `shapedNumbers`, doc 1's dispatch, Take a shape, the bar's saves line).
4. `feat(ui): fill a pc stat block from pasted text` (`statsFromBlock`, the review).
5. `feat(characters): import a character from d&d beyond` (`shared/ddb/`, the route, its slots, the squid host, README, pasted JSON, the randomized test).
6. `test(e2e): pc stat blocks`.
7. `docs: pc stat blocks in the feature list and the design` (FEATURES.md, docs/design.md and docs/features.md per 9).

**Deploy**: squid reads `docker/squid.conf` at start, so restart the egress container after the update. Open pages keep working, and a reload brings the editor.

## 14. FEATURES.md

- "## Characters and monsters" gains, after the light stat card's bullet:
  - A player character can have a stat block: level, ability scores, saving throw and skill proficiencies with expertise, Jack of All Trades, Alert, a spellcasting ability, resistances, immunities and vulnerabilities, a critical range for Improved Critical, Evasion, and its weapons, spells and other rolls, with riders such as Sneak Attack or Hunter's Mark on an attack. Modifiers, saves, skills, initiative, Passive Perception, spell save DC and spell attack follow the scores and the level. Type a total to keep a difference, such as a Cloak of Protection's.
  - The DM and the character's players read and edit it. Other players and the table display never see it.
  - Fill it from pasted text, read as a stat block, or from D&D Beyond with a public character's share link or its JSON. It reads numbers, proficiencies, weapons and spells, never their text, and lists what to check before anything is saved. Importing again replaces what it read and keeps the rolls you added. It changes the maximum HP but never brings a character back or puts one down, and never changes the size. It is best effort, since D&D Beyond can change its format.
  - A character with a stat block shows it in its token's panel under the image and on its card, its saves in the action bar, and "Stat block" in its tracker row's options. Its initiative and Passive Perception come from the stat block.
  - Take a shape on a character's own token: an SRD creature as Wild Shape, where the druid keeps Intelligence, Wisdom, Charisma and proficiencies and each save and skill takes the higher of the two, or as Polymorph, with all of the creature's numbers. The token takes the creature's AC and speeds, and HP stays the character's. One checkbox, on by default, gives the 2024 temporary HP. End the shape to go back.
- "## Rolls": a request's Roll uses a character's stat block (doc 4 words the card).
- "## Running the server": the strict egress port also allows `character-service.dndbeyond.com`, for the D&D Beyond import. Removing it from `docker/squid.conf` turns the link import off, and pasted JSON still works.

## 15. Decided, for the project owner to overrule

- The block lives on the character, for the DM and its players, as its light card.
- Initiative and Passive Perception follow the block once there is one.
- Every number is its derivation plus an adjustment, and typing a total keeps the difference.
- A fill is reviewed before it is saved, replaces what it read, keeps the player's own rolls, leaves the name unless ticked, and never sets the size, current HP or temporary HP.
- D&D Beyond is reached on the strict port at one host, with no setting beyond squid.conf, and never for text.
- Every player op that writes a block spends the companion blocks' budget.
- A shape lives on the character's own token, set by its players or the DM through "Take a shape", Wild Shape by default. A separate SRD token stays possible, the 2014 way.
- A shaped character's Passive Perception stays the druid's, and initiative under Polymorph stays the actor's.
- Riders are optional parts on an attack, not rolls of their own.
- Rolls sort by kind, level and name, with no manual order.
- Portraits, spell slots and a new character made straight from D&D Beyond are later.

## 16. Decided by the project owner (2026-10-17)

1. **A PC's stat block is seen by the DM and that character's players only**, as the light stat card is today (4.2). Rolls made from it still reach the log by doc 1's rules.
2. **A request card always offers a roll** (decided for the project owner by the coordinator, round 1): with no block, "Roll d20" plus a bonus the player types (doc 4, and 5 here).
3. **No tap to roll in the stat block this wave** (decided the same way): the Dice panel stays the one place to roll, and the view stays text.

## Appendix A. Sizes

Measured with `JSON.stringify`, 21-character ids:

| What | Bytes |
| --- | --- |
| A fighter: 3 weapons, Second Wind, a Hit Point Die | 1,085 |
| A wizard: 2 weapons, 30 spells, each with dice and `upcast` | 6,309 |
| That wizard's character whole | 6,651 (333 without the block) |
| 40 rolls at every bound, 4 parts each | 30,084: past 12 KiB, so the byte cap binds |
| 40 rolls at every bound, 1 part each | 15,804 |
| One roll at every bound | 710 |

So 12 KiB holds about 70 typical rolls' worth, and the 40-roll cap binds first for real blocks. 50 characters at the cap are 600 KiB of a DM's 3 MiB scene budget. A frame of 64 KiB holds the largest op five times.

The editor's rows (7.2), in layout px, where "about" illustrates the rule:

| Row | Needs on one line | Content width |
| --- | --- | --- |
| An ability: name, score, modifier, Proficient, save total | about 290 | about 326 at 390 x 844 at 100%: one line |
| A skill: name and ability, the proficiency select, total | about 290 | about 256 at 320 wide at 100%, and at 375 x 667 at 130%: two lines |

## Appendix B. The D&D Beyond paths

The reader starts from these paths of `data`, each confirmed against a live public character during the build and kept in one table in `shared/ddb/read.ts`, a fixture per row:

| Field | Paths |
| --- | --- |
| Name, level | `name`, the sum of `classes[].level` |
| Scores | `stats[]`, `bonusStats[]`, `overrideStats[]` by `id` 1 to 6, plus `modifiers.*[]` with `type` "bonus" or "set" and `subType` "<ability>-score" |
| Proficiency | `modifiers.*[]` with `type` "proficiency", "expertise" or "half-proficiency", `subType` a skill slug, "<ability>-saving-throws", "ability-checks" or "initiative" |
| Adjustments | `type` "bonus" with `subType` "saving-throws", "ability-checks", "initiative", "passive-perception", "spell-save-dc", "spell-attacks" |
| Defenses | `type` "resistance", "immunity", "vulnerability" with a damage type `subType` |
| Items | `modifiers.item[]` count only for an `inventory[]` entry `equipped`, and attuned where it needs attunement |
| Casting | `classes[].definition.spellCastingAbilityId`, else `subclassDefinition`'s |
| Features | `classes[].classFeatures[].definition.name` and `requiredLevel`, against the class's `level`: Evasion, Improved Critical, Superior Critical, Sneak Attack |
| AC, HP, speed | equipped `inventory[].definition.armorClass` and `armorTypeId`, `baseHitPoints`, `bonusHitPoints`, `overrideHitPoints`, "hit-points-per-level", `race.weightSpeeds.normal` |
| Weapons | equipped `inventory[]` with `filterType` "Weapon": `damage.diceString`, `damageType`, `attackType`, `properties[].name`, `grantedModifiers` "magic" |
| Spells | `classSpells[].spells[]` and `spells.{race,class,item,feat}[]`: `definition.level`, `requiresAttackRoll`, `requiresSavingThrow`, `saveDcAbilityId`, `modifiers[]` "damage" with `die.diceString`, `atHigherLevels`. The JSON does not say whether a pass halves the damage, so `onPass` stays unset, and the warning names only the spells the SRD's table does not know |
| Actions | `actions.{race,class,feat}[]` with `dice.diceString`, `saveStatId`, `abilityModifierStatId` |

## Appendix C. Worked examples

- Bree, level 5, Dex 16, proficient in Dex saves, Stealth with expertise, a Cloak of Protection: `pb` +3, Dex save 3 + 3 + 1 = +7 (the cloak as `allSaves` 1), Stealth 3 + 6 + 0 = +9, initiative +3. At level 9: save +8, Stealth +11, the cloak still +1.
- The player types 10 into Passive Perception where the rule gives 13: `passive` becomes -3. Wisdom rises from 14 to 16 later: the rule gives 14, and the total reads 11, still 3 below it.
- A cantrip, Fire Bolt `1d10` with `grows` and `'spell'` on Int 18 at level 11: `hit` 4 + 4 = +8, dice `3d10` fire. Fireball, level 3, Int, save Dex with `8d6` and `upcast` `1d6`: DC 8 + 4 + 4 = 16, `onPass` half, and `pcSlots(…).at(5)` gives `10d6`.
- Bree, a level 5 druid (`pb` +3) with Str 10, Dex 14, Con 14 and Wis 16, proficient in Int and Wis saves and Perception, takes the shape of the SRD Brown Bear (Str 17, Dex 12, Con 15, Wis 13, every save its modifier, Perception +3) as Wild Shape. Str save: the bear's +3 with no proficiency, +3 either way. Wis save: 3 + 3 = +6 against the bear's +1, so +6. Perception: 3 + 3 = +6 against +3, so +6. Athletics +3, from the bear's Strength. `shapedInitiative`: the bear's Dex, +1. Spell save DC still 14. Without a block she rolls the bear's own: Wis save +1.
- Cure Wounds, level 1, a healing part `2d8` with `mod` and `upcast` `2d8`, Wis +3: `heal` is `2d8+3`, and `at(3)` adds two `2d8`, 6d8 and the modifier in all. A rapier `1d8` piercing with `mod`, Dex 18, and a rider `3d6` piercing named "Sneak Attack", at level 5: attack +7, `damage` `1d8+4`, then the optional `3d6`.
- Pasted "Saving Throws Str +6, Con +5" for Str 16, Con 14 at level 5: Str 3 + 3 = 6, proficient. Con 2 + 3 = 5, proficient. "Skills Stealth +8" for Dex 14: 2 + 6 = 8, expertise.

## Appendix D. The import's words

| Code | Says |
| --- | --- |
| `private` | "D&D Beyond would not share that character. Set its privacy to Public in D&D Beyond, then try again, or paste its JSON." |
| `not_found` | "D&D Beyond has no character with that number." |
| `fetch_failed`, or no answer in 15 s on the device | "D&D Beyond did not answer. Try again later, or paste the character's JSON." |
| `unreadable`, or pasted text that does not read | "That did not read as a D&D Beyond character. Its format may have changed. Paste its JSON or type the numbers." |
| `quota_*` | "Too many imports this hour. Try again in 12 minutes, or paste the character's JSON.", the minutes from the answer's Retry-After |
| `busy` | "Another import is running. Try again in a moment, or paste the character's JSON." |
