# raccoon-vtt v1: rolling from a creature's stat block, and the group save

Status: draft 2, revised for design-wave7 round 1, aligned with the other three wave 7 docs and the project owner's answers of 2026-10-17 (section 16). Code is cited from the wave 7 stack (doc 1 `lwottmxo`), whose code is the wave 5 tip's. This is doc 3 of the four wave 7 designs. It builds on docs/design-v1-dice.md ("doc 1": the formula, `dice.roll`, `roll.dice`, `D20Test`, `RollNumbers`, `NamedRoll`, the cancel rule, `useDicePanel`) and meets docs/design-v1-pc-stats.md ("doc 2": PC numbers and named rolls) and docs/design-v1-roll-request.md ("doc 4": the request sheet, the player's card, the DM's live card). Section 8 lists every contract this doc reads and every change to another design, in one place. Tables, sizes and worked examples are in the appendices, which verify rounds need not re-read.

The project owner asked on 2026-10-17: "Under this for dms they can select a token and get options for rolling dice for that token. Players get options for rolling dice for their characters and companions. [...] This should be a widely supported feature for saves, attack rolls, ability checks, and any other rolls you can think of." The same day: "the dm should be able to multi select monsters, roll something like a save for all of them, and then have a way to intuitively apply conditions/damage based on the result." Queued from 2026-10-15: "the DM being able to select a group of monsters, pick a save to roll, and quickly get back all of those values", with an area's save then damage, Legendary and Magic Resistance, recharge rolls, tap-to-roll stat blocks, monster concentration and group initiative offered as ideas.

## 1. Summary

- **Every creature's rolls come from what it already has.** Saves, checks, skills and initiative from doc 1's `creatureNumbers`. Attacks, damage, save actions, healing and recharge from the block's text through one reader, `blockActions`, which takes 2024 and 2014 wording, and from doc 2's `pcNamedRolls`, all as doc 1's `NamedRoll`. Defenses come from a reader that keeps their qualifiers, and from conditions such as Petrified and Rage.
- **One preset rule for every d20 roll.** `presetFor` gives each roll its advantage and disadvantage sources, extra dice and an automatic fail from the creature's effects: saves, checks, attacks, initiative, death saves, concentration and save-ends saves alike. Doc 1's cancel rule combines every source once, at the roll.
- **Roll options** sit in the Dice panel under the roller. The DM gets the selected token's, a player their characters' and companions'. A tap rolls on the server, the button shows busy, and the row shows its result in place. For a creature a player plays, the DM's save and check taps ask that player.
- **A result is used where it belongs.** A request's answer, initiative into the tracker, a death save counted by the server in the same op, a critical on the next damage, a recharge, and damage or healing offered in every HP entry, players' rolls included. Rolls also sit where players already act: the tracker's initiative box and the death save row.
- **Several selected creatures**: a DC, then one tap rolls a save or check for every monster and asks every player's creature, and opens the results. Initiative for those in the fight, and the attacks they share.
- **The group save** is one page: rows rolled by the server, asked, typed or failing outright, pass or fail against the DC, then the outcome (damage that keeps each typed part, full on a fail and half or none on a pass, conditions with their end, "save ends" included), each row overridable, and one Apply that the server applies as one op and one undo. "No save" keeps today's one-tap area damage.
- **An area opens the same page**, filled from its spell and its caster, and replaces the area's Damage page, so there is one path.
- **Saves after the fact.** A condition can end on a save at the end of each of the creature's turns. The DM's card rolls it, or asks a player's creature's player through a request that ends the condition on a pass by itself. Concentration cards gain Roll, and both cards know Magic and Legendary Resistance. Recharge actions are prompted at the start of their monster's turn.
- **Auto initiative rolls on the server**, the last roll a device made for itself.
- **Players** see their own request card, and the outcome on what they can see. Never the DM's results list.

## 2. Today

- **Group HP**: `hpTargets` (`client/features/tokens/groupHp.ts:34-63`) and `sendHpEntry` (`:94-96`) send one `actor.hp` per holder as one gesture, so two tokens of one character take damage once.
- **Area damage**: the DM types the damage once, marks each caught creature Fail, Pass or Skip (default Fail, Skip for the dead and objects), with All fail and All pass, and applies one `actor.damageMany` (`client/features/areas/damage.ts:37-108`, `AreaDamage.tsx:38-177`, opened at `AreasPanel.tsx:46`). `actor.damageMany` holds 100 hits and is the DM's (`shared/protocol.ts:984-986`). An unknown answer reads "Check the HP" (`AreaDamage.tsx:64-78`).
- **Group conditions**: `conditionOps` (`client/features/tokens/groupEdit.ts:92-102`) adds a condition to every creature that lacks it in `actor.effects` ops of 100 (`protocol.ts:1140-1143`). The picker and the duration form are `EffectPicker` and `DurationFields` (`client/features/tokens/EffectsSection.tsx:189`, `:482`) over `DURATION_MODES` (`client/features/tokens/durations.ts:27-32`). The reducer counts crossings (`shared/rules/durations.ts:68-126`, ticked at `shared/reducer/encounter.ts:301-308`). There is no "save ends".
- **One undo for a gesture**: `dispatchGesture` (`client/state/actions.ts:25-35`) groups ops, and the stack merges a group into one step while nothing else of that member's comes between (`server/rooms/undo.ts:98-140`).
- **Reminders**: `rollReminders` (`shared/rules/rollReminders.ts:28-163`) scopes each rule by `applies(kind, ability)` for saves and checks only, and Dodging and Raging quote their own exceptions (`:114-116`, `:128-130`). Initiative's hint is Invisible, Surprised and the incapacitating conditions (`shared/rules/initiative.ts:110-116`, `client/features/encounter/logic.ts:286-288`).
- **Requests** go only to creatures a player plays, on the players' scene (`shared/reducer/rolls.ts:22-31`), at most 50 targets, built by `askOp` (`client/features/rolls/logic.ts:179-216`). A DM's mark keeps the total beside the marked result (`rolls.ts:87-88`).
- **Stat blocks**: `tokenStatBlock` and `statBlockShown` (`client/features/monsters/statBlockLink.ts:36-48`, `:64`) decide which block a token shows and to whom. Every block has the SRD's Markdown shape (`shared/srd/monsters.ts:8-15`, `monsterView` in `shared/statBlock.ts:271`). `monsterFacts` indexes defenses for the filters and drops their qualifiers on purpose (`client/features/tokens/monsterFilters.ts:151-214`). The actor keeps Legendary Resistance uses (`shared/model.ts:740`).
- **Concentration**: damage to a concentrating creature logs a prompt with its DC (`shared/rules/hp.ts:87`, `:188`). Its owner, or the DM when no player owns it, gets a card with Passed and Failed (`client/features/encounter/logic.ts:568-581`, `InitiativeStrip.tsx:1080-1190`). The alerts read only lines that arrive after the first snapshot (`InitiativeStrip.tsx:1090-1095`).
- **Death saves** are absolute counts (`actor.deathSave`, `protocol.ts:986-991`), set from the death save row (`client/features/tokens/HpSection.tsx:274-275`). A player types initiative in the tracker row's value box (`client/features/encounter/Row.tsx:221`, `:489`).
- **Auto initiative** rolls on the DM's device (`client/features/encounter/autoRoll.ts:27-45`, `:272-308`), whose file also exports `Advantage` and its own `RollMode` (`:31`, `:136`).
- **Area presets** know shape, size, triggers and concentration, never a save or damage (`shared/srd/area-spells.ts:14-63`). A placed area keeps the spell's name and its caster (`client/features/areas/presets.ts:83`, `:88`).

## 3. What a creature can roll

### 3.1 Named rolls (`shared/dice/named.ts`)

A named roll is doc 1 6's `NamedRoll` with its `DamagePart`s, in this doc's shape plus doc 2's fields and the ones round 1 adds there (recharge 2 to 6, `saveEnds`, `lasts`, `conditions`). This doc defines neither type. A **character** gives its weapons, spells and other rolls through doc 2's `pcNamedRolls`, and a spell's slots through doc 2's `pcSlots`, which returns the scaled `NamedRoll`. A **block** gives its own through this doc's reader:

```ts
blockActions(view: StatBlockMonster): NamedRoll[]   // cached per view object. Doc 2's paste reader calls it too (doc 2 6.2)
```

`blockActions` reads each bold run-in paragraph of a section of the block's Markdown, in its order. Every rule takes both editions' wording, since room monsters and pasted text keep 2014 text as typed:

