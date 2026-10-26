# raccoon-vtt v1: a monster's Uses

A short design for the Uses list of a monster (and any creature with a stat block), wherever it shows. A player character's class resource rows stay exactly as they are. Decision D-261026-2, as its fourth amendment leaves it.

## 1. The owner's words

1. "I noticed having the pips under the legendary actions/resistance uses is a bit awkward. I think they should be integrated in some way to look more cohesive"
2. "I actually think doing the pc layout for the uses section of monsters is great, however maybe we do the pips in place of the x of y (but non interactive/not adjust via touch). Fully open to ideas here I just think we may be able to use some unification here"
3. "We could even right align the pips to make them visually distinguished"
4. "Pc meaning player character"
5. "Actually for legendary actions those can just be various buttons for each ability all under a single section so they don't take up a ton of space"
6. "Tbh please run a quick design overview of the monster uses section. I like the player one as is"

## 2. Today

`CombatUses` (list form in the Token panel's Uses, the tracker row's Uses group and the token bar's Uses drawer, card form on the turn card) gives each use a 14 px line of words with "x of y" in it, then its buttons. For the DM, `LegendaryPips` adds two more blocks under the list in the panel and the tracker row (not the drawer): "Legendary Actions used: 1 of 3" and "Legendary Resistances used today: 0 of 3", each over a row of tappable 44 px pips, filled for used. The same count shows twice, in two meanings. Measured at 390 x 844, the Aboleth's Uses section is 367 px tall and the Adult Red Dragon's 415 px.

## 3. The proposal

### 3.1 One title line for every use

Each row opens with a title line: the name at the left, in bold at 16 px (the character row's size), and at the right end the count as pips, or a recharge's state in words. Under it, the row's buttons on a line of their own, 44 px, each starting at its words' width and growing to fill its line, as today. Rows stand 12 px apart (the character list's gap), the title 4 px over its buttons. The separate pips blocks go.

- **Pips** show the count and take no taps. 14 px circles with a 2 px accent ring, 4 px apart, filled accent for each use **left**, filled first from the left. They stand in place of "x of y", which leaves the words.
- **Counts over 5** show "x of y" in muted words where the pips would stand ("7 of 10").
- **A long name** wraps onto a second line beside its pips, so the pips keep the first line's right end. The name starts at half the line, which leaves room for 5 pips (86 px) in the tracker row's narrowest line, about 205 px at 320 x 568 and 130%.

### 3.2 Each kind of use

| Use | Title line | Buttons (list) | Buttons (turn card) |
|---|---|---|---|
| Legendary actions | **Legendary actions** with pips | One per action by name ("Lash", "Psychic Drain", "Wing Attack (2)" for a cost of 2), then **Restore** only while one is spent. With no block to read: "Spend a legendary action" | None. A muted line under the title: "After other creatures' turns" |
| Legendary Resistance | **Legendary Resistance** with pips | **Use**, **Restore** | **Use** |
| X/Day | **Dominate Mind, 2/Day** with pips | **Use**, **Restore** | **Use**, none with nothing left |
| Recharge | **Fire Breath, Recharge 5–6**, state at the right: "Ready", "Used", "Rolled 5: ready", "Rolled 2: used" | Ready: **Use**. Used: **Roll recharge**, **Mark ready** | Ready: **Use** |
| After a rest | **Phantasms, after a rest**, state at the right | Ready: **Use**. Used: **Mark ready** | Ready: **Use** |
| Mark the block no longer lists | "Frost Breath, used" as today | **Restore** | Not on the card |
| Regeneration, skipped prompts | As today | As today | As today |

Off buttons keep today's words and behavior: "After another creature's turn", "Until the start of its next turn", "Needs 2", "None left", "No Legendary Resistance left.", "No uses of Dominate Mind left.".

### 3.3 Hand correction

The pips no longer set a count, so **Restore** is the hand correction. On Legendary Resistance and X/Day rows it is always there in the list, off while the count is full ("Legendary Resistance is full.", "Dominate Mind is full."), as on a character's row, so the row never changes shape at the first tap. On legendary actions it stays the last button of the block, shown only while one is spent (D-261026-2's third amendment), and it gives back the once-a-turn action first, as today. A count too high is corrected by the use itself, which is what happened at the table. Each correction is now a logged use or restore, which the old pips never were.

### 3.4 Order

As today: Legendary Resistance, legendary actions, then the block's abilities in its order, marks it no longer lists, Regeneration, the turn's skipped prompts, then a companion's class resources. This matches the stat block, where Legendary Resistance is a trait at the top, and the turn card.

### 3.5 Who sees it

The DM, and players who own or are lent the monster, as today (`useUsesPresence`). Everyone who sees the list sees the same rows, pips included. A lent monster's owner already reads these counts as "x of y" today, so nothing new reaches a player. Players who do not own the monster still see no Uses. The projection, ops and permissions do not change.

### 3.6 Surfaces

One change in `UseLine` reaches every surface: the Token panel's Uses (Combat group), the tracker row's Uses group (a companion's row too), the token bar's Uses drawer, and the turn card. The tracker row's chips ("Fire Breath used", "Dominate Mind 1/2") and the Dice panel's X/Day row ("2/Day, 1 left") are not the Uses list and do not change. Stats keeps "Legendary Actions per round" and "Legendary Resistance per day".

## 4. Decisions, with rejected options

- **Filled pips are uses left**, since they stand where "x of y" (x left) stood. Rejected: filled for used, the old DM pips' meaning. Those pips go entirely, so no count of uses in the app reads the other way. The death save pips count successes and failures, not uses.
- **Legendary action buttons start at their words' width and grow to fill their line.** Each line ends on the pips' right edge, and a button that wraps alone fills its line. Rejected: buttons that keep their words' width. Built and measured, they leave a ragged edge under the pips (6 to 102 px short of it), and at 130% Restore wraps alone (the sweep's wrap-orphan, 62 px). Growing adds no line, since a flex line breaks on the words' width.
- **Pips for counts up to 5.** Rejected: up to 8, set while class resources were in scope. At 320 x 568 and 130% a count of 6 to 8 cannot share the name's line in the tracker row, so its row stands taller than a row of the same shape (the sweep's kind-height). In the SRD only the Tarrasque's Legendary Resistance passes 5, and it reads "6 of 6". Legendary actions reach 4 in a lair, X/Day 4.
- **No "comes back" line** under monster rows. Rejected: the character row's "Back on a Long Rest" line, a line per row for what a DM knows, against "they don't take up a ton of space".
- **Restore always on Legendary Resistance and X/Day, off when full.** Rejected: Restore only while spent, which today turns a full-width Use into two half buttons at the first tap.
- **A recharge's state at the right end**, where the pips stand on counted rows. Rejected: after the name, as today.
- **The character row's 16 px title and 12 px gaps.** Rejected: today's 14 px and 4 px, which the owner's screenshot shows crowded.
- **Order kept.** Rejected: legendary actions first. They are tapped most, but the section is now short enough that order costs no scroll, and the card and stat block read Resistance first.
- **The same rows for the DM and owners.** Rejected: DM-only pips (the first plan), since the pips only restate a count owners already read.

## 5. UI checklist

- **Words shown**: as 3.2 and 3.1. Nothing else on screen changes.
- **Keys and focus**: the pips take no focus, so the DM's Tab no longer stops on up to 20 pips. Off buttons keep their focus and say why on a tap, as today. Restore on Legendary Resistance and X/Day stays after the last restore, so focus stays on it. Legendary actions' Restore goes when the count is full, and focus moves as `usesFocusTarget` already moves it.
- **Screen readers**: the pips are `aria-hidden`. The name carries hidden words after it, so a row reads "Legendary actions, 2 of 3 left", "Legendary Resistance, 3 of 3 left", "Dominate Mind, 2/Day, 1 of 2 left", and over 5 "7 of 10 left". A recharge reads "Fire Breath, Recharge 5–6, Used". Button names stay: "Use Lash, legendary action, 2 left", "Restore one Legendary Resistance", "Restore one use of Dominate Mind".
- **Loading and busy**: unchanged ("Loading the uses…", busy buttons that refuse a second tap, the status line).
- **Large interface sizes**: measured at 390 x 844, 320 x 568 and 1280 x 800, at 100% and 130%. The sweep found nothing over 1 px, and every pip's right edge sat on its buttons' right edge, 0.0 px off, in all three surfaces.

## 6. Cases

| Case | Expected | Test |
|---|---|---|
| Aboleth, DM, 1 Resistance and 1 Lash spent | Pips ●●○ on both lines, no pips block under the list | UsesSection.test.ts, combatuses.e2e.ts |
| Dragon on another creature's turn | **Legendary actions** with pips, its three actions and Restore, Fiery Rays off once taken | logic.test.ts, combatuses.e2e.ts |
| Counts set by hand, no block | "Spend a legendary action" under the pips | logic.test.ts |
| Legendary Resistance full | Use, and Restore off. A tap on Restore says "Legendary Resistance is full." | combatuses.e2e.ts |
| Dominate Mind, none left | No pip filled, Use off with its reason, Restore on | logic.test.ts |
| Fire Breath used | State "Used" at the right, Roll recharge and Mark ready | logic.test.ts |
| Fire Breath rolled 5 | "Rolled 5: ready" at the right, then "Used" once spent again | logic.test.ts (existing) |
| A count of 6 or more, as the Tarrasque's Legendary Resistance | "6 of 6" at the right, no pips | logic.test.ts |
| A screen reader on a counted row | "Legendary actions, 2 of 3 left", pips hidden | UsesSection.test.ts |
| Turn card on the dragon's own turn | Title with pips, "After other creatures' turns", no action buttons | logic.test.ts, combatuses.e2e.ts |
| Token bar's drawer, DM | The same rows and pips as the panel | combatuses.e2e.ts |
| A player lent the Aboleth | The same rows with pips, Use and Restore | combatuses.e2e.ts (new step) |
| A player who does not own it | No Uses, as today | usesSurfaces.test.ts (existing) |
| 320 x 568 at 130%, "Legendary Resistance" | The name wraps, the pips keep the first line's right end | alignment sweep in combatuses.e2e.ts |
| 320 x 568 at 130%, a count of 5 in the tracker row | The pips share the name's line (computed, not yet shot) | alignment sweep in combatuses.e2e.ts (new) |
| Restore on legendary actions | Gives back the once-a-turn action first, logged | combatuses.e2e.ts (existing) |

## 7. The build

**Code**: `client/features/combat/CombatUses.tsx` (`UseLine`'s title line, a display-only pips part, Restore on Legendary Resistance and X/Day, the `pips` slot removed, 12 px row gap), `client/features/combat/logic.ts` (the title words without "x of y", the spoken count words, the limit of 5), `client/features/combat/UsesSection.tsx` and `client/features/encounter/Row.tsx` (no `LegendaryPips`), `client/features/encounter/Pips.tsx` and `Pips.test.ts` (deleted), `client/features/tokens/StatsSection.tsx` (its comment names the pips as the counts' control).

**Tests**: `client/features/combat/logic.test.ts`, `UsesSection.test.ts`, `usesSurfaces.test.ts`, and the e2e files `combatuses`, `combat` (its pips loop) and `tokenpanel` (its pips groups), plus `reach`. The alignment sweep already covers the Uses section, the row group and the drawer through `combatuses`.

**Docs** (the lane's last commit): `FEATURES.md` (Uses), `docs/dm-guide.md` (Uses and legendary actions, with a new `uses.webp`), `docs/design-v1-token-sections.md` 3.1 (points here), `docs/design-v1-combat-controls.md` (its pips mentions).

## 8. Screenshots

In `monster-uses/`, by stage and view (`phone-100`, `phone-130`, `small-130`, `desk-100`, `desk-130`), monster (`aboleth`, `dragon`, `priest`) and surface (`panel-uses`, `panel-sheet`, `tracker-uses`, `bar-drawer`, `bar-screen`):

- `before-*`: today.
- `proposal-*`: this design, with `proposal2-*` for the wrapped name at 320 x 568 and 130%.
- `after-*`: the rejected variant whose legendary action buttons keep their words' width.

The best pair is `before-phone-100-aboleth-panel-sheet.png` and `proposal-phone-100-aboleth-panel-sheet.png`. The Aboleth's section went from 367 to 250 px, the dragon's from 415 to 298 px, and the Aboleth's tracker group from 364 to 246 px.

## As built

(The builder fills this in.)
