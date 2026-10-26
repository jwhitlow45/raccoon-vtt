# raccoon-vtt v1: a monster's Uses

A short design for the Uses list of a monster (and any creature with a stat block), wherever it shows. A player character's class resource rows keep their layout, and only their count changes (3.7). Decision D-261026-2, as its seventh amendment leaves it, and D-261026-6 for the words "Legendary Actions".

## 1. The owner's words

1. "I noticed having the pips under the legendary actions/resistance uses is a bit awkward. I think they should be integrated in some way to look more cohesive"
2. "I actually think doing the pc layout for the uses section of monsters is great, however maybe we do the pips in place of the x of y (but non interactive/not adjust via touch). Fully open to ideas here I just think we may be able to use some unification here"
3. "We could even right align the pips to make them visually distinguished"
4. "Pc meaning player character"
5. "Actually for legendary actions those can just be various buttons for each ability all under a single section so they don't take up a ton of space"
6. "Tbh please run a quick design overview of the monster uses section. I like the player one as is"
7. After the mockups: "Mockups look good I think the player character uses should also get the pips when an ability has less than some number of uses (probably 5 or less)"
8. "Also why is resistances capitalized not not actions in legendary actions"

## 2. Today

`CombatUses` (list form in the Token panel's Uses, the tracker row's Uses group and the token bar's Uses drawer, card form on the turn card) gives each use a 14 px line of words with "x of y" in it, then its buttons. For the DM, `LegendaryPips` adds two more blocks under the list in the panel and the tracker row (not the drawer): "Legendary Actions used: 1 of 3" and "Legendary Resistances used today: 0 of 3", each over a row of tappable 44 px pips, filled for used. The same count shows twice, in two meanings. Measured at 390 x 844, the Aboleth's Uses section is 367 px tall and the Adult Red Dragon's 415 px.

## 3. The proposal

### 3.1 One title line for every use

Each row opens with a title line: the name at the left, in bold at 16 px (the character row's size), and at the right end the count as pips, or a recharge's state in words. Under it, the row's buttons on a line of their own, 44 px, each starting at its words' width and growing to fill its line, as today. Rows stand 12 px apart (the character list's gap), the title 4 px over its buttons. The separate pips blocks go.

- **Pips** show the count and take no taps. 14 px circles with a 2 px accent ring, 4 px apart, filled accent for each use **left**, filled first from the left. They stand in place of "x of y", which leaves the words.
- **Counts over 6** show "x of y" in muted words where the pips would stand ("7 of 10").
- **A long name** wraps onto a second line beside its pips, so the pips keep the first line's right end. The mock gave the name a 50% flex-basis, which leaves room for 5 pips (86 px) in the tracker row's narrowest line, about 205 px at 320 x 568 and 130%. Six pips (104 px) do not fit beside half that line, so with the limit at 6 the name's basis is its longest word instead: it wraps beside the pips, and the pips drop to the next line, as one part at its right end, only where that word and the pips cannot share a line (the Tarrasque's "Legendary Resistance" with 6 pips at 320 x 568 and 130%).
- **The gaps around the rows**: the list's box (`data-combat-uses`) stands its parts 12 px apart, as its rows, so a companion's class resources start 12 px under the block's last row. The status line and "Loading the uses…" then stand 12 px under the rows too.

### 3.2 Each kind of use

| Use | Title line | Buttons (list) | Buttons (turn card) |
|---|---|---|---|
| Legendary Actions | **Legendary Actions** with pips | One per action by name ("Lash", "Psychic Drain", "Wing Attack (2)" for a cost of 2), then **Restore**, off while full. With no block to read: "Spend a Legendary Action" | None. A muted line under the title: "After other creatures' turns" |
| Legendary Resistance | **Legendary Resistance** with pips | **Use**, **Restore** | **Use** |
| X/Day | **Dominate Mind, 2/Day** with pips | **Use**, **Restore** | **Use**, none with nothing left |
| Recharge | **Fire Breath, Recharge 5–6**, state at the right: "Ready", "Used", "Rolled 5: ready", "Rolled 2: used" | Ready: **Use**. Used: **Roll recharge**, **Mark ready** | Ready: **Use** |
| After a rest | **Phantasms, after a rest**, state at the right | Ready: **Use**. Used: **Mark ready** | Ready: **Use** |
| Mark the block no longer lists | "Frost Breath, used" as today | **Restore** | Not on the card |
| Regeneration, skipped prompts | As today | As today | As today |

Off buttons keep today's words and behavior: "After another creature's turn", "Until the start of its next turn", "Needs 2", "None left", "No Legendary Resistance left.", "No uses of Dominate Mind left.".

### 3.3 Hand correction

The pips no longer set a count, so **Restore** is the hand correction. On Legendary Actions, Legendary Resistance and X/Day it is always there in the list, off while the count is full ("Legendary Actions are full.", "Legendary Resistance is full.", "Dominate Mind is full."), as on a character's row, so the row never changes shape at the first tap (D-261026-2's seventh amendment). It stays usable on the creature's own turn, as a correction, though the actions themselves are off then.

Restore keeps today's behavior. On Legendary Actions it gives back the first once-a-turn action still marked, clearing its mark and giving back that action's cost, so it may give back more than one. Only with no such mark does it give back one. On the creature's own turn it gives back one plain pip and leaves any once-a-turn mark, since `legendaryOff` says "ownTurn" before "once", so no button reads as once-marked then. Play cannot leave a count spent on the creature's own turn (its turn's start refills it), so the case's test sets one with a `token.update` of `actionsUsed`. So when Fiery Rays (once a turn) was taken and then Pounce was mis-tapped, Restore frees Fiery Rays, not Pounce. The exact correction for a mis-tap is **Undo**, since each Use and Restore is its own undo step. A count too high is corrected by the use itself, which is what happened at the table. Each correction is now a logged use or restore, which the old pips never were.

### 3.4 Order

As today: Legendary Resistance, Legendary Actions, then the block's abilities in its order, with Regeneration among them where the block lists it, then the marks it no longer lists, the turn's skipped prompts, then a companion's class resources. This matches the stat block, where Legendary Resistance is a trait at the top, and the turn card.

### 3.5 Who sees it

The DM, and players who own or are lent the monster, as today (`useUsesPresence`). Everyone who sees the list sees the same rows, pips included. A lent monster's owner already reads these counts as "x of y" today, so nothing new reaches a player. Players who do not own the monster still see no Uses. The projection, ops and permissions do not change.

### 3.6 Surfaces

One change in `UseLine` reaches every surface: the Token panel's Uses (Combat group), the tracker row's Uses group (a companion's row too), the token bar's Uses drawer, and the turn card. The tracker row's chips ("Fire Breath used", "Dominate Mind 1/2") and the Dice panel's X/Day row ("2/Day, 1 left") are not the Uses list and do not change. Stats keeps "Legendary Actions per round" and "Legendary Resistance per day".

### 3.7 A player character's class resources

The owner's seventh line (D-261026-2's fifth and sixth amendments). A class resource row keeps its layout: the bold name, the "comes back" line, then Use, Restore and Edit. Only the count changes. Where the resource's most is 6 or fewer, "2 of 3" becomes the same display-only pips, at the right end of the name's line, filled for each use left, with the same spoken words ("Rage, 2 of 3 left"). Over 6 (Lay on Hands, sorcery points), the row is as today, its words beside the name. One limit, 6, for monsters and characters.

## 4. Decisions, with rejected options

- **Filled pips are uses left**, since they stand where "x of y" (x left) stood. Rejected: filled for used, the old DM pips' meaning. Those pips go entirely, so no pips and no bare count in the app read the other way: the tracker row's chips "LA 2/3", "LR 2/3" and "Dominate Mind 1/2" already count what is left. Stats' hints ("1 of 3 used") and an unlisted mark's row ("Dominate Mind, 1 of 2 used") count used, but say "used" in words. The death save pips count successes and failures, not uses.
- **Legendary Actions buttons start at their words' width and grow to fill their line.** Each line ends on the pips' right edge, and a button that wraps alone fills its line. Rejected: buttons that keep their words' width. Built and measured, they leave a ragged edge under the pips (6 to 102 px short of it), and at 130% Restore wraps alone (the sweep's wrap-orphan, 62 px). Growing adds no line, since a flex line breaks on the words' width.
- **Pips for counts up to 6** (D-261026-2's sixth amendment). 2024 counts that top out at 6 (Rage at level 17, Superiority Dice at 15, Favored Enemy at 17, the Tarrasque's Legendary Resistance) then stay pips all campaign. Rejected: 5, the mock's limit, which turns those four to words late in a campaign, and 8, wider than a phone line needs. Legendary Actions reach 4 in a lair, X/Day 4.
- **No "comes back" line** under monster rows. Rejected: the character row's "Back on a Long Rest" line, a line per row for what a DM knows, against "they don't take up a ton of space".
- **Restore always on Legendary Actions, Legendary Resistance and X/Day, off when full.** Rejected: Restore only while spent, which today turns a full-width Use into two half buttons at the first tap.
- **Restore as today, Undo for exact corrections** (3.3). Rejected: a separate count-only control, since the owner asked for pips that take no taps, and the block would grow.
- **A recharge's state at the right end**, where the pips stand on counted rows. Rejected: after the name, as today.
- **The character row's 16 px title and 12 px gaps.** Rejected: today's 14 px and 4 px, which the owner's screenshot shows crowded.
- **Order kept.** Rejected: Legendary Actions first. They are tapped most, but the section is now short enough that order costs no scroll, and the card and stat block read Resistance first.
- **The same rows for the DM and owners.** Rejected: DM-only pips (the first plan), since the pips only restate a count owners already read.
- **"Legendary Actions"** with a capital A, as the 2024 rules write the term and as "Legendary Resistance" stands (D-261026-6), and "Legendary Action" in capitals wherever the app writes the game term, singular too: the button names ("Use Lash, Legendary Action, 2 left", "Spend a Legendary Action", "Restore one Legendary Action"), an off button's words ("A Legendary Action: after another creature's turn."), the refusal ("No Legendary Actions left."), the undo label ("using a Legendary Action for Adult Red Dragon") and the log ("Adult Red Dragon used Fiery Rays, a Legendary Action."). A log line is worded from its stored event each time it is read (`shared/logText.ts` `useText`), so older lines read with the capitals too and no stored line is rewritten. Rejected: lowering "Legendary resistance", the stat block's own name.

## 5. UI checklist

- **Words shown**: as 3.2, 3.1 and 3.7. Nothing else on screen changes.
- **Keys and focus**: the pips take no focus, so the DM's Tab no longer stops on up to 20 pips. Off buttons keep their focus and say why on a tap, as today. Restore stays after the last restore, now on Legendary Actions too, so focus stays on it.
- **Screen readers**: the pips are `aria-hidden`. The name carries hidden words after it, so a row reads "Legendary Actions, 2 of 3 left", "Legendary Resistance, 3 of 3 left", "Dominate Mind, 2/Day, 1 of 2 left", "Rage, 2 of 3 left", and over 6 "7 of 10 left". A recharge reads "Fire Breath, Recharge 5–6, Used". Button names stay, with "Legendary Action" in capitals (D-261026-6): "Use Lash, Legendary Action, 2 left", "Restore one Legendary Action", "Restore one Legendary Resistance", "Restore one use of Dominate Mind".
- **Loading and busy**: unchanged ("Loading the uses…", busy buttons that refuse a second tap, the status line).
- **Large interface sizes**: measured at 390 x 844, 320 x 568 and 1280 x 800, at 100% and 130%. The sweep found nothing over 1 px, and every pip's right edge sat on its buttons' right edge, 0.0 px off, in all three surfaces.

## 6. Cases

| Case | Expected | Test |
|---|---|---|
| Aboleth, DM, 1 Resistance and 1 Lash spent | Pips ●●○ on both lines, no pips block under the list | UsesSection.test.ts, combatuses.e2e.ts |
| Dragon on another creature's turn | **Legendary Actions** with pips, its three actions and Restore, Fiery Rays off once taken | logic.test.ts, combatuses.e2e.ts |
| Counts set by hand, no block | "Spend a Legendary Action" under the pips | logic.test.ts |
| Legendary Resistance full | Use, and Restore off. A tap on Restore says "Legendary Resistance is full." | combatuses.e2e.ts |
| Dominate Mind full | Restore off. A tap says "Dominate Mind is full." | UsesSection.test.ts |
| Dominate Mind, none left | No pip filled, Use off with its reason, Restore on | logic.test.ts |
| The last restore | Restore turns off and keeps focus | combatuses.e2e.ts |
| Restore on the creature's own turn | On, and it gives one back | UsesSection.test.ts, combatuses.e2e.ts |
| Pounce mis-tapped while Fiery Rays stays spent | Restore clears Fiery Rays' mark, as today. Undo gives back Pounce's exactly | combatuses.e2e.ts |
| Fire Breath used | State "Used" at the right, Roll recharge and Mark ready | logic.test.ts |
| Fire Breath rolled 5 | "Rolled 5: ready" at the right, then "Used" once spent again | logic.test.ts (existing) |
| A count of 6, as the Tarrasque's Legendary Resistance | 6 pips at the right | UsesSection.test.ts |
| A count of 7 | "7 of 7" in words at the right, no pips | UsesSection.test.ts |
| A screen reader on a counted row | "Legendary Actions, 2 of 3 left", pips hidden | UsesSection.test.ts |
| Turn card on the dragon's own turn | Title with pips, "After other creatures' turns", no action buttons | logic.test.ts, combatuses.e2e.ts (shot, and swept at 320 x 568 and 130%) |
| Token bar's drawer, DM | The same rows and pips as the panel | combatuses.e2e.ts |
| A player lent the Aboleth | The same rows with pips, Use and Restore | combatuses.e2e.ts (new step) |
| A player who does not own it | No Uses, as today | usesSurfaces.test.ts (existing) |
| 320 x 568 at 130%, "Legendary Resistance" with 3 pips | The name wraps, the pips keep the first line's right end | alignment sweep in combatuses.e2e.ts |
| A count of 6 in the tracker row and the panel, 320 x 568 and 390 x 844 at 130% | Pips beside a short name, as one part at the right of the next line beside a long one | alignment sweep in combatuses.e2e.ts (new) |
| Thorn's Second Wind (3) and Action Surge (1), a paladin's Lay on Hands (25) | Pips, pips, and "25 of 25" beside the name, each row's layout as before | ResourceRows.test.ts, alignment sweep |
| Restore on Legendary Actions | Gives back the once-a-turn action first, logged | combatuses.e2e.ts (existing) |

## 7. The build

**Code**: `client/features/combat/CombatUses.tsx` (`UseLine`'s title line, a display-only pips part, Restore on Legendary Actions, Legendary Resistance and X/Day off while full, the `pips` slot removed, 12 px gaps), `client/features/combat/logic.ts` (the title words without "x of y", the spoken count words, the limit of 6), `client/features/combat/UsesSection.tsx` and `client/features/encounter/Row.tsx` (no `LegendaryPips`), `client/features/encounter/Pips.tsx` and `Pips.test.ts` (deleted), `client/features/resources/ResourceRows.tsx` (the count as pips, 3.7), `client/features/tokens/StatsSection.tsx` (its comment names the pips as the counts' control).

**Stale words to change with it**: the `CombatUses` header comment (its `pips` slot paragraph, and "legendary actions with their pips"), the `UsesSlots` doc and type, `UsesSection.tsx`'s header comment, `Row.tsx`'s row comment (":65") and `UsesGroup`'s (":946-951"), and the test name in `client/features/tokens/StatsSection.test.ts` ("leaves how many are used to the pips in Uses").

**Tests**: `client/features/combat/logic.test.ts`, `UsesSection.test.ts`, `usesSurfaces.test.ts`, `client/features/resources/ResourceRows.test.ts`, and the e2e files `combatuses`, `combat` (its pips loop), `tokenpanel` (its pips groups) and `classresources` (its counts in words), plus `reach`. The alignment sweep already covers the Uses section, the row group and the drawer through `combatuses`.

**Docs** (the lane's last commit): `FEATURES.md` (Uses, and its pips sentence), `docs/dm-guide.md` (Uses and legendary actions, with a new `uses.webp`, and the two lines that place the legendary pips: the Combat group's Uses and the tracker row's options), `docs/design-v1-token-sections.md` 3.1 (points here), `docs/design-v1-combat-controls.md` (its pips mentions).

## 8. Screenshots

In `monster-uses/`, by stage and view (`phone-100`, `phone-130`, `small-130`, `desk-100`, `desk-130`), monster (`aboleth`, `dragon`, `priest`) and surface (`panel-uses`, `panel-sheet`, `tracker-uses`, `bar-drawer`, `bar-screen`):

- `before-*`: today.
- `proposal-*`: this design, except `proposal-small-130-*`, which show the superseded first try (pips wrapped under "Legendary Resistance", the sweep's kind-height).
- `proposal2-*`: the name with a 50% flex-basis, wrapping beside its pips: `proposal2-small-130-*` (320 x 568) and `proposal2-phone-130-*` (390 x 844), both at 130%. These supersede `proposal-small-130-*`.
- `after-*`: the rejected variant whose legendary action buttons keep their words' width.

The best pair is `before-phone-100-aboleth-panel-sheet.png` and `proposal-phone-100-aboleth-panel-sheet.png`. The Aboleth's section went from 367 to 250 px, the dragon's from 415 to 298 px, and the Aboleth's tracker group from 364 to 246 px. The turn card was not shot at design time. The build shoots it.

## As built

Where the build went its own way, or settled what the design left open:

- **The name's basis is its longest word**, not a 50% flex-basis (3.1). `NameLine` (client/components/CountPips.tsx) gives the name `width: min-content` with `overflow-wrap: break-word`, which, unlike `anywhere`, leaves the longest word as its `min-content`, and still breaks a word longer than the line. The e2e checks the rule at every title line it measures: the pips share the name's line exactly where its longest word, the gap and the pips fit side by side.
- **The pips are one SVG**, `aria-hidden`, a circle for each use, filled in the accent for each one left. As spans, a row of pips read to the alignment sweep as a row of boxes, so Rage's row (3 pips) was taken for kin of Lay on Hands' row with its amount field open, and failed kind-height by 48 px. One picture reads as an icon beside the words, as the pips are.
- **The name stands in an element of its own** inside the bold name, beside the hidden count words, so a search by the name's words alone, as the e2e files' rows by name do, still finds it.
- **A character's row over 6 keeps today's markup exactly**, its words beside its name. Only a row of 6 or fewer takes the shared name line. ResourceRows.test.ts pins both against the markup the build found: only Rage's name line differs, and Lay on Hands' row not at all.
- **Regeneration and skipped prompts take the 16 px title line** too (3.1, "each row"), their words as today. A player character's skipped death save row is one of these, and its words and buttons are as before.
- **Legendary Actions' Restore, off while full, says "Legendary Actions are full."**, as the other counts say theirs.
- **A recharge's state** stands at the right end `aria-hidden`, and the name carries it as hidden words (", Used"), as a count's.
- **"Recharge 5–6" stays on one line.** At 16 px the dragon's "Fire Breath, Recharge 5–6" no longer fits beside "Ready" in its tracker row at 390 x 844 and 130% (253 px for about 255), and a line may break after an en dash, which left the "6" alone on the next line. The range now wraps whole, after "Fire Breath,".
- **"Legendary Action" in capitals** reached three files outside the design's list: shared/logText.ts (the log's words), shared/reducer/uses.ts (the refusal) and server/rooms/undoLabels.ts (the undo label), each with its test.
- **The turn card** (MU-OPUS-06) is measured by the existing sweep in combatuses cu-b-9, at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, which shoots it at each, and cu-b-5 checks its Legendary Actions: the pips, "After other creatures' turns" and no button.
- **Measured** in combatuses (mu-a, s2-cu-a, mu-d) at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%: the Aboleth, the dragon (its counts at a most of 1 to 7 in its row and 3, 6 and 7 in its panel), the Tarrasque's 6, and Thorn's Rage at 6, Second Wind (3), Action Surge (1) and Lay on Hands (25), in their Token panels and tracker rows. Every count ends on its line's right end and its buttons' right edge within 1 px, and the alignment check found nothing over 1 px. The pips share the name's line everywhere but one place: "Legendary Resistance" with 6 pips in a tracker row at 320 x 568 and 130%, where its longest word (110 px), the gap (10 px) and the pips (135 px) need 255 px of a 254 px line, so the pips stand as one part at the next line's right end. In the panel at that size (276 px) they share it, as Rage's 6 do in the row.
- **The alignment sweep** gains the dragon's Token panel Uses as a root (`cu-panel-uses`, e2e/alignmentRoom.ts). Its row group, its bar's drawer, its turn card and Thorn's Uses were roots already.