- **Attack**: "Melee Attack Roll: +4", "Ranged Attack Roll", "Melee or Ranged Attack Roll", and 2014's "Melee Weapon Attack: +4 to hit", "Ranged Spell Attack" and their mixes. The SRD's minus reads as minus.
- **Save**: 2024's "Dexterity Saving Throw: DC 21" and 2014's "DC 13 Dexterity saving throw". A Success clause that begins "Half damage" ("Half damage.", "Half damage only.", "Half damage, and ...") and 2014's "half as much damage on a successful one" give `half`, anything else `none`.
- **Damage and its timing**: each "5 (1d6 + 2) Slashing damage" in the Hit, the Failure, the "Hit or Miss" (read as a hit) or 2014's "Hit:" clause, its dice as the formula and its word as the type (doc 1's `DAMAGE_TYPES`). Only immediate damage counts. The clause's first sentence is always immediate, whatever else it says. A damage in a later sentence of the clause moves to a second named roll, "Engulf, later turns", with no save, only when that sentence says when it is taken ("takes … at the start of each of its turns", "at the end of each of its turns"). "until" and "for 1 minute" never move a damage: they set `lasts`. So an Adult Bronze Dragon's breath keeps its 3d6 Thunder with its Deafened "until the end of its next turn", and Gelatinous Cube's Engulf and Invisible Stalker's Vortex still split their later damage off.
- **Healing**: "regains 10 (3d6) Hit Points".
- **Recharge and uses** from the name: "(Recharge 4–6)", "(Recharge 5–6)", "(Recharge 6)" give 4, 5 and 6, and "(2/Day)" its uses.
- **Conditions and their end**: every "has the X condition" of the Failure clause, or of the "First Failure" clause when the action has one, as `conditions`. "repeats the save at the end of each of its turns" sets `saveEnds`. "until the end of its next turn" and "until the start of its next turn" set `lasts` with the target's turn, and a turn named for the acting creature ("the dragon's next turn", "the mummy's next turn") sets it with the actor's: doc 1 6.2's `lasts` holds `{ at: 'start' | 'end', of: 'target' | 'self' }`, and the fill anchors `DurationFields` on the row's creature or the acting one. A "Second Failure" clause stays text in the block.
- **Spellcasting**: "(spell save DC 20, +12 to hit with spell attacks)" fills `RollNumbers.spellDc` and `spellAttack` (doc 1 6) through `blockRollNumbers`, and lists no roll itself.
- **Multiattack** is a note, not a roll: its paragraph heads the Actions (4.2), so the DM reads "makes three Rend attacks" without leaving the panel.
- Every formula must pass `parseFormula` (doc 1 3.5), or its part is left out. A paragraph with nothing to roll gives none.

### 3.2 Presets for every d20 roll (`shared/rules/rollReminders.ts`)

```ts
type RollPreset = { sources: AdvantageSource[],   // doc 1 3.3's { kind, from }, `from` the effect's key or "magic-resistance"
  extra: string[],                                // "+1d4", "-4"
  fails?: ConditionKey, notes: RollReminder[] }
incapacitated(effects): boolean                   // Incapacitated, or a condition that includes it: Paralyzed, Petrified, Stunned, Unconscious
reminderPreset(effects, test: D20Test, ctx?: { magicResistance?: boolean }): RollPreset   // a save against a spell is the test's own `spell` (doc 1 6.1)
presetFor(view, creature, test, ctx?): RollPreset     // client/features/dice/presets.ts: the creature's effects and Magic Resistance
```

- **One rule, every path.** `D20Test` is doc 1 6's, with its kinds for saves, checks, attacks, initiative, death saves, concentration saves and save-ends saves. Each rule's `applies` takes a `D20Test`. Every d20 roll in the app calls `presetFor`: the option buttons, doc 4's card and live card (with the request's `spell`, 5.7), the group save's rows, the save-ends and concentration cards, death saves, and initiative, single, from the tracker and auto. A table test lists every path and checks each calls it.
- **Sources, not a mode.** A preset returns the advantage and disadvantage sources it found, as doc 1's `AdvantageSource`s. The roll combines them with the panel's choices, a mode word in the field and the roller's own toggles once, at the roll, by doc 1's `resolveAdvantage` (doc 1 3.3): any advantage with any disadvantage is a normal roll, however many of each.
- **The rules** are Appendix C's table, each with the SRD quote it rests on. A rule presets only where it holds without a judgment the app cannot make. One predicate, `incapacitated`, decides every rule that ends with Incapacitated, in presets and defenses alike (3.3): Rage's advantage and resistance, Evasion, and Dodging, which also ends while Grappled or Restrained (Speed 0). The rules that need sight, hearing, a source of fear or the hex's ability remind only.
- **`fails`**: Paralyzed, Petrified, Stunned or Unconscious on a Strength or Dexterity save. The roll's result is Fail whatever the total, and the DM may override. A request's rolled answer records Fail with its total on the server, which reads this table (doc 4 7.1). A free roll shows its total with "Fails: Stunned".
- **Initiative** adds the tracker's hint (`rollReminder`, the row's DM mark first) to Poisoned and Exhaustion, and auto initiative's share key gains the extra beside the mode (`autoRoll.ts:171-174`), so every shared total is still its own d20 plus its own numbers.

### 3.3 Defenses (`shared/dice/defenses.ts`)

```ts
type Defense = { kind: 'immune' | 'resist' | 'vulnerable', of: DamageType | 'all' | ConditionKey,
  qualifier?: string,        // "from nonmagical attacks", "except from its vampire master", as printed
  source: string }           // "Stat block", "Petrified", "Raging"
blockDefenses(view)          // the Immunities, Resistances and Vulnerabilities lines, qualifiers kept
effectDefenses(effects)      // Petrified: resists all damage, immune to Poisoned. Raging, unless incapacitated: resists Bludgeoning, Piercing and Slashing
```

- `blockDefenses` is a rules reader of its own. `monsterFacts` keeps its filter meaning and is not called. It splits each line at ";" into clauses, then each clause's types at "," and "and". The words a clause goes on with past its types ("from", "except", "that", "while", "in", "when", a bracket) are its qualifier, given to every type in it, so 2014's "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks" is three qualified resistances.
- A character's come from doc 2's `pcDefenses`, unqualified. Rage and Petrified come from the effects the app already stores, each with its SRD quote checked against `rules-text.json` as the reminders are.
- **Applied**: an unqualified defense applies on its own. A qualified one shows on its row as a switch, off, with its words ("Resists slashing from nonmagical attacks"), for the DM to judge.
- **Evasion**: a trait named "Evasion" in the block, or doc 2's block where it names it (section 8). On a Dexterity save that halves damage, the creature takes none on a pass and half on a fail, named on the row, never while `incapacitated` (3.2), as doc 2 says. So a Stunned assassin fails the save and takes it all. Every row has an Evasion switch for a creature the app does not know has it.

### 3.4 One creature's rolls

```ts
type CreatureRolls = { numbers: RollNumbers | null, initBonus: number, named: NamedRoll[],
  defenses: Defense[], magicResistance: boolean, evasion: boolean,
  legendaryLeft: number }     // the token's resistMax - resistUsed. A critical range is each attack's own NamedRoll.critOn (doc 1 6.2)
creatureRolls(view, creature)  // client/features/dice/creature.ts, null while a chunk loads
```

The block read is the one `tokenStatBlock` links and `statBlockShown` lets this viewer read, so a player never reads a block the token panel would not show them. An SRD block needs the monsters chunk, and its numbers doc 1's `SrdRolls` (`shared/srd/rolls.json`, generated here, section 12), each loading under the shared indicator with the existing `SrdLoadFailed` retry.

## 4. Roll options in the Dice panel

### 4.1 Whose options

`RollOptions` (doc 1 8.4) renders between the roller and Recent rolls:

- **The DM**: the selected token (`selectedIds`, `client/state/selection.ts`). None: "Select a token to roll for it." Two or more: 4.4.
- **A player**: chips naming each character they own and each companion of those characters on the scene, and the options of the one picked. It starts on the selected token when it is theirs, else their character, and stays picked for the page. Other creatures are never offered, since the server refuses them (doc 1 4.3).
- **The token action bars' Roll** opens the Dice panel on that token or group and scrolls it to the options, as a selection change does while the panel shows (4.5).

### 4.2 One creature's list

Each button is 44 px and rolls at once through `useDicePanel().roll`, with `presetFor`'s sources and the choices doc 1's `take()` consumes at the tap. It shows busy until its line lands, and its row then shows the newest result in place, one line under it: "17, Natural 20. Critical damage next." Doc 1 owns the panel's sticky last result. In this order, except that while the creature is dying its Death save leads, as the one roll it makes (build round 1, W7B-P-19):

