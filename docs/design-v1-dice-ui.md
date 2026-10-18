# raccoon-vtt v1: a UI and UX pass on the Dice panel and stat blocks

Status: design draft 1, for review. The prototype is in its own commits on top of this one, so the build can take it over.

The project owner asked for it on 2026-10-17: "please do a ui pass on the stat block and dice pages it's really good but spacing is inconsistent. There's also many elements that are on the next line that don't need to be, like critical and damage rolls. Also for spells that are saves in place of damage they should display the save dc in place of damage. We also don't need to display the damage roll under the button it should just be in the header. A roll animation would also be cool but can be done after these changes. TBH just do a ui ux review to see how space can be saved and the new features can be made more intuitive". Two more passes were folded in the same day: icons across the whole app (docs/design-v1-icons.md) and the Token panel (docs/design-v1-token-panel-groups.md).

## Scope

- **In**: every surface wave 7 added or changed. The Dice panel (quick dice, the formula field, Recent rolls, Secret, a creature's roll options), stat blocks (the PC view and editor, a monster's block in the Token panel, Take a shape, Rolls now), the group save, the request card and the DM's live card, the save-ends, concentration and recharge cards, toasts and log lines of rolls. Sizes: 390 x 844, 375 x 667, 844 x 390 and 390 x 844 at 130% on touch, and 1280 x 800.
- **Out**: data, ops and behavior. The one display change beyond layout and wording is a save spell's DC (4.4). The newest-roll line also takes answers and death saves (4.1, LP7-DICE-10), which the brief asks for.
- **Fixed**: no control is removed, every target stays 44 px, nothing needs hover or a long press.

