# raccoon-vtt v1: the roll request, condensed and fixed

Status: draft 4, with design review rounds 1 to 3 and the decisions of 2026-10-17 (section 15). Code is cited from the wave 6 design tip, whose code is the wave 5 tip's, on top of doc 1's draft (`lwottmxo`). This is doc 4 of the four wave 7 designs. It builds on docs/design-v1-dice.md ("doc 1"), which owns the roll itself, `roll.dice`, the creature's bonus, the cancel rule and the card's Roll contract (doc 1 section 7). It owns the DM's request sheet, the player's card, the DM's live card and the request's model. Docs/design-v1-pc-stats.md ("doc 2") fills the PC bonuses the card reads. Docs/design-v1-roll-options.md ("doc 3") owns the presets, the group save and its results list, which send requests through this doc (7.3). Measurements and worked examples are in the appendices, which verify rounds need not re-read.

The project owner asked on 2026-10-17: "Also please take a look at the request a roll section and condense it. Also the first choice never goes away even when selecting ability checks. Overall just give this feature some attention and improve it". And the same day, for dice: "when a dm prompts someone for a save or other roll that player should be able to either input a manual roll or click a button to roll the save."

## 1. Summary

- **The bug, fixed as a class.** Each choice in the sheet is one value, a whole roll: a save of an ability, a check of an ability, or a check of a skill. Every control shows that one value, and none keeps a value of its own, so an earlier tap can never outlive a later one. Nothing is picked until the DM picks it.
- **A shorter sheet.** Three rows pick the roll: Save (six abilities), Check (six abilities) and Skill (a dropdown). The DC and its typical values share a row. Who rolls is a row of chips. What players see, the note and "Against a spell" fold into one line that says what they are. The sheet goes from 762 px (a save) and 1,150 to 1,474 px (a check) to about 500 px, or 610 on a 320 px phone.
- **Fewer taps.** A save is open, ability, Send. The last three requests from this device are one tap each, DC and all. Enter in the DC field sends.
- **The player's card rolls, always.** While the creature waits, Roll sends doc 1's `roll.dice` with the creature's bonus, or with a bonus the player types when none is known ("Roll d20"). One answer path: a typed total and a roll never both count. Conditions apply as doc 3's presets say, the player adds their own Advantage, Disadvantage or dice, and a condition that fails the save records Fail. The result shows in the card until Done. A rolled answer is final, and the player can ask the DM in one tap to reroll it or add a die, which the DM allows in one tap.
- **The DM's live card** tells rolled from typed answers, shows the dice, counts passes and fails, rolls for a creature still waiting, and answers a player's ask to change a roll.

### 1.1 What docs 1 and 3 read from this one

Stated first and once, since doc 1's resolve and doc 3's results list read them exactly. Rules are in 7.5.

```ts
// shared/model.ts: the answer part of RollTarget (docs/design-v1-dm-tools.md 3.3), with what this doc adds
type RollAnswer = { choice?, total?, result?, noRoll?, by?, previous?,   // as today
  tag?: id,                  // the op that wrote this answer. Every answer op carries one (7.5)
  dice?: DiceResult,         // doc 1 5.1: present exactly when the total was rolled, `fails` on it when a condition failed it
  mark?: 'pass' | 'fail',    // the DM's own mark, kept apart from what a DC gives
  changed?: RollChange }     // the ask an allowed roll answered
type RollChange = { id: id,  // the ask's own id, made by the asking device
  on: id,                    // the `tag` of the answer it would change
  reason: 'heroic-inspiration' | 'halfling-luck' | 'lucky' | 'bardic-inspiration' | 'fix-total',
  face?: number,             // a reroll's die, its index in `dice.faces` (5.5)
  die?: 6 | 8 | 10 | 12 }    // Bardic Inspiration's die
RollTarget.change?: RollChange                    // a player's pending ask
RollTarget.retype?: true                          // an allowed "Fix my total": the player types the answer again, and may not roll
RollRequest.spell?: true                          // a save against a spell (5.3)
RollRequest.cause?: 'saveEnds'                    // public: what the request is for
RollRequest.ends?: { effect: EffectId, occurrence: id }   // the DM's: the effect a pass removes, and doc 3's save occurrence
resultOf(answer: RollAnswer, dc?: number): 'pass' | 'fail' | undefined   // shared/rules/rolls.ts
// shared/protocol.ts
op('roll.close', { rollIds, settle?: 'resolved' | 'dismissed', ifSettled?: true })   // settle: doc 3's Accept or Dismiss. ifSettled: "Close all answered" (below)
```

- **Provenance.** A total is rolled when `dice` is present, else typed. A result with no total is the player's `noRoll` or the DM's `mark`. `resultOf` gives the result in one order: the DM's `mark`, then, for an answer with no `tag` (one written before this build, `previous` included), its stored `result` as it stands, then `dice.fails` (Fail), then `noRoll` (Fail), then `total >= dc` when there is a DC, else none. The reducer stores `result` as `resultOf(answer, request.dc)`, so every reader agrees. Doc 3 calls `resultOf(answer, itsDc)` with its own DC: a mark wins whatever the DC, even a mark that agreed with the total when it was made.
- **Identity.** Every op that answers a target carries a client `tag`: `roll.answer` (typed totals, fail without rolling, marks) and doc 1's `roll.dice`, an allowed change included. The answer keeps it as `tag`. Doc 1's receipt for that tag (doc 1 1.2, `useReceipt`) settles a lost answer as committed, refused or unknown, and unknown never answers again by itself (5.6). The actor refuses a live `roll.answer` without `tag`, so only ops stored before this build lack one (7.5).
- **Asks.** A player's ask names the answer it would change (`on`). Allow, Keep and Withdraw name the ask (`id`). A rolled answer's asks change its dice (5.5). A final typed answer's one ask is "Fix my total", whose Allow lets the player type it again (decision 1 of round 3). The server refuses any of them before a draw unless that ask is pending on that answer, so a replaced, withdrawn or settled ask is never acted on (7.5).
- **Save ends** (decisions of 2026-10-17): `cause: 'saveEnds'` is public, so a player's card and `testOf` (doc 1 6.1) know it, while `ends` stays the DM's. The request closes on a pass, which removes the effect in the same op, when the effect goes another way, when the DM closes it (accepting the fail or dismissing it), or when the same effect's next occurrence opens. A fail leaves it open, so a rolled one can be asked about and a typed one fixed through "Fix my total" (the typed answer is final under the usual hidden-DC rule). One open request per occurrence. No request asks a concentration save.
- **Closing settles the occurrence, in one op** (W7-ASTRA-28). Every close of a request is `roll.close`: the live card's Close and "Close all answered", and doc 3's Accept failure and Dismiss on the save-ends card. For each request it closes, in the same op and before the request goes:
  1. A pending ask on any of its targets is settled as Keep, and the player's card reads "The DM kept the roll." "Close all answered" sends `ifSettled: true`, and the server checks each of its requests when the op runs, not when the DM tapped: one that is no longer answered on every target, or that holds a pending ask, is skipped and stays open, so an ask that arrives in between is never settled unseen (W7-ASTRA-33). A direct Close, Accept failure and Dismiss send no flag and close what they name, so only a close the DM aims at a request settles its ask.
  2. For a request with `ends`: if the effect is still on the target and its `due.id` is `ends.occurrence` with `due.state` pending (doc 3 6.1), `due.state` becomes `settle` when the op names one, else `resolved` when the target has an answer and `dismissed` when it has none. A newer occurrence, a settled one or a removed effect is left as it is, so a close never settles anything but its own occurrence.
  So doc 3's Accept failure is `roll.close { rollIds: [id], settle: 'resolved' }` and Dismiss is the same with `dismissed`. `actor.saveDue` stays only for an occurrence with no request. While the linked request's target holds a pending ask, doc 3's save-ends card shows it as the live card does ("Bree asks to reroll (Heroic Inspiration)", with Allow and Keep, 6), so Accept failure never drops it unseen, and Accept then settles it as Keep first (W7-P-49).

## 2. Today