1. **Saves**: six in a 3-column grid, "Dex +2", the preset on a small second line ("Dis: Restrained", "Fails: Stunned", "+1d4: Blessed"). **Checks**: six in the same grid, then Skills, folded, each "Stealth +6".
2. **Initiative** "+2". In a fight it reads "Initiative +2, sets its row". While the room uses initiative scores (`shared/rules/initiative.ts:119-122`), a monster's reads "Score 12, sets its row", which sets the score without a roll, and "Roll instead" beside it says it replaces the score.
3. **Death save**, while the creature is dying, first of all.
4. **Actions**, under the heading of the block's section each comes from: Traits, Actions, Bonus actions, Reactions and Legendary actions, each shown only when it holds a roll (build round 1, W7B-P-14). Under Actions the Multiattack note first, then one row per named roll: its name with uses, recharge and "Used" (6.4), then Attack "+4", Damage "1d6+2" with each optional part as a toggle beside it ("+1d4 if it had Advantage", doc 2's riders such as "+3d6 Sneak Attack") and, for a roll with an attack, a Critical toggle (only an attack roll scores a Critical Hit, so Fire Breath has none, W7B-P-13), Heal "3d6", a plain roll "1d8" under the roll's name, a Slot level stepper for a spell `pcSlots` scales, Recharge "1d6", and for a save action "Group save, DC 21 Dex" (5.6). One Damage tap rolls the parts and every toggled rider in one line, so a damage is never split across lines.
5. **Spells**: the spell attack and DC from `RollNumbers`, then doc 2's spells as rows like actions.

Labels name the roll, never the creature (doc 1 5.5): "Dexterity save", "Stealth check", "Initiative", "Death save", "Scimitar", "Scimitar damage", "Fire Breath recharge", "Cure Wounds healing", a long name cut to fit 60 characters. A damage line holds one roll per damage type, labelled "Rend damage, fire".

**A creature a player plays, for the DM**: the list starts with "Ask Bree to roll", on, as players roll their own (16). While on, a save or check tap opens doc 4's sheet with that test (`openAsk` with a fill, doc 4 4.8). Off, it rolls on the server. Attacks, damage and the rest always roll.

A creature with no numbers lists Initiative alone, with "No stat block. Roll from the field above.", and for a character "Add a stat block" (`openPcStats`, doc 2). A preview as a player, or no connection, disables every button with doc 1's words (doc 1 4.5). The stat block views stay text this wave (the project owner's decision, 16).

### 4.3 What a result does

- **A request's answer.** A save or check that an open request asks this creature and it has not answered sends `roll.dice` for that request (doc 1 7) instead of a free roll, for the player, and for the DM with `unanswered` whatever the Ask switch says, so no second request goes. Under a `fails` preset the server records Fail with the total (doc 4 7.1). The button reads "Dex +2, answers the DM's request".
- **Initiative** in a fight: once the line lands, the device sets the total as a typed value goes, `encounter.setValue` for a player's own row and `encounter.setValues` for the DM, only while the row still holds the value it had at the tap. Otherwise the result stays on the row and reads "Not set: the row changed meanwhile." The write is the room's, a listener on its receipts that keeps the row and value from the tap (`watchInitiative`), so closing the panel or picking another creature before the line lands loses nothing (build round 1, ASTRA-08).
- **Death save**: `actor.deathRoll` (section 8), which the server rolls and counts in the same op from the state then: 10 or more a success, below a failure, a natural 1 two failures, and a natural 20 regains 1 HP. A creature no longer dying then gets the line and no change. No follow-up write can overwrite newer counts or HP.
- **Critical hit**: each attack roll carries its `NamedRoll.critOn` (doc 1's `DiceRollInput.critOn`, 20 without), and one whose kept d20 face reaches it presses that row's Critical toggle for its next Damage tap (`doubleDice`, riders included). A natural 1 reads "Natural 1: a miss". The Critical toggle by hand covers what the app cannot see, such as a hit within 5 feet on a Paralyzed creature.
- **Recharge**: "Recharged (5)" or "Not yet (3)" against its number, which clears or keeps "Used" (6.4).
- **Damage and healing go to an HP entry.** Every HP entry offers, under that mode, the newest damage or healing line from this viewer and the newest from anyone else in the viewer's log, as chips: "Use 9 (Bree's Longsword damage)", "Use 19 (Rapier damage and Sneak Attack)". A chip sums every damage roll of its line, and a plain roll (`dice`) is never one. A critical damage line on a creature at 0 HP also ticks the entry's critical hit. Players get the chips where they may apply damage. A tap fills the field, and Apply sends it as any typed amount (`HpEntry`, `client/features/tokens/HpSection.tsx:40-93`). A chip goes once this device applies it.

### 4.4 Several selected

For two or more creatures selected, the DM's section reads "6 selected" and their names, then:

- **DC**, optional, 1 to 50.
- **Saves**: six, "Dex save for 6". A tap starts a group save at once (5.1) with the choices `take()` consumes at the tap as its starting switches, and opens its page with the results coming in.
- **Checks**: six, then Skills, folded, the same way.
- **Initiative for the 4 in the fight**, by the tracker's auto initiative mode (section 7).
- **Shared attacks**: a named roll with an attack that every selected block has by name, "Scimitar for 6", each with its own bonus and damage. Its page takes an optional "Target's AC", sent as doc 1's AC field, never as `dc`, so the line reads hit or miss. Each roll carries its own `critOn`, and doc 1's `hitOf` judges hit, miss and critical. "Roll damage for 4 hits" rolls each hit's damage, crits doubled, batched by doc 1's splitter, and their total is the HP chip "Use 23 (4 Scimitar hits)". It has no Apply, since one target takes the hits.
- **Set up a group save**: the same page in its setup state (5.1).

Players get no group section. A player who multi-selects their own creatures gets the last one's options.

### 4.5 Rolls where players already act

- **The tracker row's value box** (`Row.tsx:489`) gains "Roll +2" for the row's owner and for the DM on rows the DM runs, the same roll and guarded set as 4.3, while the row has no value. A set row's Roll waits in its options under "Roll again, replaces 17", so one stray tap mid-fight never rerolls it and reorders the fight (build round 1, W7B-P-6). The Dice panel's Initiative on a set row reads "Initiative +2, replaces 17".
- **The death save row** (`HpSection.tsx:274-275`) gains Roll for whoever may change its counts, sending `actor.deathRoll`.
- **The bars**: Roll on the DM's and owners' bars opens the Dice panel (section 8). On a creature a player plays, the DM's single bar keeps Roll, whose Ask is on there, and drops Request a roll (the project owner's decision, 16). The group bar keeps Request a roll.

## 5. The group save

### 5.1 One flow

The group save is a page of the Dice panel (parent "Dice") or of the Areas panel (parent "Areas"), on the DM's device only, in `client/features/dice/groupSave/` (`chain.ts` with the pure `chainStep`, `rows.ts`, `outcome.ts` with today's `damage.ts` folded in, `GroupSave.tsx`). One at a time in a browser tab: starting another while one holds rolls asks "Discard the Dexterity save for 6?" first. The Dice panel's first page shows the open one as a row, "Fireball's save: 2 waiting. Open". Its phases:

1. **Setup**: the test (a save, a check, or "No save: everyone takes it"), the DC, the fill line (5.6), the switches "Hide the monsters' rolls from players" and "Against a spell" (5.7), doc 4's "What players see" line and its fold while any row is Ask (`askSwitches`, doc 4 4.6), the outcome and the rows. The rows follow their source until the roll: the selection, or the area's caught creatures as `useLiveTokens` moves them.
2. **Rolled**: one tap, "Roll 4 saves and ask 2 players", freezes the rows and sends every roll and request at once. The quick taps of 4.4 start here. With No save there is no roll: every row is Fail and Apply works from setup, so a no-save area applies in one tap as today. Presets with no save open that way.
3. **Applying**: the outcome sent, waiting for its answer.
4. **Applied**: "Applied to 5. Undo takes it all back." and Done.

Discard is there in every phase but Applying, armed once anything was rolled. It closes the requests the page opened, if open, and nothing else.

### 5.2 Rows: who rolls how