Screenshots: `screenshots/dice-ui/audit/` (before, the stacked tip with this pass's fixture option) and `.../proposal/` (after, the prototype). Names: `d-` 1280 x 800, `p-` 390 x 844, `s-` 375 x 667, `l-` 844 x 390, `t-` 390 x 844 at 130%, `s130-` 375 x 667 at 130%. A long panel is shot page by page (`-p1`, `-p2`). The fixture is `/dev/room?diceui=1` (the first prototype commit): Thorn's block with save spells, a long weapon name with three riders and 22 rolls in all, the Owlbear and an Adult Red Dragon linked to the SRD, and rolls in the log. `proposal/draft-1/` and `draft-2/` hold earlier runs: before the shared tags and the slot stepper (4.3, 4.4), and before the one-line header and the riders' short names (4.4). The first audit shots predate the fixture's last 13 rolls. Those made late (`*-dice-player-long-*`, `*-bar-goblin-*`, `*-answer-sticky-*`, `*-concentration-player-*`) come from a second workspace at the stacked tip with the whole fixture, as do Appendix A's numbers.

## 1. Findings, ranked by help at the table

| # | Finding | Today | Fix |
|---|---|---|---|
| 1 | A roll moves what is under the finger | A result line appears under the button tapped, so the row grows and everything below jumps, and the sticky line at the top already says it (`p-dice-player-rolled-02`) | Results land in the panel's header line only (4.1). Rows never grow |
| 2 | Cells repeat the same words | "+1d4: Blessed" under all 12 saves and checks and every attack, "Dis: Poisoned" under 6 checks, "asks the player" under 18 cells: two to three lines a cell (`t-dice-dm-goblin-02`) | Said once in the group's label. A cell carries a 11 px tag only where it differs from its group (4.3) |
| 3 | A named roll takes three or four lines | Name, a grid of 120 px buttons, then a row of chips for riders and Critical | Two lines: header (name and numbers) and one line of controls that wraps only when full (4.4) |
| 4 | Save spells say nothing | Hold Person and Turn the Unholy show an empty row to a player. No DC anywhere in the options | "DC 14 Wis" in the row's header, where an attack shows "+6 to hit" (4.4) |
| 5 | The Token panel buries AC and speed, and is all open | A goblin's panel is 2,845 px on a computer, 1,892 on a phone | Quick numbers under the name, groups by use (the token panel doc) |
| 6 | Four label looks in one panel | 16 px "Rolls for", 13 px muted "Saves", 13 px capitals "SKILLS", 14 px row names | One look per level (3.2) |
| 7 | Recent rolls wastes lines | Again drops to a line of its own. "Thorn 9 Thorn, Longsword damage" says the name twice | Again holds the line's corner, the repeated name goes (4.5) |
| 8 | Initiative is wide and wordy | A 320 px cell: "Initiative +2, replaces 15" and a sub line | "Initiative +2" with the tag "replaces 15", two of three columns (4.3) |
| 9 | The Ask switch explains itself twice | A 3-line switch row, then "asks the player" in every cell | "Ask Thorn to roll saves and checks", one line, and the groups' labels say "asks Thorn" (4.3) |
| 10 | The PC block's abilities take 7 table rows | 181 px | Three across, two rows, as the 2024 block prints them (6.1) |
| 11 | The editor leaves a save total alone on a line (LP7-PC-12) | "16 ☐ Proficient Save" then "+4" under it at 375 x 667, 130% | "Save" and its total wrap as one (6.2) |
| 12 | The group save's "What players see" is a bare summary, the Damage field has no visible name (LP7-PC-10) | `d-groupsave` | The request sheet's fold and words, and a "Damage" label (4.6) |
| 13 | An answer or a death save leaves the header on an older roll (LP7-DICE-10) | | The header's form with no Again (4.1) |
| 14 | One request shows as two cards for the DM | A save-ends card and its request's live card both offer Allow and Keep for the same reroll (`d-request-saveends-dm-01`) | Question 3 |
| 15 | An empty 53 px band (LP7-CHROME-4) | A stacked phone with no options row keeps a bordered band | Reserved, never painted (3.1 rule 6) |
| 16 | Icons | Again uses Redo's arrow, Secret has no mark | The icons doc (`again`, `hidden`) |

Findings 1 to 4 are the owner's points 4, 2, 2 and 3. Point 1 (spacing) is section 3. Point 5 (the roll animation) is 4.7. Point 6 is this table.

## 2. The owner's points, answered

1. **Spacing**: one set of rules (3.1), applied to every surface in scope (4 to 7). Appendix A has the measurements.
2. **Wrapping**: a row's controls share a line wherever they fit (3.3). Critical, the riders and Damage share the controls line (4.4). At 390 x 844 every weapon row holds Attack, Damage and Critical on one line, and one rider beside them where its words are short.
3. **Save DC**: "DC 14 Dex, 2d8 radiant" in the row's header, where an attack row reads "+6 to hit, 1d8+3 slashing" (4.4). A save with no damage reads "DC 14 Wis" alone.
4. **The damage roll under the button**: gone. The result shows once, in the panel's header line (4.1), and the damage formula once, in the row's header (4.4). Question 1 asks whether the row should keep a quiet copy of its own last total.
5. **Roll animation**: later. The header line is where it plays, and nothing in this pass moves it (4.7).
6. **UX review**: section 1.

## 3. The rules

### 3.1 Space

The scale is `theme.space`: 4, 8, 12 and 16 px. Each step has one job, by how closely two things belong:

| Step | Between | Examples |
|---|---|---|
| 4 (`space(1)`) | Controls of one cluster. A label and what it labels | Cells of a grid, chips in a row, a group's label and its grid, a header and its controls line |
| 8 (`space(2)`) | Rows of one list. The panel's parts | Above and below a named roll's line, Recent rolls' rows, the roller and the options |
| 12 (`space(3)`) | Groups inside one part | Saves, Checks, Skills, Initiative, Actions, Spells |
| 16 (`space(4)`) | Sections of a panel, with a line | The pane's padding, a Token panel section |

1. **Only the scale.** No raw 2, 6 or 10 px gaps in these surfaces (`OptionCell`'s 2 px goes). A 1 px line is a line, not a gap.
2. **Distance follows belonging.** Closer things sit closer: a group's label sits 4 px over its grid and 12 px under the group before it, so the eye pairs them without a box.
3. **One boundary, one mark.** A list row is parted by a 1 px line and 8 px each side. A section by a line and 16 px. Never a line and a large gap, never two lines.
4. **Results never move layout.** A roll landing adds no line anywhere (4.1). A button's busy words ("Attack…") replace its words in place.
5. **No negative margin past the content box.** The one exception is the header line's top, which takes back the pane's top padding so nothing scrolls past above it. Sideways it keeps to the column: it reached 16 px past each side (21 at 130%), and now 0.
6. **Reserve, never paint.** Space held so nothing moves stays empty: no border, no fill. A stacked phone with no options row keeps the map's 53 px inset and draws nothing in it, the line 6 px above the toolbar (LP7-CHROME-4, docs/design-v1-tool-options.md 6.6, whose last sentence this reads as the inset).

### 3.2 Labels and rows

- **One look per level.** A group label is the panel's section label (13 px, weight 700, capitals, muted, `SectionLabel`'s look), with its note after it on the same line (13 px muted), wrapping under it when the line is full: "SAVES  +1d4: Blessed. Dis: Restrained".
- **A named roll's name** is a row title: 16 px weight 600, as `Row` titles are (docs/design-v1-visual.md 2.3), with its uses and recharge after it at 13 px muted.
- **The creature's heading** "Rolls for Thorn" stays at 16 px weight 600.
- A Token panel group is 16 px weight 700 with a chevron (the token panel doc 4), above its sections' capitals labels.

### 3.3 What shares a line

- A row's controls are one wrapping line of units. A unit never breaks inside: a button, a chip, the slot stepper, "Save" with its total.
- Words come before tags. A cell's tag goes under its words when both do not fit, and the words never cut (4.3).
- Again holds the top right corner of its line, and the words wrap beside it (4.5).
- A header is one run of text: the name, then its numbers after it ("Longsword  +6 to hit, 1d8+3 slashing"), wrapping as words where the name is long, never a line for a result.

## 4. The Dice panel

### 4.1 The header line

The sticky line at the top of the panel (`LastResult`, docs/design-v1-dice.md 8.2) is the one place a panel roll's result shows. It already shows the total, the label, the faces, the verdict and Again, 40 px tall, and stays in view while the options scroll.

- **Every panel roll lands here**, options included: a cell's tap shows busy on the cell, then the result here. Rule 2 of docs/design-v1-dice.md 8.7 ("its result shows beside that control") becomes, for the Dice panel only: "its result shows in the panel's header line, which stays in view, and the control returns to rest". Cards (requests, concentration, recharge, the group save's rows) keep their results in place, since they have no header.
- **A refusal** shows here as today, in `dangerText`, and the cell's words come back.
- **The screen reader** hears "Rolled 17: Longsword." from the line's polite live region, as today, whichever control rolled.
- **Answers and death saves** (LP7-DICE-10): `LastRoll` gains a form `{ tag, once: true, label }`, set when the panel sends a request's answer (`roll.dice`) or a death save (`actor.deathRoll`). The line reads the roll from its own log line (`rollsOf` already reads an answer's `roll` line). It shows the total, the label ("Dexterity save", "Death save"), the faces and the verdict, and no Again, since neither can be sent again as it went. Its place stays empty, the label taking the room (`p-answer-sticky-01`).
- **Again** keeps its word beside the `again` icon (icons doc), since it is the line's one action.
- **Bleed**: its sideways negative margins go (3.1 rule 5).