- **The sheet** (`client/features/rolls/RequestSheet.tsx`): a Saving throw or Ability check switch (`:134-145`), then one editor per choice (`:146-157`, `:253-294`): an ability radio group that always holds a value (`:274-283`) and, for a check, 18 skill chips in rows by ability (`:284-291`). "Or…" adds a second editor (`:158-165`), and only the second has Remove (`:267-271`). Then the DC with six named chips for a check (`:166-203`), two checkboxes (`:204-213`), the note (`:214-225`) and a checkbox per creature (`:226-240`).
- **The draft** (`client/features/rolls/logic.ts:137-152`) starts as a Dexterity save. `withKind` carries the abilities across a switch of kind (`:155-158`). `withSkill` sets a skill's usual ability (`:160-164`). The ability radios change the ability and keep the skill (`RequestSheet.tsx:280`).
- **Reproduced** in `/dev/room` at 1280 x 800 and 390 x 844 (screenshots taken during the design), and confirmed by the project owner as the reported bug:
  1. Open "Ask the party": Dexterity is chosen, though the DM chose nothing.
  2. Tap "Ability check": Dexterity stays chosen. The status reads "Dexterity check".
  3. Tap Perception: Wisdom and Perception are both chosen, "Wisdom (Perception) check".
  4. Tap Strength: the status reads "Strength (Perception) check" and Perception stays pressed. The DM asked for a Strength check and sends Strength (Perception).
  5. With "Or…", the first choice has no Remove.
- **The cause** is one class: a choice is held as two controls, an ability and a skill, whose combination is sent, and the sheet starts with a value nobody picked. A tap on one control leaves the other's value in place.
- **The player's card** (`client/features/rolls/PlayerRolls.tsx:360-687`): a header with the question, the DC on its own line and Later (`:441-468`), per creature the choice (`:617-629`), reminders (`:630-639`), a form with the total and Send (`:640-671`) and, on a save, "Fail without rolling" (`:672-676`). After Send it folds into a chip (`:390-394`). At a phone's foot it measures its `form` as the answer row (`:404-430`).
- **The DM's live card** (`client/features/rolls/DmDesk.tsx:179-283`): a title, "n of m answered", and per creature its answer text (`logic.ts:312-322`), Reopen (`DmDesk.tsx:263-273`), Pass and Fail.

## 3. The rule that fixes the class

**One value per choice, and every control shows it.** A choice is one `Pick`:

```ts
// client/features/rolls/logic.ts
type Pick = { kind: 'save', ability: AbilityKey }
  | { kind: 'check', ability: AbilityKey, skill?: SkillKey }   // a skill's ability is its usual one unless changed (4.2)
type AskDraft = { choices: (Pick | null)[],   // 1 or 2, null until picked
  dc: string, dcShown: boolean, resultShown: boolean, spell: boolean, note: string, ticked: readonly ActorTarget[] }
```

- Every control in a choice's picker is a view of that one pick: the Save row shows its ability only for a save, the Check row only for a plain check, the Skill dropdown only for a skill. At most one of them shows a value. A tap or a pick in any of them replaces the whole pick (`choose(draft, i, pick)`).
- Nothing is picked at open. The status line says "Pick what to roll", and Send says so too.
- What Send sends is `draftTest(draft)`, and the status line names that same test (`testText`). The test in 11.1 checks the three agree after any sequence of taps.
- The same rule holds wherever this flow keeps a choice: the DC chips show the DC field's value, "Players see the DC" and "Against a spell" show only while they apply (4.6), the card's presets are read at the tap for the choice being rolled (5.3), the card offers one answer path at a time (5.2), and a typed draft is forgotten once its creature's answer changes (5.7).

## 4. The request sheet

### 4.1 Layout

```
Request a roll                                         [x]
 Recent  [Dex save, DC 15] [Wis (Perception) check]
 WHAT TO ROLL
 Save   [Str][Dex][Con][Int][Wis][Cha]
 Check  [Str][Dex][Con][Int][Wis][Cha]
 Skill  [ Choose a skill      v]
 [Or a second choice]
 DC     [ 15 ]  (5)(10)(15)(20)(25)(30)
 WHO ROLLS   [Thorn] [Vex] [Bree, on another scene]
 > WHAT PLAYERS SEE   The DC and pass or fail. No note.
 Dexterity saving throw, DC 15. 2 asked.   [Cancel] [Send]
```

The order: recent requests, what to roll, the DC, who rolls, what players see. Sending, refusals, Close while sending and the lock while sending stay as they are (`RequestSheet.tsx:73-106,131`).

### 4.2 The picker

- **Save** and **Check**: each a `Segmented` of the six abilities, `even`, shown "Str" to "Cha" with the full name as the title, so each is named "Strength" and so on (`accessibleName`, `client/lib/a11y.ts:13-17`). The groups are named "Saving throw" and "Ability check". Each holds a value only when the pick is theirs (`value: null` otherwise), so at most one shows a choice.
- **Skill**: the shared `Select` (`client/components/Field.tsx:44`), named "Skill check", "Choose a skill" first, then the 18 skills by name, each with its usual ability: "Perception (Wis)". Picking one makes the pick that skill's check with its usual ability (SRD 5.2.1 page 9). Picking "Choose a skill" clears the pick.
- **Another ability for a skill**: while a skill is picked, "with" and a second `Select` of the six abilities stand after it on its row, named "Ability for Perception", showing the pick's ability. The SRD lets a skill go with another ability, and doc 1's `bonusFor` carries the skill's bonus to it. Any new pick starts at the usual ability again.
- **Fit**: each row's label stands at its start while its six options fit beside it at 44 px each. Where they do not, the label goes above them, and where six do not fit across even then, they go three by three. This is an addition to `Segmented`'s `even` rule, which today goes two by two for four options under 210 px (`client/globals.css:222-234`). Widths are in Appendix A.

### 4.3 Two choices

- "Or a second choice" adds a second picker under the first, empty. The two are titled "First choice" and "Or the second", and each has Remove. Removing the first makes the second the first. The button goes while there are two (`LIMITS.rollChoices`).
- The two share one kind, as `RollTest` holds one (`shared/model.ts:1185`). In each picker the rows of the other kind are disabled while the other choice holds a pick, with a line saying why: "Both choices are checks." The other choice's exact pick is disabled too: "That is the first choice." Nothing is changed for the DM.
- Send refuses an empty choice: "Pick what to roll first." for the first, "Pick the second choice, or remove it." for the second.

### 4.4 DC

One row: the DC field as today, then, while every pick is a check, the six typical DCs as circle chips, "5" to "30", each named "15, Medium" with the SRD name as its title. A chip is pressed when the field holds its number, and a tap on a pressed chip empties the field. A save offers the field alone, since its DC is the effect's (SRD 5.2.1 page 7, docs/design-v1-dm-tools.md 3.3). The help line and "No DC" button go: an empty field is no DC, and the status line says "no DC".

### 4.5 Who rolls

The creatures from `defaultTargets` (`logic.ts:80-108`, unchanged), as toggle chips named by the creature. One that starts unticked carries its reason after its name, "Bree, on another scene". One that cannot be asked is unavailable (`Chip` `unavailable`) and described by its reason, "not on the players' scene", so the keyboard still finds it.

### 4.6 What players see

One folded section (`Section` with `fold`, `client/components/Panel.tsx:67-104`), titled "What players see", whose summary states the values: "The DC and pass or fail.", "DC hidden. Pass or fail shown.", "Pass or fail hidden." and so on, then "Against a spell." when set, then "Note: against the poison." or "No note." Unfolded:

- "Players see the DC" while a DC is set, and "Players see pass or fail". Under them the finality note when the DC is hidden and pass or fail shown (a typed answer is final once it passes or fails, a rolled one at once).
- "Against a spell" while every pick is a save. It travels with the request as `spell` (1.1), so a creature with Magic Resistance gets its preset on the card (5.3), and the card's question says it: "…saving throw against a spell, DC 15."
- The note field.

The two switches start as the newest recent request had them (4.7), else both on, as today: `askSwitches(roomId)`. That is the sheet's default and nobody else's (7.3). So they follow the DM's habit, and the summary always shows them. "Against a spell" starts off.

### 4.7 Recent requests

- After a request is taken, this device keeps it per room, newest first, at most three, one per test and DC: `rvtt.askRecent.<roomId>`, read and written inside try and catch, each entry checked on read and a bad one dropped.
- They show at the top as buttons, "Dex save, DC 15", one line each and cut with an ellipsis, named in full. A tap fills the choices, the DC, the switches, "Against a spell" and the note, and leaves who rolls as the entry point set it. It is no pressed state: the picker then shows what it filled.
- None yet: the row is not drawn.

### 4.8 Where it opens, and opening filled

- The party bar's "Ask the party" and the group bar's "Request a roll" open it as today. On the single creature's bar, "Request a roll" gives way to doc 3's Roll, which asks by default for a creature a player plays (the project owner, 2026-10-17, doc 3 4.5).
- `openAsk(scope, from)` (`client/features/rolls/open.ts:14-16`) takes `from.fill?: { test: RollTest, dc?: number, spell?: true, note?: string }`. The sheet opens with it filled. Doc 3's Ask path opens it this way with the tapped test. The party bar passes none.

### 4.9 Status, Send and Enter