Each creature is one row, each holder once (`hpTargets`' rule), objects and the dead at the end set to Skip (`damage.ts:71-73`). At most 100 rows, the most one outcome takes: "At most 100 creatures in one group save." The rows' header has All fail and All pass, as today. Each row's way of rolling, shown under its name and changeable in setup, in this order:

- **Fails**: a `fails` preset (3.2), "Fails: Stunned", before Ask and Server, so nobody is asked to roll a save they fail. Not rolled, Fail until overridden.
- **Ask**, the default for a creature a player plays (16), when doc 4's `askTarget` can ask it (on the players' scene). Asked rows go in `roll.ask` requests built by doc 4's `askOp`, with the test, the DC, the note set to the fill's name ("Fireball"), the page's "What players see" switches and the request's `spell` (5.7), 50 targets a request, all under the page. Before anything is sent, the page checks that the room's open requests leave room for all of them, else "Close 2 requests first." Each request is tracked on its own, since another DM's request can take the last place between the check and the send: a request refused leaves its rows unasked, "Not asked: 20 requests are open", with Retry and Type, while the requests and rolls that went stand. An unknown answer is settled by the request's id in the view. Each request gets doc 4's live card like any other.
- **Server**: its bonus is known (`creatureBonus`), and no player plays it, or the DM switched it from Ask. Every server row goes in one `useDicePanel().roll(rolls, { dc, to })` call, `to` from the page's secret switch, batched by doc 1's splitter under one tag. In the open, `dc` goes only while "Players see the DC" is on, a switch the page then shows for its open server rolls as for asks, and the page judges each total against its DC itself. Its sources are the page's starting choices and the row's `presetFor`, and its formula gains the preset's extra.
- **The DM's one tap on an asked row**: once asked, a waiting row offers "Roll +5", which sends `roll.dice` for that target with doc 1's `unanswered`, the same roll as doc 4's live card, so the result lands in the request and an answer that came first stands: "Bree answered before your roll."
- **Type**: no bonus is known, or an ask could not go (another scene, said on the row). The DM types the total in the row, or marks it.

### 5.3 Results

A row's result is the first of:

1. the DM's mark on this page (Fail, Pass or Skip),
2. for an asked row, doc 4's `resultOf(answer, the page's DC)` (doc 4 1.1): the DM's mark on the live card, then a condition's fail on a rolled answer, then a fail without rolling, then the total against the page's DC,
3. for any other row, the `fails` preset, then its total against the page's DC,
4. none.

It is doc 4's one precedence (the DM's mark, then the automatic fail, then the DC), read from the answer's stored provenance, never inferred from its numbers.

The total is the server's roll, the request's newest answer, or the typed one. With no DC, a rolled row needs a mark. A changed DC re-judges the totals at once and never a mark, and asked rows say "Asked against DC 15" when the request's DC differs. Answers come from the requests in the view, so an answer, a reroll after Reopen or a mark on the live card shows here at once. The page copies each answer as it arrives, so a request closed elsewhere leaves its rows as they were, and an unanswered one then needs a mark. A header counts "4 pass, 2 fail, 1 waiting".

### 5.4 The outcome

- **Damage**: one field of parts, "8d6 fire" or "5d6 fire + 5d6 radiant". With dice, Roll rolls every part once on the server in one line under the page's secret switch, labelled "Flame Strike damage, fire" and so on, and Roll again replaces it until Apply. Numbers ("28 fire + 14 radiant", or "28" taking the fill's type) are taken as typed. "Use Bree's 28 (Fireball damage)" appears when the newest damage line in the log labelled with the fill's name is someone else's. A spell's Slot level stepper runs from its level to 9: a PC caster's own spell through `pcSlots`, a preset through its per-slot dice. A preset cantrip's dice follow the caster character's level (5, 11 and 17), and a PC's own comes scaled (doc 2 3.4).
- **On a pass**: Half or None, from the fill, else Half.
- **On a fail, conditions**: the fill's, or "Add a condition", which opens `EffectPicker`, then `DurationFields` with the group's anchors ("each creature's own turn", or any row of the fight, the active one first as `defaultAnchorKey` does) and the switch "A Wisdom save at the end of each of its turns ends it" (section 6). Several conditions may go on, such as Hypnotic Pattern's Charmed and Incapacitated, each with the same end.
- **Per row**: each damage part is halved on a pass or dropped (`dealt`, `damage.ts:76-80`), with Evasion in its place where it applies, then its type's immunity, resistance and vulnerability apply in the SRD's order, each part rounded down on its own, and the parts are summed: "Immune to fire: 9 radiant". The row's amount opens a number field, and a typed amount wins. A condition goes on a failed row unless the creature is immune to it, has it already (as `conditionOps` skips it), or this damage drops it to 0 HP (temporary HP first), each named and overridable.

### 5.5 Apply and undo

Apply is enabled when every row not skipped has a result, no roll is pending, and something would change. Its words say what it does, "Apply: 5 take damage, 3 Frightened", or why it waits: "2 still waiting: mark them or wait", "Type the damage, or roll it", "Rolling…". It freezes a plan from the rows and the view: each creature's amount, its conditions with their ids from `newId`, and each Legendary Resistance used, one entry per creature. The page checks the plan's worst case (every row failing, every condition chosen) against `actor.outcome`'s bounds whenever its rows or outcome change, before any roll, so Apply never meets a plan its op refuses: "Too much for one step: remove a condition or split the group." Then it sends:

1. `roll.close` of the page's open requests, alone, so it is never the newest undo step.
2. `actor.outcome` (section 8) with the plan, the plan's id as its `tag` (doc 1 1.2): one op, which the server applies whole or not at all, each hit by `actor.hp`'s rules, each condition as `actor.effects` adds one, each resistance as one more used. One op is one undo step, so one undo takes it all back, concentration prompts follow as today, and nothing is half applied.

- **Taken**: Applied, and a toast: "Fireball: 5 took damage, 3 are Frightened. Undo takes it all back."
- **Refused**: nothing applied. Its reason on the page, the rows as they were, and Apply builds a new plan.
- **Unknown**: `useReceipt` asks doc 1's receipt for the plan's tag (doc 1 1.2). Committed is Applied, refused is Refused. Still unknown, the page reads doc 1's "This may have happened. Check the log.", and only the DM's "Apply again" resends the same frozen plan under the same tag, offered within doc 1's 12 hours. The server answers a duplicate tag from its receipt for 24 hours, so the plan applies at most once, and nothing is ever recomputed against a change it made.

### 5.6 Fills: an area, an action, a caster

The page's fields start from the first source that knows each one (the order is Appendix C's second table), and the DM may change any. The fill line says where they came from: "From Fireball: Dexterity save, DC 15 (Bree's spell save DC), 8d6 fire, half on a pass."

- **An area**: its Damage button (`AreasPanel.tsx:103`, `AreaOptions.tsx:549`) becomes "Save and damage" and opens this page with the area as the source, filled from the preset whose name it keeps. An area whose caster has save actions lists them too: "Fill from Fire Breath".
- **A save action** (4.2): "Group save, DC 21 Dex" opens setup with the action's fill and the selection, less the acting creature, as the source. With nobody else selected it reads "Select the creatures it hits, or place an area from it."
- `AreaSpell` (`shared/srd/area-spells.ts:14-63`) gains `save?: AbilityKey`, `onPass?: 'half' | 'none'`, `damage?: { formula, type, perSlot? }[]`, `cantrip?: true`, `conditions?: ConditionKey[]`, `lasts?` and `saveEnds?: true`, from scripts/srd-import.ts's hand-reviewed table, each checked against the spell's text by the patterns as the presets' shapes are (`scripts/srd-import.ts:28-34`).

### 5.7 Legendary and Magic Resistance

- **Legendary Resistance**: a failed save's row of a creature with uses left offers "Use Legendary Resistance (2 left)", off by default. On, the row passes, reads "Succeeds: Legendary Resistance", and the outcome spends the use.
- **Magic Resistance**: "Against a spell" starts on when the source is an area with a spell or the fill is a spell. On, every row with Magic Resistance rolls with advantage (3.2). Asked rows keep the context: `askOp` gets `spell` and each request carries it (doc 4 7.5), and doc 4's card and live card pass it to `presetFor`, so a creature rolls the same through Ask, the player's Roll, the DM's waiting Roll and Server.

### 5.8 Phone layout

At 375 x 667 the sheet's body shows about 344 px at 100% and about 248 at 130% (Appendix D). In setup the outcome sits above the rows. Once rolled the rows come first, under the header's count, the outcome folds to one line ("8d6 fire, half on a pass. Edit"), and Apply sits in the page's foot, so the count, the first row and Apply show with no scroll at 130%, and the rows scroll between them. A row's name and amount share its first line. Its Fail, Pass and Skip control shares that line where the line holds all three, as on a 360 px side panel (`AreaDamage.tsx:140`), and otherwise takes a line of its own under them, as at 375 px wide at 130% (about 256 layout px). Its details wrap under the name: its total and dice ("normal: advantage and disadvantage cancelled" when the result says `cancelled`), its preset in words, and what the outcome does to it. The e2e takes a shot of the options and of this page at 375 x 667 at 130%.

### 5.9 What players see

- **Their creature asked**: doc 4's card, "Dexterity save, DC 15" as the switches allow, with Roll and the typed total.
- **The monsters' rolls**: hidden by default, so "Mara rolled in secret." once, and only when a rolled creature passes doc 1's rule (5.2). With the switch off, the totals on creatures they can see, and the DC only with "Players see the DC" on.
- **The damage roll**: as the switch says, a secret line or "Mara rolled Fireball damage: …".
- **The outcome**: the HP and condition lines of creatures they can see, under each creature's HP visibility. Their card closes when Apply closes the request. Never the results list, a monster's DC unless shown, the overrides, or who resisted.

### 5.10 Keeping it

The page lives on the DM's device, never in the room's state: the server holds every roll, request and outcome. It keeps a draft in session storage, `rvtt.groupSave.<roomId>`, inside try and catch: the phase, source, test, DC, switches, rows, each result as it lands, the copied answers, the marks and amounts, the outcome, the tags, the requests' ids, the frozen plan, and when it first rolled. A reload restores it and drops rows whose creature is gone.

- **An unknown is settled by receipt, never guessed.** A row with no result and no line of its tag in the view, or an Applying page, reads "Checking…" while `useReceipt(tag)` asks doc 1's lookup (`GET /api/rooms/:roomId/receipts/:tag`, doc 1 1.2, 8.7), which answers each batch's `part`. Committed fills the batch's rows from its lines. Refused reads "Not rolled" with Roll them for those rows. A part with no receipt is unknown: its rows read "This may have happened. Check the log." and offer Type and the marks, and Roll again only as the DM's explicit act under a new tag. Nothing rolls or applies again on its own. The plan follows 5.5.
- **Its scene**: while the DM views another scene, the page reads "This group save is on Cellar. Go back to it to apply.", its rows stay, and Roll and Apply wait, since the DM's view holds one scene's tokens.
- Another DM device sees the requests on doc 4's live cards and the lines, and has no page of its own.

## 6. Saves after the fact

### 6.1 Save ends

- **Model**: `Effect` (`shared/model.ts:940-962`) gains `save?: { ability: AbilityKey, dc: number, spell?: true }`: a save at the end of each of the creature's own turns ends it, `spell` when it is against a spell. `effectInput`, `effectStored`, `actor.effect.update`'s patch (`protocol.ts:186-198`, `:1000-1013`) and the import schema take it. Only the DM sets it: a player's op naming `save` is `forbidden`. It rides the wave's one version bump, `OP_VERSION` 7 and `SNAPSHOT_VERSION` 11 (doc 4 7.5).
- **Picker**: the single creature's effect form (`EffectDetail`, `EffectsSection.tsx:237`) gains the same switch as 5.4, with an ability, a DC and "against a spell", for the DM.
- **Projection**: players keep `save.ability` and lose `save.dc` (`publicEffects`, `shared/project.ts:450-458`), owners included. The effect reads "Frightened. A Wisdom save at the end of each of its turns ends it."
- **Each save is an occurrence.** `encounter.next`, where it ticks durations (`encounter.ts:301-308`), writes one `saveEnds` line for each effect with `save` on each creature the ended row stands for (`entryMatchesAnchor`, `shared/rules/durations.ts:43-54`), the row whose turn ended only, not a skipped one, and not an effect expiring in the same step: `{ type: 'saveEnds', tokenId? | characterId?, effectId, key, ability, dc }`, DM only, remapped on import as other creature lines: "Goblin 2 ended its turn Frightened: a DC 15 Wisdom save ends it." In the same step the effect gains `due: { id, state: 'pending' }`, `id` that line's id, which names the creature, the effect and the turn end: the occurrence that doc 4's `ends.occurrence` names (doc 4 1.1). A new turn end replaces the old occurrence and, in the same op, closes the request linked to it. `due` is the DM's in every projection. No stored effect has `save`, so replay is unchanged.
- **Its state is the server's.** `due.state` is `pending`, `resolved` or `dismissed`. Doc 4 allows one open request per occurrence ("That save was already asked."), and `roll.ask` with `ends` is also refused unless the occurrence is pending, so two DM devices never ask twice and a settled save is never asked. An occurrence with a linked request is settled only by closing that request: doc 4's close rule (doc 4 1.1) makes `roll.close { rollIds, settle? }` on a request with `ends` settle its occurrence in the same op, as `settle` when the op names one (Accept failure sends `resolved`, Dismiss `dismissed`), else `resolved` when the target has an answer and `dismissed` when it has none, and never an occurrence other than the one `ends.occurrence` names while it is pending. So the live card's Close and Close all answered settle it as the save-ends card does, and no close leaves it pending. The DM's new `actor.saveDue { target, effectId, due, state: 'resolved' | 'dismissed' }` settles only an occurrence with no request, refused when `due` is not the effect's pending occurrence or a request is linked. A pass ends the effect and its occurrence with it.
- **The card**: one per pending occurrence in the DM's fight alerts (while its linked request's target holds a pending change ask, the card shows it with Allow and Keep, as doc 4's live card does, doc 4 1.1), rebuilt from the effects on load, so a reload brings back only the unsettled ones: "Goblin 2 ended its turn Frightened. Wisdom save, DC 15, ends it." It has Roll "+1" (from `presetFor`, the effect's `spell` and doc 4's Adv and Dis chips, doc 4 5.2), Passed and Failed. A `fails` preset marks it Failed. Passed, or a roll that passes, ends the effect (`actor.effect.remove`), which undo takes back. Failed, or a roll that fails, with no choice left (no Legendary Resistance uses, no request) settles the occurrence `resolved` on that tap or as the roll lands, as Failed did before. Where a choice is left, the card shows the fail with Accept failure and, for a creature with uses left, Use Legendary Resistance: one `actor.outcome` that spends the use and removes the effect, since a fail turned to a success is a pass. Dismiss is there until then. Without a request, Accept failure and Dismiss send `actor.saveDue`. With one, each is doc 4's one `roll.close`, which settles the occurrence by the rule above, and a pending change ask is settled as Keep first (doc 4 6).
- **A player's creature** (16): the card's first button is Ask Bree, one `roll.ask` through `askOp` with `ends: { effect, occurrence }` naming the effect and its pending occurrence, doc 4's public `cause: 'saveEnds'` (doc 4 1.1), `spell` from the effect, and its switches set explicitly: `dcShown` off unless the DM shows the DC on the card, `resultShown` on (the project owner's decisions, 16). Off the players' scene, where no request can go, it offers Roll when the bonus is known. Once asked, a waiting "Roll +1" sends `roll.dice` with `unanswered`.
- **The linked request's life** (doc 4 7.5 states it, the coordinator's decision of round 2): a pass, typed, rolled or allowed after a change, removes the effect in its own op and closes the request. A fail leaves the request open and final under the usual rules, so a typed total can still be corrected and a rolled one asked to change, such as Heroic Inspiration on a failed Hold Person save. A DM's Fail mark leaves it open too. It closes when the effect goes another way, when the DM closes it (Accept failure, Dismiss, or the live card's Close and Close all answered, each one `roll.close` that settles the occurrence), or when the creature's next turn end starts a new occurrence. A pass removes the effect at most once.

### 6.2 Concentration

The concentration card gains Roll "+2" beside Passed and Failed, for whoever answers it today (`answersPrompt`, `logic.ts:577-581`), with `presetFor` on a concentration save and doc 4's Adv and Dis chips, so Bless, Bane and Exhaustion count, and a feature such as War Caster takes the Adv chip. With the DC on the card, a pass dismisses it and a fail ends concentration as Failed does (`InitiativeStrip.tsx:1152-1157`), except for a creature with Legendary Resistance uses left: its failed roll waits on Use Legendary Resistance (an `actor.outcome` that only spends the use, concentration kept) or Accept failure, and nothing ends before the DM picks. Without the DC, a player who may not see the exact HP, the total shows and Passed or Failed decide.

### 6.3 How the cards roll

Cards roll with `useDicePanel().roll(rolls, { to })`, which works with the Dice panel closed since its choices live in doc 1's room-wide `diceChoicesSlot`: the DM's to the DM, a player's in the open, and the panel's choices neither applied nor consumed. Each card shows busy, then its result in place, reads its own line by tag, and acts once on it. A card's line in the open never carries a DC its players may not see (build round 1, W7-SOL-01): a save-ends DC is the DM's alone, and a concentration DC tells the damage to whoever lacks the creature's exact HP, so the line goes without `dc` and the card compares the total with its own DC (`dcOnLine`, `shared/dice/secret.ts`). A secret line keeps it, for the DMs and its roller.

### 6.4 Recharge

Tapping an action's Damage or Group save, or Apply on a group save filled from it (an area's "Fill from Fire Breath" included), marks it "Used" on this device (per token and action, in session storage), and its row's "Used" toggles it by hand. At the start of that monster's turn, the DM's fight alerts show "Fire Breath can recharge (5–6). Roll", which rolls 1d6 and clears Used on a success. The card shares the Dice panel's recharge row but reads only a roll of it sent since that turn's line, so a failed roll of an earlier turn leaves the next turn's card offering Roll (build round 1, ASTRA-06). An action never marked Used is never prompted.

## 7. Auto initiative on the server

The tracker's auto initiative keeps its modes, groups, joins and card (`autoRoll.ts:129-257`). Only the draw moves: `rollGroups` (`:272-282`) becomes `initiativeRolls(groups)`, one `DiceRollInput` per shared roll (`d20Formula(modifier)` with the preset's extra, the group's sources, label "Initiative" or "Initiative, shared by 4", the first row's token as its creature so a hidden group leaves players no trace), sent with `{ to: 'dm' }`. When the tag's lines land, `valuesFrom(groups, results)` gives each row its group's total, clamped as today, and `rollOps` sends the changed values as now. The card describes the rolled faces from the line. `rollD20`, `rollWith` and the device's random source go. So does the file's `Advantage`, for doc 1's `AdvantageMode`, and its own `RollMode` (creature, each, all) keeps its name beside `AdvantageMode`, as doc 1 10 states. Offline, the buttons are disabled with doc 1's words. A refused batch sets nothing and the card says why.

## 8. Contracts this doc reads, and what it changes in other designs

- **docs/design-v1-dice.md (doc 1)**, read, not restated: in 3.3 `AdvantageSource` and `resolveAdvantage`, in 4.1 the AC field for attacks, in 6 `D20Test` with its kinds, `NamedRoll`, `DamagePart`, `DAMAGE_TYPES`, `RollNumbers` with the spell numbers, the critical range and `SrdRolls` (generated here, section 12), in 1.2 the receipts that settle every op that rolls or applies by its `tag` and `part` (committed, refused or unknown), `actor.outcome`'s plan id as its tag with the 24-hour duplicate rule, the lookup and `useReceipt(tag)` (8.7), in 5.1 a result's `cancelled`, in 7 `roll.dice` with `unanswered`, and in 8.4 `diceChoicesSlot`, `take()` consumed at the tap, `roll(rolls, { dc?, to? })` and the splitter, and in 8.2 the sticky last result. **Added to doc 1 4**: `actor.deathRoll { tag, target, mode?, extra? }`, resolved by doc 1's pipeline into `sys.dice` like `roll.dice` and permitted as `actor.deathSave`. Its reducer writes the roll's line and applies the death save by today's rules from the state then (4.3). This doc decides doc 1 16's open item: auto initiative moves to the server (section 7).
- **docs/design-v1-pc-stats.md (doc 2)**, read: `pcNamedRolls`, `pcSlots`, `pcRollNumbers`, `pcDefenses`, `openPcStats`, riders as optional parts, and the critical range. Doc 2's paste reader calls `blockActions` (doc 2 6.2). **Asked of doc 2**: its block may name Evasion (3.3).
- **docs/design-v1-roll-request.md (doc 4)**, read: `askOp` with every caller's own switches and `spell`, `askSwitches` as the sheet's default, `askTarget` and `openAsk` with a fill (doc 4 4.6, 4.8, 7.3), `RollRequest.spell` (doc 4 7.5), the card's Adv and Dis chips (doc 4 5.2), the server's `fails` on a rolled save (doc 4 7.1), and the live card. Doc 4's card and live card call `presetFor` (doc 4 5.3, 6). Doc 4's answer provenance (an answer's source: typed, rolled or the DM's mark) and its one precedence are read in 5.3. Doc 4 owns the sheet, the card and the live card, this doc the results list.
- **The request model** (docs/design-v1-dm-tools.md 3.3, `shared/model.ts:1220-1240`): doc 4 7.5 states `spell`, the public `cause: 'saveEnds'`, the DM's `ends` and the linked request's life (6.1). This doc adds `Effect.due`, whose id is `ends.occurrence`, and `actor.saveDue` (6.1), and `roll.ask` with `ends` also checks that the occurrence is pending. Results read doc 4's `resultOf` (5.3).
- **New op `actor.outcome { plan: id, targets: { target, amount?, effects?: EffectInput[], remove?: EffectId[], resist?: true }[] }`**, the DM's: 1 to 100 targets, each holder once, at most 3 effects and 3 removals each, and at most `LIMITS.outcomeOpBytes` (56 KiB) serialized, so 100 creatures with two conditions each fit the 64 KiB frame (Appendix A). Each amount applies by `actor.hp`'s rules, each effect as `actor.effects` adds it, each removal as `actor.effect.remove`, each `resist` as one more Legendary Resistance used (refused when none is left). Whole or nothing, one undo step, labelled "applying Fireball to 7" (`server/rooms/undoLabels.ts`), with doc 1's receipt by its plan id. `actor.damageMany` stays for replay and gains no new caller.
- **docs/design-v1-dm-tools.md 3.5** and **docs/design-v1-token-window.md**: the group bar gains Roll after Multi-select (`client/canvas/TokenActionBar.tsx:513-516`). The single bar's `play` row gains `roll` after `multiSelect` for the DM and owners, and for the DM on a creature a player plays it replaces `requestRoll` (`client/canvas/barButtons.ts:60-66`). The rows' fit rules are unchanged.
- **docs/design.md**: 9.3 and features 9, the area's Damage page becomes the group save (5.6). 9.4, auto initiative draws on the server. 9.5, save ends (6.1). 7.3, the `saveEnds` line, `ends`, `due` and `save.dc` are the DM's, and `cause` goes with the request.
- **docs/design-v1-companion-stat-blocks.md**: a companion's block gives its named rolls through `blockActions`. **Area presets**: `AreaSpell` gains 5.6's fields.

## 9. Edge cases

| Case | Outcome |
| --- | --- |
| A hand-made token, no block | Initiative only. In a group: Type, or Ask for a player's creature |
| SRD chunk fails to load | the shared retry. Group rows wait as "Loading", then Type |
| A character with no stat block yet | Initiative only, and Add a stat block. The DM's group asks it |
| A 2014 room monster, "Melee Weapon Attack: +4 to hit" | an attack of +4 |
| "Half damage only.", "Recharge 4–6", "Hit or Miss" | half on a pass, recharge 4, damage as a hit |
| Engulf: 3d6 now and 3d6 at the start of later turns | the first in the outcome, the second its own roll |
| Adult Bronze Dragon's breath: 3d6 Thunder and Deafened "until the end of its next turn" | the damage stays immediate, `lasts` on the target's turn |
| Paralyzed "until the start of the dragon's next turn" | anchored on the dragon's turn |
| Flame Strike on a fire elemental | the fire part 0, the radiant part dealt |
| "Slashing from Nonmagical Attacks" | a switch on the row, off, for the DM to judge |
| Petrified in a Fireball | fails the save, resists all: half of the full damage |
| Dodging and Restrained, a Dex save | disadvantage. Dodging is dropped at Speed 0 |
| Raging and Stunned, a Str save | fails. Raging's advantage is dropped |
| Raging and Stunned, hit for bludgeoning | full damage: no Rage resistance while incapacitated |
| A Stunned assassin with Evasion in a Fireball | fails the save, takes all of it |
| A Poisoned goblin's Scimitar, a Blessed caster's concentration | disadvantage, and +1d4 |
| A Stunned creature answering a Dex save request | rolled, recorded Fail with its total, the DM may override |
| The DM taps a save on a player's creature | Ask on: doc 4's sheet. An open request: `roll.dice` with `unanswered` |
| A death save while someone heals the creature | the server counts it from the state then: no change if no longer dying |
| Initiative lands after the player typed one | not set: "the row changed meanwhile" |
| Rapier, then Sneak Attack toggled on the same tap | one line, one chip, both doubled on a critical |
| Bree's Longsword damage, on the DM's HP entry | "Use 9 (Bree's Longsword damage)" |
| A room using initiative scores | "Score 12, sets its row". Roll instead says it replaces the score |
| 101 creatures, or asks past the open requests' room | refused before rolling, with what to do |
| 60 players' creatures | two requests under one page |
| Another DM's request takes the last open place first | that request's rows read "Not asked", with Retry and Type. The rest stand |
| 100 creatures, two conditions each | one `actor.outcome`, about 50 KB |
| A third condition on 100 creatures | refused when it is added, before any roll |
| A batch refused (budget) | its rows "Not rolled: you are rolling too fast", Roll them for those rows |
| A roll's answer lost and its line gone from the in-memory log | "Checking…" until doc 1's receipt settles it. Unknown: "This may have happened", Type, a mark, or Roll again by hand under a new tag |
| The DM marks Pass or Fail on the live card | the row follows the mark (5.3 rule 2), through any DC change and over `fails` |
| A creature deleted or walking out mid-flow | after the roll the rows hold. Apply leaves the gone out |
| No save (Spike Growth) | every row Fail, Apply in one tap |
| Apply refused | nothing applied, a new plan next time |
| Apply's answer unknown | the receipt settles it. Still unknown, only the DM's Apply again resends the same plan tag, applied at most once |
| A player answers a save-ends request while the DM reloads | the server ends the effect and closes the request |
| A save-ends effect removed while its request waits | the request closes |
| A failed Hold Person save, then Heroic Inspiration | the request stays open. An allowed reroll that passes ends the effect |
| A mistyped total on a save-ends request | corrected with Send while it is open |
| Reload after the DM accepted a fail | no card: the occurrence is resolved |
| Two DM devices Ask for one occurrence | the second is refused, "That save was already asked." |
| The live card's Close or Close all answered on a save-ends request, then a reload | the close settled the occurrence: no card comes back |
| A monster fails its save-ends roll, no Legendary Resistance | resolved on that tap, no extra Accept |
| Legendary Resistance on a save-ends card | one `actor.outcome`: the use spent, the effect removed, one undo |
| A concentration roll fails, Legendary Resistance left | waits on Use Legendary Resistance or Accept failure |
| Fire Breath placed as an area and applied | the action is marked Used |
| The same effect's next turn end, its request still open | a new occurrence: the old request closes, a new card |
| A Magic Resistance companion through Ask, Roll, the DM's Roll or Server | advantage every way |

## 10. Self-sweep

Swept as classes before reporting:

- **One preset rule on every d20 path**: options, cards, live card, rows, death saves, initiative (single, tracker, auto), each through `presetFor`, sources combined once at the roll. The exceptions the reminders quote are rules, not notes.
- **One damage shape**: a damage is a list of typed parts from the reader through the roll, the save, the defenses, the chip and the plan. Only the amount sent is a sum.
- **No follow-up overwrites newer state**: the death save counts on the server, initiative sets only an unchanged row, a save-ends pass removes its effect by id in the answer's op, Legendary Resistance is spent as one more used, and the outcome is one op from a frozen plan.
- **Settlement, not history**: every op that rolls or applies is settled by doc 1's receipt for its client id. Missing or pruned history is unknown, never refused, and an unknown never rolls or applies again on its own. A request's own answer is settled by the request in the view.
- **One incapacitation predicate**: Rage's advantage and resistance, Evasion and Dodging end through `incapacitated`, in presets and defenses alike.
- **Answers carry their source**: the results list reads doc 4's provenance, so a mark is never inferred from numbers or undone by a DC change.
- **One save, one occurrence**: each save-ends turn end is one stored occurrence with one linked request, settled on the server, rebuilt only while pending. Every close of its request settles it in the same op, so no path leaves a closed request beside a pending occurrence.
- **Sizes the op can carry**: the page's whole contract (100 creatures, up to 3 conditions each) is checked against `actor.outcome`'s bounds before any roll, and the request cap is tracked per request.
- **Context travels with the roll**: the spell flag rides on requests and effects, so every surface rolls a creature the same.
- **One path**: the area page, group HP and group conditions reuse `dealt`, `parseDamage`, the holder rule, `conditionOps`' skip rule, `EffectPicker` and `DurationFields`, and the area's no-save case and quick marks stay.
- **Secrecy, permissions, bounds, undo, the DM's one-scene view, determinism**: swept again, with `ends`, `due` and `save.dc` the DM's, `spell` and `cause` the creature's players' too, `actor.outcome` and `actor.saveDue` the DM's, and `saveEnds`, `due` and `ends` reading only fields no stored op wrote.

## 11. Tests

- **Unit** (`node:test`): `named.test.ts` over all 330 SRD blocks (every "Attack Roll:" an attack, every save a save, every Success clause beginning "Half damage" `half`, every "(Recharge n–6)" n, the later-turn damage split off, and the 43 Hit or Failure paragraphs whose first sentence also holds "until" or "for 1 minute", the dragon breaths among them, keeping their first damage immediate, with `lasts` naming whose turn) and hand-written 2014 fixtures (weapon and spell attacks, "DC 13 Dexterity saving throw", "half as much damage"). `defenses.test.ts`: qualifiers kept, the 2014 clause split into three, Petrified, Rage, Evasion, and `incapacitated` on Incapacitated, Stunned, Paralyzed, Unconscious and Petrified (Raging and Stunned taking full bludgeoning, a Stunned assassin taking a whole Fireball). `rollReminders.test.ts`: every row of Appendix C per `D20Test` kind, the exceptions, three and more sources in every order. `presets.test.ts`: the table of every d20 path. `creature.test.ts`: each source and the viewer's block rule. `groupSave/rows.test.ts` and `outcome.test.ts`: the ways of rolling, 5.3's order with live-card marks, damage parts and defenses per part, Evasion, Legendary Resistance, the drop to 0, the plan. `options.test.ts`: routing, the Ask switch, guarded initiative, the score, the critical range, riders in one line, the chips. Reducer: `actor.outcome` whole or nothing, its undo, its bounds (100 targets with two conditions each accepted, a plan over the bytes refused) and its plan id, `actor.deathRoll` against later state, `saveEnds` lines with `due`, `actor.saveDue` against a stale occurrence or a linked request, `roll.close` settling a linked occurrence from each close path (the save-ends card, Close, Close all answered) and never a newer one, and `roll.ask` with `ends` refused once linked. `autoRoll.test.ts`: groups and joins with extras. `area-spells.test.ts`: every preset damage part parses.
- **Randomized** (`client/features/dice/groupSave/chain.random.test.ts`): `chainStep` over 2,000 seeded sequences of rolls, batches landing or refused in any order, answers, reopens, live-card marks, the DM's waiting Roll landing or refused, requests closed elsewhere, creatures deleted, the DC changed, marks and amounts, Apply, its answer taken, refused or unknown, receipts committed, refused or unknown for a tag or a plan, a request refused at the cap after the check while another went, discard, and a reload with the in-memory log trimmed. The invariants:
  1. The outcome commits at most once.
  2. After discard nothing is sent but one `roll.close` per open request.
  3. No creature is rolled twice by the server, except a refused row, or an unknown one the DM rolls again by hand.
  4. Nothing rolls or applies again on its own while a receipt is pending or unknown.
  5. A row's result always follows 5.3's order over the newest events.
  6. A resent plan is the frozen plan, never a rebuilt one.
  7. Apply's plan names each holder once, only creatures still present, never a skipped row.
  8. A reload shows the same rows and results.
  9. A request refused at the cap leaves exactly its rows unasked, and every request and roll that went stands.
- **Randomized, save ends** (`shared/reducer/saveEnds.random.test.ts`): 2,000 seeded sequences of turn ends, asks from two DM devices, typed and rolled answers, changes asked and allowed, effect removals, Accept failure, Dismiss, the live card's Close and Close all answered, a close interrupted by a dropped socket, and reloads. The invariants: one linked request per occurrence, a pass removes the effect at most once, a resolved or dismissed occurrence never comes back, no closed request leaves its occurrence pending, a fail leaves its request open until the next turn end, the effect's removal, Accept or Dismiss, and a reload rebuilds exactly the pending occurrences.
- **Integration**: `dice.itest.ts` gains a group save's batches and requests against the budget, `actor.outcome` and `actor.deathRoll`.
- **e2e**: new `e2e/groupsave.e2e.ts`: three goblins and Bree's token, DC 13, Dex save, Bree's Roll on her card, 5d6 fire + 5d6 radiant, Apply, the players' HP lines, one Ctrl+Z restores all, and the 375 x 667 at 130% shots of the options and the rolled page with Apply in view. A tap on an option scrolled to the foot shows its result in view. Touched: `e2e/dice.e2e.ts`, `e2e/fold.e2e.ts` and `e2e/dmphone.e2e.ts` (the cards' Roll), `e2e/combat.e2e.ts` (auto initiative, the value box's Roll), `e2e/bardock.e2e.ts` (the bars). Run those, the new file and `reach` during the build.

## 12. Build plan

One builder, after doc 1's build, doc 2's model step and doc 4's `askOp` on a test:

1. `feat(dice): named rolls and defenses from stat blocks` (`named.ts`, `defenses.ts`, `shared/srd/rolls.json` and its generator, `creature.ts`, tests). Doc 2's paste reader waits for it.
2. `feat(rules): presets for every d20 roll` (the table, `reminderPreset`, `presetFor`, the path test).
3. `feat(effects): a save at the end of each turn ends an effect` (model with `due`, protocol, `actor.saveDue`, permissions, projection, the reducer's line, the linked request, the effect form, log text, the save-ends randomized test).
4. `feat(dice): the outcome and the death save on the server` (`actor.outcome`, `actor.deathRoll`).
5. `feat(dice): roll options in the dice panel` (`RollOptions`, routing, initiative, death save, critical, recharge, the chips, the value box and death save row, the bars).
6. `feat(dice): group rolls and the group save` (rows, results, outcome, Apply, receipts, session draft, group attacks, the randomized test).
7. `feat(areas): an area's save and damage through the group save` (preset fields, fills, No save, `AreaDamage` and `damage.ts` folded in).
8. `feat(encounter): roll on the save-ends, concentration and recharge cards`.
9. `refactor(encounter): auto initiative rolls on the server`.
10. `test(e2e): group save`.
11. `docs: roll options and the group save in the feature list and the design` (FEATURES.md, docs/design.md per section 8).