### 4.2 The roller

Unchanged in layout: the formula field with Roll, the reading, the quick dice strip and the three chips, three lines on any phone. Measured, the chips cannot join the dice strip (332 px of dice in 358 px), and joining the field (Adv, Dis and Secret are 204 px) leaves it 90 px, too narrow for "2d6+3 fire". Secret gains the `hidden` icon before its word.

### 4.3 Saves, checks, skills and initiative

- **Cells are one line**: the ability and its bonus ("Dex +1"), 14 px weight 600, and at the right a tag at 11 px muted: "Dis", "Adv", "+1d4", "Fails", "Asked" (this cell answers the DM's request). The tag shows only where the cell differs from its group: if all six saves get +1d4 from Bless, the group's label says "+1d4: Blessed" and no cell repeats it.
- **The group's label** names every effect that bears on its rolls, once: "SAVES  +1d4: Blessed. Dis: Restrained". With the DM's Ask switch on, it adds "asks Thorn".
- **The Ask switch** is one line, "Ask Thorn to roll saves and checks", without its help line: the groups' labels say what a tap does while the cells are in view.
- **A cell's name** for a screen reader keeps everything the old sub line said: "Dexterity save, answers the DM's request, Dis: Restrained. +1d4: Blessed".
- **Initiative** spans two of the three columns: "Initiative +2" with the tag "sets row" or "replaces 15". A monster in a room that uses scores shows "Score 12" in one column beside "Roll instead" in two.
- **Death save** (while dying, leading as today) spans two columns the same way.
- **Skills** keep their fold and their two columns of 140 px or more.
- **Attacks** say their preset once in the actions' label ("ACTIONS  Attacks +1d4: Blessed"), so every Attack button is one word.

### 4.4 Named rolls

```
Longsword  +6 to hit, 1d8+3 slashing, +2d8 Divine Smite
[Attack] [Damage] [Critical] [Divine Smite]

Fire Breath  Recharge 5–6 · DC 21 Dex, half on a pass, 17d6 fire      [Used]
[Group save] [Damage] [Recharge]
```

- **Header**: one run of text. The name (16 px weight 600), then after it on the same line its uses and recharge and its numbers (13 px muted), as a stat block prints them (`rowSummary`): "+6 to hit, 1d8+3 slashing, +2d8 Divine Smite", "Recharge 5–6 · DC 21 Dex, half on a pass, 17d6 fire", "2d8+3 healing". A long name wraps and the numbers follow it. Used (a recharge action's) sits at the right as a chip.
- **A save stands where an attack's bonus stands** (the owner's point 3): "DC 14 Dex, 2d8 radiant" for Sacred Flame, "DC 14 Wis" for Hold Person, which had no line at all for a player. "Half on a pass" shows only where there is damage to halve. The DC is the one a player's block or the monster's block already gives (`NamedRoll.save`).
- **The damage formula shows once**, in the header. The buttons are verbs: Attack, Damage, Heal, Roll (a plain die), Recharge, and for the DM, Group save. The row's numbers above them say what each rolls.
- **One controls line**, wrapping as units only when full (3.3): Attack, Group save (DM), Damage, Critical, each rider, Heal, Roll, Recharge, the slot stepper.
- **Critical** is a chip beside Damage. It still presses itself after a natural 20 (or the weapon's range). The room's crit rule ("Critical: dice rolled twice") moves from Damage's sub line to Critical's tooltip and name.
- **Riders** are toggles named for the rider alone, "Divine Smite", or a block's clause cut short, "With Advantage" for "if the attack roll had Advantage" (`riderText`). Their dice are in the header ("+2d8 Divine Smite"), which saves each toggle its dice's width, so Attack, Damage, Critical and a short rider share one line at 390 px (353 of 356 px). The whole clause stays the chip's name for a screen reader: "Add 1d4 if the attack roll had Advantage to the next damage".
- **The slot stepper** is "− Level 2 +", 144 px, on the controls line, where the shared stepper and its number field took a line of their own (306 to 356 px wide).
- **Group save** says "Group save", its DC already in the header. Its confirm (`ReplaceConfirm`) takes the next line when shown.

At 390 x 844 a weapon with no rider is 84 px, from 118, and one with a short rider 103. A long rider still takes a second line (Scimitar, 132). Appendix A lists every row.

### 4.5 Recent rolls

- One roll's line: who, the total, the label, the formula and faces, and the verdict, wrapping as text beside Again, which holds the top right corner. A one-roll line is one or two lines, never three.
- The creature's name goes when it is the roller's own name ("Thorn 9 Longsword damage").
- Roll again takes the `again` icon and "Roll again" as its tooltip.

### 4.6 The group save and the DM's selection

- **What players see** (LP7-PC-10): the request sheet's fold (`Section` with a chevron) and its words folded ("The DC and pass or fail.", `groupSeen`, the group save's version of `seenSummary`).
- **Damage** gets a visible label over its field, so it never reads as part of the fold above.
- The page's other rows follow 3.1: rows 8 px apart with a line, the outcome's fields as `FieldRow`.
- The DM's several-token options (`GroupOptions`) keep their layout. Their buttons take 3.1's gaps.

### 4.7 The roll animation, later

Not designed here. What this pass keeps ready for it:

- **Where**: the header line. Every panel roll lands there, so one animation serves every control. A card animates its own result in place.
- **How it could work**: while the roll is in flight the total slot shows a die face (a game-icons d20 from the shipped set) turning, and on the answer the faces chips land one by one and the total counts up, within 400 ms after the answer and never delaying it more. A natural 20's face rings once in the accent. CSS transforms and opacity only, no animation loop at rest.
- **Never moves layout**: the line is 40 px before, during and after (3.1 rule 4).
- **Reduced motion**: with `prefers-reduced-motion: reduce`, or Low power on, nothing turns or counts: the result appears at once, as today. The live region speaks at once in every case.
- **Others' rolls** (toasts, the log) never animate.

## 5. The Token panel

Its own document: docs/design-v1-token-panel-groups.md. In short: AC, speed, Passive Perception, initiative and elevation under the name, the picture beside it, then the groups Stat block, Combat (Hit points, Conditions, Range rings, Rest), Notes, Position (with Sight) and Image, then setup. Combat starts open for everyone.

## 6. Stat blocks

### 6.1 The PC block's view

- **Abilities three across** (`PcStatsView`): a 3 x 2 grid of small raised boxes, each the ability's abbreviation (11 px capitals), the score (16 px bold) and modifier, and "Save +4" (bold when proficient, which a screen reader hears as "proficient"). 116 px where the table took 181.
- The roll lines keep their wording, which already names a save's DC ("DC 14 Dexterity save").
- **Rolls now** (a shape) stays one line under the shape's note.
- **Take a shape** sits on the stat block's header row as the group's action (the token panel doc 4).

### 6.2 The PC block's editor

- **LP7-PC-12**: an ability row wraps as two units: the score with Proficient, and "Save" with its total. At 375 x 667 and 130% the second unit drops under the first whole, never the total alone.
- The rest keeps its layout. Its help lines ("Save: Str +3, all saves +1") stay: they explain a total the player may type over.

### 6.3 A monster's block

The SRD's own Markdown, unchanged. Its ability table would read better three across like 6.1, but it is the stat block's text, so it is question 4.

## 7. Cards, toasts and log lines

- **The request card** (`p-request-save-player-01`) keeps its layout: the reminders, Roll with Adv and Dis, the typed total and Send. Its gaps take 3.1's steps.
- **The DM's live card and the save-ends card**: see finding 14 and question 3.
- **Concentration and recharge cards**: their results stay in place (4.1). Their buttons keep their words (icons doc 3.1 rule 4).
- **Toasts and log lines of rolls** keep their words (`rollToastText`, `describeEvent`): they are read, not tapped.

## 8. Edge cases

| Case | Outcome |
|---|---|
| A long weapon name ("Flame Tongue Greatsword of the Burning Dawn") | Wraps in the header, its numbers following in the same run of text. The controls line is unchanged |
| Three riders and Critical | Attack, Damage and Critical on the first line, the riders after them, two to a line (`p-dice-player-long`) |
| A creature with 20 or more rolls (Thorn, 22) | Mostly two lines a roll (84 px). The panel is 2,784 px on a phone, from 3,044 (Appendix A) |
| 130% on a 390 px phone | Saves and checks stay three columns. A tag that does not fit goes under its words. A weapon row is three lines when a rider joins |
| 375 x 667 | The header line, the roller and "Rolls for" fill the first screen as today. The panel is 2,870 px, from 3,044 |
| 844 x 390 | The 340 px side sheet: cells 100 px, "Str +4" and a tag fit |
| A spell with a save and no damage, for a player | Its header reads "DC 14 Wis", and no controls line |
| A monster's long clause rider | "With Advantage" on its toggle, "+1d4 with Advantage" in the header, the clause in its name |
| A refusal | In the header line, in `dangerText`. The cell's words come back |
| Offline, or view as a player | Every cell disabled with the reason as its tooltip, the panel's note at the top, as today |
| An answer and then a free roll | The header shows the newest, whichever |
| A death save | The header's no-Again form. The tracker's death save boxes as today |

## 9. What must not change

- Every control, its action and its accessible name's first words: "Longsword" for its attack, "Longsword damage", "Critical hit for Longsword's next damage", "Group save, DC 21 Dex", "Initiative". e2e suites that find options by name (`groupsave.e2e.ts`, `tokenpanel.e2e.ts`, `combat.e2e.ts`, `dice.e2e.ts`) keep finding them. A selector that reads a button's visible words ("Damage 1d8+3") moves to its name.
- 44 px targets. A cell with a wrapped tag is taller, never shorter.
- The roll flows: busy, the receipt, refusals restoring the choices, Critical pressing itself, Used, recharge, the slot level, the group save's start and replace.
- The header line's height (40 px) and its tap opening the roll in Recent rolls.

## 10. Tests

- `client/features/dice/compactRows.test.ts` (in the prototype): `presetTag`, `rowSummary` (an attack, a save with and without damage, half on a pass only with damage, healing), `riderText`.
- `options.test.ts`: the group's shared tags (`common`, moved out of RollOptions into options.ts by the build) for Bless alone, Bless with Restrained, and none.
- `useDicePanel` (`flow.test.ts`): `noted` sets the no-Again form, a later roll replaces it, and Again is never offered for it.
- `RollOptions` render test (the house's `html()` pattern, `Button.test.ts`): no result text under any cell after a roll lands, the header line holds it.
- `panelFolds.test.ts` and the token panel doc's tests.
- `PcStatsView` render test: six boxes, the proficient save bold and named.
- The drift scan (`styleDriftScan.test.ts`): no raw gap outside the scale in `features/dice/`, `features/pcstats/` and `panels/TokenPanel.tsx`.
- e2e, the touched files plus `reach`: `dice.e2e.ts` (new: a weapon row on one line at 390 px, the result in the header and none under the button, a save spell's DC, the header line inside its column, an answer's line with no Again), `pcstats.e2e.ts` (LP7-PC-12 at 375 x 667, 130%), `groupsave.e2e.ts` (the fold's words, the Damage label), `tokenpanel.e2e.ts`, `size.e2e.ts`.

## 11. Build plan

Three parts, each its own build with a review, in this order:

1. **Shared pieces**: Icon.tsx's Lucide icons with the credit, `useTooltip`, `Group` in Panel.tsx, the fixture option. Small, and every later part uses them.
2. **The Dice panel and stat blocks** (sections 3, 4, 6, 7): RollOptions, Roller, RecentRolls, useDicePanel and useRollOption (LP7-DICE-10), options.ts's helpers, PcStatsView, PcStatsEditor (LP7-PC-12), GroupSave (LP7-PC-10), Room.tsx (LP7-CHROME-4). FEATURES.md: the Dice panel's compact rows and save DCs.
3. **The Token panel** (its own doc), then the icons across the app (the icons doc 9).

The prototype is the starting point of each: its commits are split along the same lines. What the prototype leaves to the build: the relation keys of the folds, the token panel's sheet link, `panelGroups` as a pure function, the tests above, the e2e selectors, and the icons doc's section 4 beyond the action bar.

## 12. Questions for the project owner

1. **A row's own last result.** Recommended: none, as built. The header line shows every result and stays in view. The alternative keeps a quiet total at the right of the row's header ("17", "9"), one token wide and never a new line, for a player who wants the attack's total after rolling its damage. Either fits point 4.
2. **The roll animation's die**: a d20 from game-icons.net for every roll, or the die the formula rolls most (a d6 for 8d6)? Recommended: the d20 for d20 rolls and a plain d6 for the rest, both from the shipped set, when the animation is designed.
3. **Two cards for one save-ends request.** Recommended: while a save-ends card holds a request, its live card folds to its one-line summary, so Allow and Keep show once. The alternative is today's two cards. This changes which card shows, so it is the owner's call.
4. **The monster block's ability table** three across, as 6.1? Recommended yes, by reading the Markdown's table into the same grid in the block view (no change to the stored text). It touches every SRD block's look, so it waits for a yes.

## Appendix A. Measurements

Measured in the dev room (`?diceui=1`) at a device scale of 1: the panel's content height (`scrollHeight` of its scroller), before (the stacked tip with this pass's fixture, a workspace at `mkoswxyw`) and after (the prototype). `scripts`: the measuring script lives in the session scratchpad, not the repository.

**The Dice panel, px**

| Panel | Size | Before | After | Change |
|---|---|---|---|---|
| Player, Thorn (22 rolls) | 390 x 844 | 3,044 | 2,784 | −260 (−9%) |
| Player, Thorn | 375 x 667 | 3,044 | 2,870 | −174 |
| Player, Thorn | 844 x 390 | 3,167 | 2,891 | −276 |
| Player, Thorn | 390 x 844 at 130% | 3,174 | 2,918 | −256 |
| Player, Thorn | 1280 x 800 | 3,084 | 2,884 | −200 |
| DM, goblin | 390 x 844 | 1,050 | 1,106 | +56 |
| DM, goblin | 1280 x 800 | 1,158 | 1,138 | −20 |
| DM, Adult Red Dragon | 390 x 844 | 1,242 | 1,156 | −86 |
| DM, Adult Red Dragon | 1280 x 800 | 1,254 | 1,168 | −86 |

The goblin's panel is 56 px taller on a phone: its two weapons' rider ("With Advantage", 132 px) no longer fits beside Attack, Damage and Critical (369 of 356 px), and groups stand 12 px apart instead of 8. Today the rider shared a line with Critical, and Critical sat alone on a second line in every other row.

**After one roll**, the panel grows by 150 px before (the header line, the new Recent rolls row, and the result line under the button) and 112 px after (no result line). The first roll of a page adds the header line once, as today: holding its 48 px empty from the start would cost every first screen for a move that happens once a session.

**Rows at 390 x 844, px** (a row from its top line to the next)

| Row | Before | After | Why |
|---|---|---|---|
| Javelin (attack, no rider) | 118 | 84 | Critical joins Attack and Damage |
| Rend (dragon, attack, no rider) | 118 | 84 | Same |
| Cure Wounds (heal, slot level) | 118 | 84 | The slot stepper joins Heal: 144 px wide, from 356 |
| Longsword (one rider) | 118 | 103 | Divine Smite fits beside Critical, its dice in the header. At 1280 x 800 the side panel's column is 328 px and it wraps: 151 |
| Spirit Guardians (save, damage, slot) | 118 | 103 | Damage and the stepper share a line. Its header wraps to two |
| Scimitar (goblin, long rider) | 118 | 132 | The rider takes a second line |
| Sacred Flame (save, damage) | 70 | 84 | The new "DC 14 Dex" in its header, and the row's 8 px above and below |
| Hold Person (save, no damage) | 26 | 40 | It had no line at all: now "DC 14 Wis" |
| Flame Tongue Greatsword of the Burning Dawn (three riders) | 166 | 219 | Its name wraps at 16 px. Its three riders take two lines after Attack, Damage and Critical |

**Other measures**

| What | Before | After |
|---|---|---|
| Saves, six cells and label, 390 x 844 | 112 | 113 |
| Saves at 390 x 844, 130% | 179 | 145 |
| The header line past its column, each side, 390 x 844 | 16 | 0 |
| The same at 130% | 21 | 0 |
| A PC block's abilities, 1280 x 800 | 181 | 116 |
| Token panel, DM on a goblin, 390 x 844 | 1,892 | 1,344 (−29%) |
| Token panel, DM on a goblin, 1280 x 800 | 2,845 | 2,301 (−19%) |
| Token panel, player on Thorn, 390 x 844 | 1,558 | 1,142 (−27%) |
| Token panel, player on Thorn, 390 x 844 at 130% | 1,747 | 1,160 (−34%) |
| Token panel, player on Thorn, 1280 x 800 (stat block open) | 2,914 | 2,437 (−16%) |

Widths of a weapon's controls at 390 x 844 (from the DOM): Attack 70, Damage 81, Critical 74, a rider named "Divine Smite" 116, 4 px apart: 353 px in a 356 px column.