- The status line: "Dexterity saving throw, DC 15. 2 asked." or "Pick what to roll. 2 asked." Send builds its op with `askOp(draftInput(draft), id, open)`: `draftInput` refuses the empty choices (4.3), then `askOp` runs today's checks (`logic.ts:179-211`) on a test rather than a draft, so doc 3 calls the same function (7.3).
- The sheet's fields are one form whose submit is Send, so Enter in the DC field or the note sends (8). The fields take `enterKeyHint="send"`.
- The draft reports unsaved input to the sheet swipe while it differs from how it opened (docs/design-v1-sheet-swipe.md 4.6, `useUnsavedInput`), as today's draft does.

## 5. The player's card

### 5.1 Layout

```
The DM asks for a Dexterity saving throw, DC 15: against the poison.  [Later]
Thorn
[ Strength +1 ] [ Dexterity +3 ]          two choices: which one you roll
- Restrained: Disadvantage on Dexterity saving throws.
[Roll +3]  [Adv] [Dis]  [ extra  ]        the roll row, while the creature waits
Rolls 1d20+3 with disadvantage (Restrained).   its reading
[ Total              ] [Send]             the type row
[Fail without rolling]                    a save
```

- The DC joins the question's line: "…saving throw, DC 15: against the poison." or "…, DC hidden." One line less on every card.
- With two choices, each names its bonus where the device knows it, "Dexterity +3", and the higher bonus starts picked, the first on a tie or with none known. The creature picks, and the better one is its usual pick.
- **The roll row's fit**: Roll, Adv and Dis share its first line at every supported size (at most 224 px, Appendix A). Each field follows on that line while it fits whole at its width, else starts a second line, the bonus field (5.2) before the extra field.

### 5.2 Roll, and one answer path

- **Offered while the creature waits**: no total and no result, on an open request. Once it has any answer, typed, failed or marked, the roll row is gone for the player, and the server refuses a player's `roll.dice` on an answered target (7.1). A typed total is still changed with Send, as today, unless final. A DM's Reopen makes it wait again, and Roll comes back. So a typed total and a roll never both count, and nobody types a low roll, reads Fail, then rolls again.
- **While typing**: Roll is disabled while the Total field holds text, described "Clear the total to roll instead." While a roll waits, the Total field, Send and Fail are disabled (5.6).
- **With a known bonus**: `creatureBonus(view, target, testOf(request, choice))` (doc 1 section 6). Roll reads "Roll +3", "Roll -1" or "Roll +0", named "Roll +3 for Thorn".
- **With no bonus known** (no stat block yet, the project owner, 2026-10-17): Roll reads "Roll d20", and a Bonus field stands in the row, 16 px, named "Your bonus for Thorn", a whole number from -20 to 30. Roll stays disabled until the field holds one, described "Type your bonus first, such as +5 or 0.", and then reads "Roll d20+5". The op carries `bonus` (7.1). For a character a player owns with no stat block, a quiet "Add a stat block" opens doc 2's editor.
- **Primary look**: Roll is the card's primary button while it is offered, and Send takes the primary look instead while the Total field holds text.
- **The player's own Advantage, Disadvantage and extra dice**, for what the app does not know, such as the Help action or Guidance: two toggle chips, "Adv" and "Dis", named "Advantage" and "Disadvantage", at most one on, and a field, 16 px, placeholder "+1d4", named "Extra dice for Thorn", read with doc 1's `parseExtra`, holding what keeps the whole extra within doc 1's 40 characters. All start off and empty.
- **The tap** sends `roll.dice { rollId, target, choice?, mode?, extra?, bonus? }` through doc 1's `sendRoll`, the mode and extra combined as the reading says (5.3). Before sending, the card checks what the server would refuse first and words it the same: the extra (`parseExtra`) and a range past -50 to 100 (`formulaRange`). Offline, Roll is disabled and described "Rolling needs a connection." (doc 1 4.5). A typed total still queues as today.

### 5.3 Presets and the reading