## 13. FEATURES.md

- "## Dice" (doc 1's new section) gains:
  - Roll options: the DM taps a token, a player picks a character or companion, and the Dice panel lists its saves, checks, skills, initiative, death saves, attacks with riders and critical hits, save actions, healing and recharge, from its stat block, 2014 text included, each result shown on its row. Conditions such as Restrained, Poisoned or Bless set advantage, disadvantage or a die on every d20 roll. A roll the DM asked for answers the request, initiative goes into the tracker, and the newest damage, a player's included, shows in every HP entry as "Use 9".
  - Several creatures: one save or check for all, initiative, or a shared attack with its hits against an AC and its damage.
  - The group save: monsters rolled at once, players' creatures asked with the DM's roll one tap away, pass or fail against a DC, damage rolled once and kept by type, full or half, conditions on a fail with their end, resistances, immunities, Evasion, Magic and Legendary Resistance on each row, every row changeable, one Apply and one undo.
- "## Areas of effect": the Damage bullet becomes "**Save and damage** (DM): from a placed area, the group save for everyone it catches, filled from the spell and its caster, or No save for damage everyone takes."
- "## Conditions and statuses": "A condition can end on a save at the end of each of its turns. The DM's reminder rolls it, or asks a player, whose passing answer ends it. A failed one stays open for a corrected total or an allowed reroll." The concentration bullet gains "or taps Roll".
- "## Combat and initiative": auto initiative's dice roll on the server and show in Recent rolls. Roll in the initiative box and on the death save row. Recharge prompted at the start of a monster's turn.
- "### Several tokens at once": Roll in the group bar. "## Shortcuts", "### Dice": section 14's row.

## 14. Shortcut sheet

| Key | Does | Who | Sheet section |
| --- | --- | --- | --- |
| Enter | In the group save's damage field: roll the parts, or take the typed numbers | DM | Dice |

No other key or key with pointer is added or changed.

## 15. Decided, for the project owner to overrule

- For one creature a player plays, the DM's save and check taps ask that player, with a switch to roll instead.
- Unqualified defenses apply by default, qualified ones wait for the DM, each named and overridable.
- A creature the damage drops to 0 gets no condition by default.
- Legendary Resistance is offered on a failed save, off by default.
- A pass on a save-ends roll ends the condition at once, and undo brings it back.
- A group attack has no Apply: its total goes through the HP chip.
- The group save lives on the DM's device in session storage, not in the room's state.
- Recharge is prompted only for an action marked Used on the DM's device.
- Auto initiative's dice move to the server.
- From the coordinator's round 2 decisions, logged for the project owner: a save-ends request stays open after a failed save, and closes on a pass, the effect's removal, the DM's Accept failure or Dismiss, or the creature's next turn end. Its `cause: 'saveEnds'` is public and `ends` the DM's. No request asks a concentration save.

## 16. Decided by the project owner (2026-10-17)

1. **"Save ends" for a player's creature**: the DM's reminder card sends that player a roll request, so the DC stays the DM's (6.1). Such a request keeps its DC private unless the DM shows it, with its switches set explicitly.
2. **A group save with players' creatures**: each player gets a roll request by default, and the DM can roll any row on the server with one tap (5.2).
3. **Tap to roll in the stat block**: not this wave. The Dice panel stays the one place to roll, and its options show the Multiattack line (4.2).
4. **The DM's bar for a creature a player plays**: Roll stays and Request a roll goes. Ask is Roll's default there (4.5).

## Appendix A. Sizes

- **`shared/srd/rolls.json`**: 330 entries of six abilities with `mod`, `save` and `check?`, and the listed skills, about 150 bytes each: about 50 KB, about 8 KB compressed. Named rolls and defenses are read from the monsters chunk the block view already loads (85 KB compressed).
- **Named rolls in the SRD**: attacks in about 423 paragraphs, saves in 199, recharge in 86 (67 "5–6", 14 "6", 5 "4–6"), Magic Resistance in 35 blocks, 62 "Success: Half damage." and 13 other "Half damage" openings, 14 "repeats the save at the end of each of its turns", 59 "until the end (or start) of its next turn", 4 "Hit or Miss", 9 "First Failure" and 12 "Second Failure" clauses. About 40 KB as compact JSON, read per block and cached.
- **A group save of 50 monsters with Flame Strike**: three `dice.roll` ops of saves (20, 20, 10), one damage line of two rolls, one `roll.ask` per 50 asked, one `roll.close` each, one `actor.outcome`. 52 rolls of the DM's 100.
- **`actor.outcome` at its bounds**: 100 targets, each with an amount, two conditions with durations and saves, and a resistance, measured at 49,779 bytes as compact JSON, under `outcomeOpBytes` (56 KiB) and the 64 KiB frame. Three conditions on every one of 100 would pass 56 KiB, so the page refuses that plan before any roll. **The session draft**: about 250 bytes a row, 25 KB at 100 rows.

## Appendix B. Worked example

Bree (spell save DC 15, doc 2) casts Flame Strike, 5d6 fire and 5d6 radiant, on four goblins, a fire elemental (immune to fire) and a Stunned goblin. The DM opens Save and damage: "From Flame Strike: Dexterity save, DC 15 (Bree's spell save DC), 5d6 fire + 5d6 radiant, half on a pass." Rows: four goblins Server "+2", the Stunned one "Fails: Stunned", the elemental Server "+1". "Roll 5 saves" sends one secret `dice.roll` of 5 with DC 15, and players read "Mara rolled in secret." Totals: 17, 9, 15, 6, elemental 12. The DM rolls the damage: fire 18, radiant 16. Rows: goblins pass 9 + 8 = 17, fail 34, pass 17, fail 34, the Stunned goblin fail 34, the elemental fail "Immune to fire: 16 radiant". "Apply: 6 take damage" sends one `actor.outcome`, and one undo takes all six back.

## Appendix C. Tables

**Presets by `D20Test` kind** (a save row covers concentration and save-ends saves of that ability):

| Effect | Save | Check | Attack | Initiative | Death save |
| --- | --- | --- | --- | --- | --- |
| Paralyzed, Petrified, Stunned, Unconscious | fails Str, Dex | | | the tracker's hint | |
| Restrained | dis Dex | | dis | | |
| Poisoned | | dis | dis | dis | |
| Prone, Blinded | | Blinded: note (sight) | dis | Blinded: note (sight) | |
| Invisible | | | adv (note: a target that sees it) | adv | |
| Frightened, Grappled, Deafened, Hexed | | note | note | note, Grappled none (Initiative is a Dexterity check, build round 1 W7B-P-22) | |
| Exhaustion | -2 per level | -2 per level | -2 per level | -2 per level | -2 per level |
| Blessed, Baned | +1d4, -1d4 | | +1d4, -1d4 | | +1d4, -1d4 |
| Dodging (not while `incapacitated`, Grappled or Restrained) | adv Dex | | | | |
| Hasted | adv Dex | | | | |
| Raging (not while `incapacitated`, which also ends its resistance, 3.3) | adv Str | adv Str | | | |
| Surprised, incapacitating conditions | | | | the tracker's hint | |
| Magic Resistance, against a spell | adv | | | | |
| Heroic Inspiration | note | note | note | note | note |

**Fill order** (5.6):

| Field | From, first to last |
| --- | --- |
| test | the save action's ability, the area preset's save, the last test this page used |
| DC | the save action's DC, the area caster's `RollNumbers.spellDc` (doc 2 for a character, Spellcasting for a monster) |
| damage parts | the action's parts that are not optional, the caster character's own spell of the area's name (`pcNamedRolls`), the preset's parts at its level |
| on a pass, conditions, their end | the action's, the preset's |

## Appendix D. Phone numbers

The sheet at 375 x 667 is 400 px with a 56 px header and 4 px of padding, about 344 px of body at 100% and about 248 layout px at 130% (docs/design-v1-sheet-swipe.md's appendix). At 130% the body is about 256 layout px wide. A row's name (80 px at least), Fail, Pass and Skip (about 170 px) and its amount (36 px) need about 300, so its control takes a second line and a row is about 92 px. The rolled group save's header count (about 24 px), one row (92) and Apply in the foot (44 plus 16 of padding) take about 176 px of the 248, so the first row and Apply show with no scroll, and the rows scroll between the count and Apply. At 100% the 344 px body holds the count, two rows and Apply. The options' 3-column grid of 44 px buttons with a 14 px second line holds the six saves in two rows of about 60 px.