- **Presets** are doc 3's: `presetFor(view, target, testOf(request, choice))` (doc 3 3.2), read at the tap from the creature's effects and its Magic Resistance then, as the Dice panel's buttons read them. It returns its advantage and disadvantage as sources (doc 1 3.3's `AdvantageSource`), not a resolved mode. The card adds the player's pressed Adv or Dis as one more source and reduces them once, at the tap, by doc 1's cancel rule (3.3): any advantage with any disadvantage is a normal roll, however many of each. The preset's extra comes before the player's.
- **A `fails` preset** (Stunned, Paralyzed, Petrified or Unconscious on a Strength or Dexterity save, as the creature's players see its effects): "Fail (Stunned)" stands first in the answer block with the primary look and sends today's fail without rolling, in place of the plain "Fail without rolling", and the card's result reads "Failed: Stunned." Roll stays as a quiet button, and the reading says "Stunned: this save fails whatever the roll." A roll made anyway records Fail with its total kept, by the server's rule (7.1), so every path that answers the request agrees: the card, the live card and the Dice panel's options. The result reads "Rolled 17. Fail (Stunned)." The DM may still mark Pass.
- **The reading** under the roll row says how the tap will roll, as the Dice panel's reading does (doc 1 8.2): "Rolls 1d20+3 with disadvantage (Restrained), +1d4 (Blessed)." or "Rolls 1d20+3: Advantage and Restrained cancel." It is the Roll button's description. With no preset and nothing pressed or typed it is not drawn.

### 5.4 After an answer

- **A roll** that lands while the card shows, from its Roll or from the Dice panel's options answering the request (doc 3 4.3), shows its result in place of the creature's rows: "Rolled 17 (1d20+5 with advantage: 12, 7 dropped). Pass." with "Natural 20" or "Natural 1" where `naturalOf` finds one, a dropped die struck through on screen, then "Final." and "Ask to change it" (5.5). A polite live region says "Thorn rolled 17. Pass." The card stays up, since the result is news to the player. Once every creature on it has an answer, Later reads "Done". Done, Back or a swipe folds it as Later does. This is doc 1's rule that a roll's result shows where its roller looks.
- **Send and Fail** fold the card as today, unless it shows a result rolled while it was up, which waits for Done.
- **A save-ends request that closes on a pass** (7.5) takes the card with it. A result this device rolled then shows as a toast from its `roll` line, "Thorn rolled 17 on a Wisdom saving throw. Pass.", so it still appears where the roller looks. A fail leaves the request open, and its card and chip behave as on any request: "Ask to change it" on a rolled fail, Send to correct a typed one.
- **The chip** after a roll: "Dex save: rolled 17 (1d20+5: 12). Pass. Final." While the request is open, the chip of a rolled answer is a button that opens the card to ask for a change, named "… Open to ask the DM to change it." A typed one stays "Dex save: sent 17. Pass." A final typed answer (a hidden DC) is a button the same way, named "… Open to ask the DM to fix it.", where it was plain text (`PlayerRolls.tsx:699-716`).
- **Finality**: `finalForPlayer` (`logic.ts:336-338`) is also true once the target has `dice`, as doc 1's `isFinal` is. A creature the DM rolled for reads the same: the player's projection carries no `by`.

### 5.5 Asking to change a rolled answer

The project owner decided on 2026-10-17 that a player asks in one tap for a reroll with a named reason, or to add a die, and the DM approves in one tap. Without that approval the rolled answer stays final.

- **Ask to change it**, under a final answer, opens a menu on the shared popover base. Each item sends at once. On a rolled answer the items follow doc 1 5.4 (the decisions of 2026-10-17 that a reroll redraws one die, and that Heroic Inspiration may name any die):
  - "Reroll: Heroic Inspiration" names the default die, `rerollFace` (doc 1 5.4): the kept d20 on a normal or disadvantage roll, the dropped one on an advantage roll. While the roll holds other dice, such as Bless's d4, one more item per die names it, "Reroll the d4 (3): Heroic Inspiration", at most three.
  - "Reroll: Halfling Luck", listed only while a d20 shows 1, names that die (the first, when both do).
  - "Advantage: Lucky", listed on a normal roll whose sources did not cancel and on a disadvantage roll. On a normal roll it draws one more d20 and keeps the higher. On a disadvantage roll the sources cancel and it keeps the first d20, drawing nothing. It is not listed on an advantage roll or a cancelled one, which doc 1 refuses ("Lucky changes nothing on this roll.").
  - "Add a d6 (Bardic Inspiration)", and the same for a d8, a d10 and a d12, adds that die to the total.
- **On a final typed answer** (a hidden DC with pass or fail shown) the one item is "Fix my total" (decision 1 of round 3). The DM's Allow reopens the answer for typing alone: the old answer goes to `previous`, the target waits with `retype`, the card offers the Total field and Send but no roll row, and the server refuses a player's roll there, "Type the corrected total." The next answer clears `retype`. The DM's Reopen still works as today.
- The tap sends `roll.change { rollId, target, ask }`, the ask carrying its new `id`, `on` (the answer's `tag`) and, for a reroll, the `face` it names (1.1, 7.5). The card then reads "Asked the DM to reroll (Heroic Inspiration)." with Withdraw, which sends `clear` naming that `id`. Another item replaces the ask with a new `id`.
- **The DM's answer** (6): Allow rolls on the server (or, for "Fix my total", reopens for typing) and Keep clears the ask, each naming its `id`. Every other face and number stays, and the kept rule applies again, so a disadvantage roll of 14 and 6 whose 6 is rerolled to 17 keeps 14. Keep makes the card say "The DM kept the roll." The new answer is final and rolled, with its own `tag`, so it can be asked about again. The DM's Reopen or a new answer clears any ask, and a close settles it as Keep (1.1).

### 5.6 One answer at a time

Each creature's answer is a small machine, `answerFlow(state, event)` in `logic.ts`, which `CreatureAnswer` renders:

- States: idle, or busy with one of roll, send, fail, ask or withdraw, and an error line or none.
- A tap is taken only when idle and the request still holds the creature. Roll only while the creature waits without `retype` and the Total field is empty. Send and Fail only on an answer that is not final. Ask and Withdraw only on a final answer. While busy, every other answer button is disabled.
- Every answer to that op, taken, refused or unknown, ends the busy state. A refusal shows the server's words under the rows.
- **Unknown is settled, never retried.** Each op carries its `tag`. While the request is open, the target says what happened: an answer with this `tag` is this device's, a different one came first, and a waiting target means it never landed, so Roll comes back. Once the request is gone (a save-ends pass, a close), the card asks doc 1's receipt for the tag (`useReceipt`, doc 1 1.2): committed shows its result as a toast, refused shows the reason, and unknown says doc 1's words, "This may have happened. Check the log." Nothing rolls or sends again by itself.
- A tap of Roll, of a choice or in a field marks the card engaged (`onEngage`), so a newer request becomes a chip rather than replacing it.

### 5.7 Drafts and the screen's foot

- `AnswerDraft` (`logic.ts:399`) also keeps the player's own mode, extra and bonus, so turning the phone keeps them. `answerKey` (`:407-409`) also reads `dice` and `change`, so an answer or an ask from the player's other device forgets the draft.
- At a phone's foot the card measured its `form` as the answer row (`PlayerRolls.tsx:404-430`). It now measures the answer block, from "Fail (Stunned)" or the roll row down to the type row (`data-answer`), so the question, Later, Roll, the total and Send show and take a tap at once where they fit. Where they do not, the existing steps take over unchanged: fold with the "Roll asked" row, rise over the toolbar, then to the screen's top, then unstick the header (docs/design-v1-bar-dock.md). The roll row adds about 56 px to the measure, or 108 when its fields wrap, and the reading about 18 more while drawn. The joined DC line takes about 20 px back on every card.

## 6. The DM's live card

- **The title row** gains the tally: "2 of 3 answered: 1 pass, 1 fail", and "1 asks to change a roll" while one does.
- **An answer** tells how it came: "rolled 17 (1d20+5: 12)" or "typed 17", with "natural 20" where found, "fails (Stunned)" where the server recorded it, "marked Pass" for the DM's own `mark`, the choice first when there are two, "Dex: rolled 17 (…)". A replaced one says which it was: "typed 15, changed from rolled 12 (1d20+5: 7) (Fail)", and an allowed change names its reason: "rerolled 19 (Heroic Inspiration), was 9". This is `dmAnswerText` (`logic.ts:312-322`) reading `dice`, `mark`, `changed` and `previous`. A Pass or Fail tap sets `mark`, which keeps its meaning whatever DC later reads it (1.1).
- **Roll for a waiting creature**: where Reopen stands on an answered row, a waiting row whose bonus the DM's view knows shows a quiet "Roll +5", named "Roll +5 for Thorn". It applies `presetFor` over the DM's view, so every effect counts and the creature's Magic Resistance meets the request's `spell`, and with two choices the higher bonus, and says so as doc 3's buttons do: "Roll Dex +5, Disadvantage (Restrained)", or "Roll Dex +5: fails (Stunned)". It sends `roll.dice` with `unanswered: true` (doc 1 4.1 and 4.3), so an answer that arrived first is never replaced. That refusal shows as a toast: "Thorn answered before your roll." A token target on a scene the DM is not viewing has no bonus in the DM's view, so it has no Roll.
- **A player's ask**: the row reads "Asks to reroll (Heroic Inspiration)", "Asks for advantage (Lucky)" or "Asks to add a d8 (Bardic Inspiration)", with Allow and Keep, one tap each, both naming the ask's `id`. Allow sends `roll.dice { rollId, target, tag, change: id }`, or `roll.reopen { rollId, target, change: id }` for "Asks to fix the total", and Keep sends `roll.change { rollId, target, clear: id }` (7.1, 7.5). Close settles a pending ask as Keep, and "Close all answered" sends `ifSettled`, which leaves a card with an ask, or one no longer fully answered when the op runs, alone (1.1). Allow or Keep of an ask that was replaced, withdrawn or already settled, from this device or a second one, is refused before any draw: "It was settled meanwhile." The row then shows the ask that stands, if any. A card with an ask unfolds on a computer, names the ask in its folded line on a phone, and makes the DM's alerts summary lead the dock (`waiting: true`, docs/design-v1-visual.md 3.2.1), since it waits for the DM.
- Pass, Fail, Reopen and the phone folding (`deskLayout`, `chipStack`) are unchanged. Close and "Close all answered" follow 1.1's close rule, so a save-ends request they close settles its occurrence too.

## 7. Contracts

### 7.1 With doc 1

- This doc calls `creatureBonus`, `testOf`, `sendRoll`, `parseExtra`, `formulaRange`, `d20Formula`, `diceText`, `naturalOf`, `rolledTerms`, `AdvantageMode`, `AdvantageSource` with `resolveAdvantage` (3.3), `rerollFace` (5.4), and `useReceipt` with its receipt lookup (1.2, 8.7) as doc 1 names them. `roll.dice`'s `unanswered` is doc 1's (4.1, 4.3). Doc 1 reads `cause`, `spell`, `RollChange` and `resultOf` from 1.1 here.
- **What doc 1's `roll.dice` does for requests** (doc 1 1.1, 4.3, 5.4), which this doc relies on:
  1. **A player's roll needs a waiting target.** A player's `roll.dice` on a target with a total or a result is refused as `unanswered` refuses it, "It was answered meanwhile." (5.2).
  2. **`bonus?: number`**, -20 to 30, used only when the server knows no bonus for the test (5.2).
  3. **`change?: id`**, the DM's Allow, naming the ask (1.1). It is refused with `invalid`, "It was settled meanwhile.", before any draw, unless the target's pending ask has that `id` and its `on` is the current answer's `tag`. It resolves the ask as doc 1 5.4 says (5.5 here): the named `face` redrawn, any face for Heroic Inspiration, and the kept rule applied again, Lucky as one more advantage source (a d20 drawn on a normal roll, nothing on a disadvantage roll), or Bardic Inspiration's die added. A "Fix my total" ask is allowed by `roll.reopen` instead (7.5). The old answer goes to `previous`, the new one keeps the ask as `changed`, `change` clears, and its `roll` line names the reason: "Thorn rerolled 20 (Heroic Inspiration, …)". Doc 1's field was `change: true` until round 2.
  4. **`fails`**: resolving a `roll.dice` for a save, the server runs `presetFor`'s effect rules (doc 3 3.2) over the creature's effects not hidden from its players and stores the failing condition on the result. Stored, so replay never reads the rules. `resultOf` then gives Fail with the total kept, unless the DM marks it.
  5. **`tag`** on every `roll.dice`, kept on the answer and settled by doc 1's receipt (doc 1 1.2), as on every op that rolls.
- Doc 1 section 7 is laid out here: 5.2 and 5.3 are "Offered", the mode and extra, and the send. 6 is "The DM may send it".

### 7.2 With doc 2

`pcRollNumbers` gives a character's bonuses, so a PC's card offers "Roll +N" once its stat block exists. Until then it offers "Roll d20" with a typed bonus and "Add a stat block", which opens doc 2's editor.

### 7.3 With doc 3

- Doc 3 owns the presets (`presetFor`), the group save and its results list, and the save-ends and concentration cards. This doc owns `roll.ask` and every request field, its sheet, the card and the live card.
- **`askOp(input, id, open)`** takes `{ test, dc?, dcShown, resultShown, spell?, cause?, ends?, note?, targets }`. Every caller passes both switches itself. `askSwitches(roomId)` is only the sheet's default. Doc 3's save-ends request passes `cause: 'saveEnds'`, `ends` with its occurrence, and `dcShown: false` unless the DM shows its DC (the project owner, 2026-10-17). Doc 3 sends no request for a concentration save: its card answers that save itself. The group save passes the switches its page shows. Doc 3 finds who can be asked with `askTarget` (`logic.ts:120-126`), reads the answers from `view.rolls[id].targets` with `resultOf` against its own DC (1.1), so a live-card mark wins there too, and passes `spell` when the save is against a spell, so an asked row and a rolled row get the same Magic Resistance.
- **Every DM roll of an asked creature sends `unanswered: true`**: the live card's Roll (6), the group save's one-tap server roll of an asked row (the project owner, 2026-10-17, doc 3 5.2), and the Dice panel's options answering a request (doc 3 4.3). So whichever lands first stands, and the others are refused before any draw. A player's own roll is held to a waiting target by the server (7.1).
- Each request gets the live card like any other, so the DM can Reopen, mark, roll or answer an ask there. Its note may name the effect ("Fireball"), which players read. The card and the live card read an answer from doc 3's surfaces as any other.
- Doc 3's Ask path opens this sheet with `openAsk(scope, { kind: 'selection', tokenIds, fill })` (4.8). Doc 3 wrote it as "a preset". The name is now `fill`.

### 7.4 With other designs

- **docs/design-v1-dm-tools.md 3.3**: the sheet's controls (4), the card (5) and the live card (6) replace its "DM behavior", the card bullets and "The app rolls nothing". Its model and ops gain 7.5.
- **docs/design-v1-visual.md 2.3** (`Segmented`): `even` with six options goes three by three where six cannot keep 44 px (4.2). **3.2.1**: the DM's rolls summary leads the dock while a change waits (6).
- **docs/design-v1-bar-dock.md and docs/design-v1-visual.md 3.3.1**: the card's measured answer row becomes the answer block (5.7). Every fallback is unchanged.
- **docs/design-v1-sheet-swipe.md**: unchanged. The sheet's draft still reports unsaved input, and the card's swipe is still Later.
- **The shortcut sheet**: a new surface, "Roll requests", after doc 1's "Dice" (8).

### 7.5 The request's additions

Additions to docs/design-v1-dm-tools.md 3.3's model and ops, owned here. The fields are 1.1's. The ops:

```ts
// shared/protocol.ts
rollRequestInput gains spell?: true, cause?: 'saveEnds', ends?: { effect: EffectId, occurrence: id }
op('roll.answer', { ...as today, tag?: id })    // every client sends it. Optional only so stored ops replay
op('roll.change', { rollId, target, ask?: RollChange, clear?: id })   // exactly one of the two
op('roll.reopen', { rollId, target, change?: id })   // with `change`: the DM's Allow of a "Fix my total" ask
op('roll.close', { rollIds, settle?: 'resolved' | 'dismissed', ifSettled?: true })   // the close rule of 1.1
```

- **Provenance in the reducer.** `rollAnswer` (`shared/reducer/rolls.ts:75-116`) stores the op's `tag` on the answer it writes. A DM's `result` with no total sets `mark` and keeps the total, and a DM's total with a `result` sets both. A player's total or fail, a new roll, or a reopen clears `mark`, as a new answer clears any old result today. `result` is then always `resultOf(answer, request.dc)`. The `roll` line gains `mark?: true` when a mark wrote it, so the projection drops a mark line by that field when pass or fail is hidden, which closes the known gap of LP5-ROLLS-4 (`isMarkLine` guessing from values). A `roll` line also gains the answer's `tag`, which marks it as written by this build.
- **Legacy answers and replay** (W7-ASTRA-31, W7-DATA-17):
  - **Ops stored before this build replay as they did.** `rollAnswer` asks `answerProvenance(opVersion)` (`shared/migrate.ts`, as `revealSeenAnywhere` does at `:263`). For a stored op older than the new version it runs today's rule: no `tag`, no `mark`, the result as today. So replay rebuilds the state those ops made, with the same entity hashes, and every stored restore guard still matches. Live ops and ops of the new version write `tag` and `mark`.
  - **Answers in snapshots keep their decision.** An answer with no `tag` (or a `previous` with none) reads its stored `result` through `resultOf` (1.1), so a legacy Pass mark on a total of 3 against DC 13 stays Pass until a new answer or mark replaces it. No snapshot step rewrites answers.
  - **Archived lines**: a `roll` line with no `tag` is filtered for players by today's `isMarkLine`, and one with a `tag` by its `mark`.
  - **Versions**: `OP_VERSION` 6 to 7 and `SNAPSHOT_VERSION` 10 to 11 (`shared/migrate.ts:13-14`), one bump for the whole wave, made by the first wave 7 build step that lands. Every wave 7 rule gates on that same number. Both steps are the identity for this doc's fields, which are optional and read as before when absent.
  - **Deploy and rollback**: take a database backup just before the deploy (docs/design-v1-dm-tools.md 3.17). The shutdown writes version 11 snapshots. An older build refuses a version 11 snapshot or a version 7 op ("cannot migrate from version 11 down to 10", `runMigrations`), and those rooms go read-only. So a rollback restores that backup and loses the play since. There is no step down.
- **`roll.change`**: `ask` is a player's, for a target they own now, with `ask.on` equal to the current answer's `tag`, else `invalid`, "It was settled meanwhile." A reroll, Lucky or an added die needs an answer with `dice` ("Only a rolled answer can be changed this way."). Its `face` must be a face the result holds, and for Halfling Luck a d20 showing 1, as doc 1 5.4 checks ("That die cannot be rerolled this way."). Lucky on an advantage or cancelled roll is refused, "Lucky changes nothing on this roll." "Fix my total" needs a typed answer that is final for the player. It replaces any pending ask. `clear` is a player's Withdraw or the DM's Keep and clears the pending ask only when its `id` matches, else `invalid`, "It was settled meanwhile." `roll.answer`, `roll.reopen` and any new answer clear it too, and `roll.close` settles it as Keep (1.1). `roll.reopen { change: id }` is the DM's Allow of a "Fix my total" ask, refused as `clear` is when the id is stale: it reopens the answer, keeping it in `previous`, sets `retype`, and clears the ask. A player's `roll.dice` on a target with `retype` is refused, "Type the corrected total." It writes no log line, since the allowed roll writes its own.
- **`cause` and `ends`.** `ends` is the DM's, on a save request with one choice and one target that has `ends.effect` now, with `cause: 'saveEnds'`, else `invalid`, "Ends needs one creature with that effect." A second open request with the same `ends.occurrence` is refused, "That save was already asked.", so two DM devices cannot ask twice. Doc 3 6.1 makes the occurrence id (creature, effect, the turn end) and keeps its state.
- **When an `ends` request closes** (decision 1 of round 2), always on the server, in the op that causes it:
  - **A pass**: any answer whose `resultOf` is Pass (a typed or rolled total at the DC, the DM's Pass, an allowed change that passes) removes `ends.effect` from the target if it is still there, then closes the request after its line.
  - **The effect goes another way**: any op that removes the effect (`actor.effect.remove`, an expiry, doc 3's outcome) closes the open requests whose `ends.effect` it names.
  - **The DM closes it**: `roll.close`, from the live card or as doc 3's Accept failure and Dismiss, settling the occurrence in the same op by 1.1's close rule.
  - **The next occurrence** of the same effect opens (doc 3 6.1), closing the request of the one before in the same op.
  - **A fail** leaves it open, final under the usual rules (5.4). A typed fail under the hidden DC is fixed through "Fix my total" (5.5).
- **Projection.** `spell` and `cause` go with the request. `ends` is the DM's. `tag`, `mark`, `change`, `changed` and `retype` go with the target, to the DM and the creature's players, as the target does, except that `mark` follows `result` and is dropped when pass or fail is hidden. `previous` with its fields stays the DM's, as today.
- **Undo and waiting.** `roll.change` is on no stack, as a player's answer is, and waits for the server. A DM's mark undoes as today.
- **Export and import.** Open requests are dropped as today, so none of these fields travels. A `roll` line keeps `mark`.

## 8. Accessibility and keys

- The pickers are named groups, "First choice" and "Or the second" around them when there are two. The status line is the dialog footer's polite text, as today.
- The roll row's chips are toggle buttons, and the reading is Roll's description. The card's result line is announced politely (5.4). When a roll lands, the creature's rows give way to the result, and focus moves to the card's header button (Later, or Done once every creature is answered), so it never falls to the page. "Ask to change it" is a menu button on the shared popover base, with its keys.
- Keys, all inside fields, so the room's shortcuts stand aside as in every field. New surface "Roll requests", after Dice:

| Key | Does | Who | Sheet section |
| --- | --- | --- | --- |
| Enter | Send the request | DM, in Request a roll's DC or note field | Roll requests (new) |
| Enter | Send the total you typed | players, in a roll card's Total field | Roll requests. It works today, and the sheet now lists it |
| Enter | Roll, with the bonus and extra dice you typed | players, in a roll card's Bonus or Extra dice field | Roll requests |

No other key is added or changed.

## 9. Edge cases

| Case | Outcome |
| --- | --- |
| Perception, then Strength in the Check row | "Strength check". Perception's dropdown goes back to "Choose a skill" |
| Open, then Send | "Pick what to roll first." Nothing is pre-picked |
| Perception with Charisma, then Insight | Insight with Wisdom, its usual |
| Two choices, a save in the first | the second's Check row and Skill are disabled, "Both choices are saves." |
| Two choices, Remove on the first | the second becomes the first |
| DC 15 by chip on a check, then a save | the chips go, the field keeps 15 |
| A recent request with two choices | both pickers filled, the switches, spell and note set, who rolls kept |
| No storage (private window) | no Recent row, switches both on |
| A stored recent entry that fails its check | dropped, the others shown |
| A DC typed, then cleared | "Players see the DC" leaves the fold, and the summary drops it |
| Enter in the DC field while sending | nothing: Send is busy |
| A save-ends request from doc 3 | `dcShown: false` unless the DM shows it, whatever `askSwitches` says |
| A save-ends request, the player rolls a pass | the effect goes and the request closes in the same op. The card goes, and a toast shows the result |
| A failed Hold Person save, then Heroic Inspiration | the request stays open, the ask goes to the DM, and an allowed reroll that passes removes the effect and closes it |
| A save-ends total mistyped as 3 for 13, DC hidden | the fail is final and the request stays open. "Fix my total", the DM's Allow, then 13: a pass that removes the effect |
| "Fix my total" allowed, then the player taps Roll | no roll row. A stale device's roll is refused, "Type the corrected total." |
| A Pass the DM marked on 3 against DC 13 before this build | still Pass, from a snapshot or a replay: the stored result of an answer with no `tag` |
| A DM mark and its undo, stored before this build, replayed | the same state and hashes as then, so the undo's guard matches |
| The live card's Close on a save-ends request, then a reload | the occurrence is settled in that op (resolved if answered, else dismissed), so no card comes back |
| "Close all answered" while one request holds a pending ask | that request stays open, the others close |
| An ask, or a reopen, lands between the DM's "Close all answered" tap and the op | `ifSettled` skips that request on the server, and the rest close |
| Accept failure with a reroll ask pending | the ask is kept as Keep, the occurrence resolved and the request closed, in one op |
| Accept failure after a newer occurrence opened | the old request closes. The newer occurrence is left pending |
| The DM removes the effect while its request waits | the same op closes the request |
| The creature's next turn end, the old request still open | doc 3's new occurrence closes it in the same op |
| Two DM devices ask the same occurrence | the second `roll.ask` is refused, "That save was already asked." |
| A lost answer on a save-ends pass, the request gone | doc 1's receipt settles it. Unknown never rolls again |
| Card: no bonus known | "Roll d20", disabled until a bonus is typed, then "Roll d20+5" |
| Card: the server knows a bonus the player's view lacks | the server's bonus wins, shown in the line |
| The player types 9, sends, reads Fail | the roll row is gone. Send changes the typed total, as today |
| The player types 9 and taps Roll before sending | Roll is disabled: "Clear the total to roll instead." |
| The player's other device answered first | that device's Roll is refused "It was answered meanwhile." |
| Card offline | Roll disabled, "Rolling needs a connection." Send queues |
| Restrained, a Dex save, the player presses Adv | a normal roll, said in the reading |
| Hasted and Restrained, the player presses Adv | a normal roll: any advantage with any disadvantage |
| Stunned, a Dex save | "Fail (Stunned)" is primary. A roll made anyway records Fail with its total |
| Stunned hidden from players, a Dex save | no `fails`: the roll records its result, the DM marks Fail |
| A save against a spell, a companion with Magic Resistance | advantage in the reading, as on doc 3's rows |
| Blessed and Exhaustion 2 on a save, the player types +1d6 | the roll adds "+1d4-4+1d6", named in the reading |
| An extra that does not read, such as "+1d" | `parseExtra`'s error under the row, nothing sent |
| Roll refused (budget, gone, final, answered) | busy ends, the server's words under the rows |
| A typed Send or a fail refused by the budget, since every answer op carries a tag | busy ends, "You are going too fast. Wait a few seconds." under the rows, the total kept |
| The request closes while rolling | `gone`, and the card goes with the request |
| The DM rolls while the player types | the player's later Send is refused as final. The DM's Roll after the player's answer is refused by `unanswered` |
| Doc 3's one-tap server roll and the live card's Roll on one row | the first to land stands, the other is refused by `unanswered` |
| Reroll asked, then withdrawn, then Allow | Allow is refused, "It was settled meanwhile." |
| A d6 ask replaced by a reroll while the DM's Allow travels | Allow names the d6 ask and is refused. The row shows the reroll |
| Withdrawn, asked again, then a stale Allow of the first | refused: the pending ask has another `id` |
| Two DM devices tap Allow | one change. The second is refused |
| Heroic Inspiration on a disadvantage roll of 14 and 6 | the 6 redrawn, the 14 kept, the lower of the two counts |
| Heroic Inspiration naming Bless's d4 | the d4 alone redrawn, every d20 kept |
| Heroic Inspiration on an advantage roll | the dropped die redrawn, the higher counts |
| Lucky on a disadvantage roll | nothing drawn: the sources cancel, a normal roll on the first d20 |
| Lucky on an advantage roll, or a cancelled one | not listed. The server refuses it, "Lucky changes nothing on this roll." |
| The DM marks Fail on 12 against DC 15, then doc 3 reads it at DC 10 | still Fail: the `mark` wins whatever the DC |
| The DM marks Pass on a Stunned creature's rolled fail | Pass: the `mark` comes before `fails` |
| Bardic d8 allowed on 12 against DC 15 | 12 plus the d8, judged against the DC again |
| The DM reopens a rolled answer with an ask | the ask clears, the card comes up again with Roll |
| Halfling Luck with no d20 showing 1 | not offered |
| The player answers from the Dice panel while the card shows | the result in place, as from the card's Roll |
| A condition the DM hid | not in the player's data, so no reminder and no preset on their card. The DM's Roll reads it, and the server's `fails` does not |
| A token target on another scene, for the DM | no Roll on its row |
| Several creatures, one rolled | its result in place, the others still answer, Done once all have |
| Turning the phone mid-entry | text, choice, mode, extra and bonus kept |
| 375 x 667 at 130% | Roll, Adv and Dis on one line, the fields on the next (Appendix A) |
| A hidden DC, pass or fail shown | a typed answer final once it has a result, as today. A rolled one final at once |
| Doc 3's group request | a live card like any other |

## 10. Self-sweep

Swept as classes before reporting:

- **Stale choice** (the bug): every control that shows a choice was checked against the one value it views: the three picker rows, the skill's ability, the DC chips, the switches and "Against a spell", the player's choice, the presets (read at the tap), and the drafts. None holds its own value.
- **One answer path** (W7-P-9): every way a creature's answer is made was listed: the player's Roll, Send and Fail, the Dice panel's options, the DM's Roll, mark and Reopen, doc 3's group roll, and an allowed change. Each player path that makes a second roll after an answer is refused by the server, and the DM's ones by `unanswered` or by the pending ask.
- **Rules that decide alone** (W7-P-4): `fails` is recorded by the server on every path that rolls a request's answer, from effects the players see. The modes reduce once by doc 1's rule (W7-ASTRA-08).
- **Provenance and identity** (W7-ASTRA-01, W7-ASTRA-20, W7-DATA-12, W7-ASTRA-26): every place a result is read goes through `resultOf`, whose order puts the DM's mark first. Every answer op carries a `tag`, every ask an `id` and the `tag` it changes, and every op that acts on an ask names it, so no replaced, withdrawn or settled ask is acted on, and no lost answer is guessed.
- **A save-ends request's life** (decisions 1 and 2): each way it ends is a server rule in the op that causes it, so no device has to be there. A fail leaves it open, a rolled fail for a change ask and a typed one for "Fix my total".
- **Every close settles** (W7-ASTRA-28): the four close paths (Close, "Close all answered", Accept failure, Dismiss) are one op, `roll.close`, the bulk one conditional on the server (`ifSettled`), which settles a pending ask as Keep and its own occurrence, never a newer one. No two-op gesture is left to half finish.
- **Old data** (W7-ASTRA-31, W7-DATA-17): stored ops replay by their version's rule, snapshot answers keep their stored result, archived lines keep today's filter, and the versions and the rollback are stated (7.5).
- **Secrecy**: no new data reaches a player beyond their own target's `tag`, `change`, `changed` and `retype`, and `cause`. `ends` stays the DM's. `mark` follows `result`. `fails` reads only effects the players see.
- **Context, switches and sizes** (W7-ASTRA-15, W7-ASTRA-05): `spell` reaches every preset that reads it, every `askOp` caller passes both switches, and the sheet and the roll row hold at 1280, 390, 375, 360 and 320 px, at 100% and 130%.
- **Contracts**: doc 1's names cited, and what its `roll.dice` does for requests listed once (7.1). Doc 3's `presetFor` called, not redefined. Every request field is stated once, in 1.1, and its rules in 7.5. The citations doc 3 makes of 4.8, 5.2, 6 and 7.3 still land.

## 11. Tests

### 11.1 Unit (node:test)

- `client/features/rolls/logic.test.ts`: `choose`, `draftTest`, `draftInput`, `askOp` and `askSwitches` row by row from section 9, the reproduction of section 2 giving "Strength check", the two-choice rules, the recent store, `seenSummary`, `answerFlow`, the card's offers (Roll only while waiting and the field empty, "Roll d20" with a bonus, Ask only on a rolled final answer, Halfling Luck only on a 1), the reading and op from preset sources and the player's toggles, `finalForPlayer` and `answerKey` with `dice` and `change`, `dmAnswerText` rolled, typed, marked, failed by a condition and changed, the tally, the DM's choice by the higher bonus, the face each reason names (5.5), and `resultOf` in every order of mark, `fails`, `noRoll` and DC, a mark that agreed with its total included, and a legacy answer with no `tag` keeping its stored result. The menu's items per roll (a Bless die's item, Lucky's absence on advantage or a cancelled roll, "Fix my total" on a final typed answer).
- **Randomized: the picker.** 2,000 sequences of 40 random steps (a row tap, a skill, another ability, Or, Remove, a DC typed or a chip, spell, a recent, a fill). After each step: every picker shows exactly its pick, with at most one row holding a value. The status line names `draftTest`, and `askOp` sends exactly it. Two choices never conflict in kind and never match. A skill's ability is its usual one unless "with" changed it since the skill was picked. A step a rule forbids changes nothing.
- **Randomized: the card's answers.** 2,000 sequences over `answerFlow` and the card's fold: typing, taps of Roll, Send, Fail, Ask and Withdraw, server answers taken, refused or unknown in any order, the other device's answer or ask, the DM's mark, roll, Allow, Keep, Reopen and Close, the socket dropping and coming back, a remount. Invariants: at most one op in flight per creature, nothing sent after the request is gone, an unknown op never sent again by itself, Roll never offered once the creature has an answer or while the field holds text, Send and Fail never offered on a final answer, busy ended by its op's answer and only by it, the card never folding while a creature waits unless Later or Done was tapped, a draft never outliving a change to its answer.
- **Randomized: the request's answers on the reducer** (`shared/reducer/rolls.test.ts`): random interleavings of `roll.answer` (player total, fail without rolling, DM total and mark), `sys.dice` from `roll.dice` with a scripted draw (a player's, a DM's with and without `unanswered`, with `bonus`, with `change`, with `fails`), `roll.change`, `roll.reopen` and `roll.close`, on requests with no DC, with `ends` (with effect removals, next occurrences, and closes from every path with and without `settle` and `ifSettled`, asks and reopens landing between a bulk close's tap and its op), a shown DC and a hidden one, with asks replaced, withdrawn and asked again, "Fix my total" allowed, and the DM's "Close all answered". Invariants: a player never changes a final answer, a player's roll never replaces any answer, a replaced answer is always in `previous`, with a DC a total's result is `total >= dc` until a DM mark unless the result holds `fails`, `dice` is on a target exactly when its latest total was rolled, an `unanswered` roll never replaces an answer, a `change` roll happens at most once per ask and only while it is pending, `change` never survives a new answer, a reopen or a close, an Allow, Keep or Withdraw acts only on the pending ask it names and only while it is pending on the answer it was made on, `result` always equals `resultOf(answer, dc)`, an `ends` request closes on its first pass, its effect's removal, the DM's close or its next occurrence and never on a fail, a pass removes its effect at most once, no two open requests share an occurrence, a close settles only its own occurrence and only while it is pending, no pending ask survives a close, "Close all answered" (`ifSettled`) never closes a request that holds a pending ask or waits on a target when it runs, whatever arrived after the tap, and a target with `retype` takes no player roll.
- **Legacy and replay** (`shared/reducer/rolls.legacy.test.ts`): two histories with a DM's Pass mark on 3 against DC 13 and its undo, one loaded from a version 10 snapshot and one replayed from version 6 ops, give equal states, equal hashes, a matching undo guard, Pass from `resultOf`, and archived lines filtered by `isMarkLine`. A new mark on a legacy answer then wins.

### 11.2 e2e

- `e2e/rolls.e2e.ts`: the section 2 sequence sends "Strength check", nothing picked at open, Remove on the first of two, a recent request, Enter in the DC field, the folded "What players see". A character with no stat block: "Roll d20", a typed bonus, the result in place. With a companion block (doc 1) or a PC stat block (doc 2): Roll while Restrained (the reading, then Adv making it normal), a Stunned save's "Fail (Stunned)", a typed answer removing Roll, the result in place and Done, the chip, "Ask to change it" with Heroic Inspiration and the DM's Allow, the DM's card reading "rolled", the DM's Roll on a waiting creature.
- Touched: `e2e/tools.e2e.ts` test 4 (the kind switch and "First ability" go, and the DC joins the card's question line), `e2e/size.e2e.ts` (the request sheet's shots), `e2e/playerphone.e2e.ts` (a card whose roll row wraps at a short phone's foot, now for every PC since "Roll d20" shows without a stat block), `e2e/bardock.e2e.ts`, `e2e/fold.e2e.ts`, `e2e/layout.e2e.ts` and `e2e/dmphone.e2e.ts` (their cards now have a roll row, so the foot measure grows), `e2e/shortcuts.e2e.ts` (the new section). Run those and `reach` during the build.

## 12. Build plan

One builder, in this order:

1. `fix(rolls): each choice in request a roll is one whole roll` (`Pick`, `choose`, `draftTest`, the three-row picker, two removable choices, the six-across rule, the picker's randomized test, `tools` and `rolls` e2e). Needs nothing from wave 7, so it can ship ahead of it.
2. `feat(rolls): a shorter request sheet with recent requests` (answer provenance first: `tag` on `roll.answer`, `mark`, `resultOf` with its legacy rule, `answerProvenance` and the wave's version bump if no earlier step made it, the line's `tag` and `mark`, the legacy test, `roll.close` with `settle` and the close rule, then the DC row, who rolls as chips, the folded "What players see" with "Against a spell", `RollRequest.spell`, `cause` and `ends` with its lifecycle, Recent, Enter, `openAsk` fills, `askOp` on a test with explicit switches, `draftInput` and `askSwitches`, the shortcut rows for the sheet).
3. `feat(rolls): roll a request's answer from the card` (after doc 1's build steps 1 to 3 with 7.1's needs 1, 2 and 4, and doc 3's `presetFor`: the roll row and its fit, "Roll d20" with a bonus, one answer path, the reading, "Fail (Stunned)", `answerFlow`, the result in place and Done, the joined DC line, drafts, the answer block measure, the card's shortcut rows).
4. `feat(rolls): the dm's live card shows rolled answers and rolls for a waiting creature` (with doc 1's `unanswered`).
5. `feat(rolls): ask the dm to reroll or add a die` (`roll.change` with ask ids, `change` and `changed`, 7.1's need 3, the menu with doc 1 5.4's faces, "Fix my total" with `retype` and `roll.reopen { change }`, Allow and Keep naming the ask, the summary leading the dock).
6. `test(e2e): roll requests with dice`.
7. `docs: roll requests in the feature list and the design` (FEATURES.md, docs/design-v1-dm-tools.md 3.3, the visual and bar dock notes of 7.4).

## 13. FEATURES.md

"## Rolls" opens "The DM asks players for a saving throw or an ability check, and each player rolls it in the app or types the total they rolled." Its bullets become, one each:

- The DM asks for a save or a check from "Ask the party" in the party bar, "Request a roll" in the bar of several selected creatures, or Roll in a single creature's bar or the Dice panel for a creature a player plays. One tap picks the roll: a save or a check by ability, or a skill from a list. A skill can go with another ability. Nothing is picked until the DM picks it.
- "Or a second choice" lets the creature pick between two, such as Strength (Athletics) or Dexterity (Acrobatics). Either can be removed.
- The DC, with the typical DCs for a check, from 5 to 30. Who rolls, as chips. What players see (the DC, pass or fail), "Against a spell" and a note fold into one line that says what they are, and the switches follow the DM's last request.
- The last three requests from that device are one tap each. Enter in the DC field sends.
- The player's card asks the question with its DC and shows reminders from the creature's conditions and statuses. While the creature waits, Roll rolls on the server with its bonus, or with a bonus the player types when the app knows none. Conditions such as Restrained, Bless or Magic Resistance against a spell apply as in the Dice panel, the player can add Advantage, Disadvantage or extra dice, and a line under Roll says how it will roll. A condition that fails the save, such as Stunned on a Dexterity save, offers "Fail (Stunned)" first, and a roll made anyway records Fail. Or the player types the total and taps Send, and once a total is sent, Roll is gone. A save also offers "Fail without rolling".
- A rolled result shows in the card until Done, then in the chip. A rolled answer is final. The player can ask the DM to reroll one die (Heroic Inspiration, the d20 or any other die such as Bless's d4, or Halfling Luck on a 1), to add advantage (Lucky) or to add a Bardic Inspiration die, and the DM allows or keeps it in one tap. A typed total that is final can be fixed the same way, with "Fix my total". A failed save that ends a condition stays open for this, and a pass ends the condition at once.
- The DM's live card counts passes and fails, tells rolled answers from typed ones with their dice, keeps the DM's own Pass or Fail mark apart, can roll for a creature still waiting, and shows a player's ask with Allow and Keep.
- The existing bullets on chips, folding under sheets, the screen's foot, finality with a hidden DC, who sees answers and the pause stay.

"## Shortcuts" gains "### Roll requests" with section 8's three rows.

## 14. Decided here, for the project owner to overrule

- The sheet opens with nothing picked. Recent requests make a repeat one tap.
- "What players see" starts as the DM's last request on that device had it.
- The card applies doc 3's presets at the tap, and the player's toggles add sources to them, as in the Dice panel, rather than the presets being toggles the player can switch off.
- The card's two choices start at the higher bonus.
- After a roll the card waits for Done, while a typed total folds at once as today.
- The DM can roll for a waiting creature from the live card, never over an answer.
- "Roll d20" waits for a typed bonus rather than rolling +0.
- Indomitable and other features are left to the DM's Reopen.
- Halfling Luck rerolls the first d20 showing 1 when both do.
- An unknown answer says so and points to the DM's card, rather than offering Roll again.

## 15. Decided for the project owner (2026-10-17)

1. **The bug section 2 reproduced is the one reported.** Section 3's class fix goes ahead.
2. **Skills are one dropdown.** A skill takes two taps, or one through Recent.
3. **Rerolls after a final rolled answer**: the player asks in one tap with a named reason, or to add a die, and the DM approves in one tap. Without approval the answer stays final (5.5, 6).
4. **No stat block**: the card always offers a roll, "Roll d20" plus a bonus the player types (5.2).
5. **The DM's single bar for a creature a player plays** keeps Roll and drops Request a roll. Ask is Roll's default there. The group bar keeps Request a roll (4.8, doc 3).
6. **A save-ends or concentration request keeps its DC private** unless the DM shows it. Those requests set their switches themselves (7.3). Doc 3 sends save-ends requests only. A concentration save is answered on its own card.
7. **A save-ends request stays open after a failed save** (round 2), so a change can be asked and a typed total fixed (decision 10). It closes on a pass, when the effect goes another way, when the DM closes it, or when the next occurrence opens (1.1, 7.5).
8. **`cause: 'saveEnds'` is public**, and `ends` stays the DM's (1.1). No request asks a concentration save.
9. **A reroll redraws one die**: the kept d20 on a normal or disadvantage roll, the dropped one on advantage, the die showing 1 for Halfling Luck, every other face kept and the kept rule applied again. **Lucky adds an advantage source**: one more d20 on a normal roll, nothing drawn on a disadvantage roll, refused on an advantage or cancelled roll (5.5, doc 1 5.4).
10. **A typed answer that is final can be fixed through the DM** (round 3): "Fix my total" asks, the DM's Allow lets the player type it again, and the hidden-DC finality rule otherwise stands. Reopen still works (5.5).
11. **Heroic Inspiration may reroll any one die of the roll**, Bless's d4 included, with the prescribed d20 as the default (5.5, doc 1 5.4).

## Appendix A. Measurements

From `/dev/room` (Chrome, the system font at 14 px weight 600, chips and buttons 26 px wider than their text, the dialog body 526 px inside at 1280 x 800):

| Body height (px) | Today, a save | Today, a check | This design, estimated |
| --- | --- | --- | --- |
| 1280 x 800 (577 shown) | 762 | 1,150 | about 500, or 585 with Recent |
| 390 x 844 (649 shown) | 762 | 1,312 | about 500 |
| 320 x 568 (344 shown) | 798 | 1,474 | about 610 |

The estimate adds the body's 32 px padding, four section gaps of 16 px, three labels of 26 px, the three picker rows at 44 px with 8 px between, "Or a second choice", the DC row, one row of creature chips and the folded line at 44 px each.

| Width inside the sheet's body | Six abilities beside a 48 px label | Six under their label | The 18 skills as chips (rows) |
| --- | --- | --- | --- |
| 526 (computer) | yes | yes | 4 |
| 358 (390 phone) | yes | yes | 6 |
| 328 (360 phone) | no | yes | 6 |
| 288 (320 phone) | no | yes | 8 |
| 268 (390 phone at 130%) | no | no, three by three | 8 |

Six options need 6 x 44 + 5 x 4 = 284 px, and beside the label 332 px. The skill rows are what chips would have cost (15.2).

**The card's roll row.** Widths: "Roll +3" 73, "Roll +10" 80, "Roll d20+10" 107, "Adv" 53, "Dis" 48, the bonus field 64, the extra field 88, gaps 8. The first line holds at most 107 + 53 + 48 + 16 = 224 px.

| Inside the card (screen, size) | First line | Extra beside it (Roll +3) | Bonus and extra beside it (Roll d20+5) |
| --- | --- | --- | --- |
| 358 (390 x 844, 100%) | fits | fits (286) | bonus fits (289), extra wraps |
| 343 (375 x 667, 100%) | fits | fits | bonus fits, extra wraps |
| 288 (320 wide, 100%) | fits | fits (286) | both wrap to the second line (160) |
| 256 (375 x 667, 130%) | fits | wraps | both wrap to the second line (160) |

## Appendix B. Worked examples

- **A Perception check, DC 15, for the party**: Ask the party, Skill, Perception, chip 15, Send. The status read "Wisdom (Perception) check, DC 15. 2 asked." The next time: Ask the party, the recent "Wis (Perception) check, DC 15", Send.
- **Thorn, Restrained, with Dexterity save +3, Blessed**: the card shows "Roll +3" and reads "Rolls 1d20+3 with disadvantage (Restrained), +1d4 (Blessed)." The tap sends `roll.dice { rollId, target, mode: 'dis', extra: '+1d4' }`. Doc 1 resolves 2d20kl1+3+1d4, draws 14, 6 and 3: total 12 against DC 13. The card reads "Rolled 12 (1d20+3+1d4 with disadvantage: 14 dropped, 6, 3). Fail. Final." Thorn has Heroic Inspiration: Ask to change it, "Reroll: Heroic Inspiration", which names the kept 6 as its `face` and its answer's `tag` as `on`. The DM's row reads "Asks to reroll (Heroic Inspiration)", and Allow redraws the 6 alone: 17. The 14 and the d4's 3 stay, and disadvantage keeps the lower of 14 and 17: 14 + 3 + 3 = 20, a pass. The DM's row reads "rerolled 20 (Heroic Inspiration), was 12".
- **Bree, no stat block, a Wisdom save**: the card shows "Roll d20" and a Bonus field. Bree types 5, and Roll reads "Roll d20+5". The server knows no bonus, so it rolls 1d20+5.
- **The DM rolls for Vex, away from the table**: Vex's row shows "Roll +2". The DM taps it as Vex's phone sends 15. Vex's answer lands first, the DM's roll is refused by `unanswered`, and the DM reads "Vex answered before your roll."
