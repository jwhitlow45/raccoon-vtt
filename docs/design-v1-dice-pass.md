# raccoon-vtt v1: a dice page pass, with collapsible sections and a creature card

Status: draft 3, for design review. Revised after round 1 (DP-O1 to DP-O14, DP-ASTRA-01 to 05) and round 2 (DP-O15, DP-O16, DP-ASTRA-06, DP-ASTRA-07). Code is cited from main at `ac82b9e3`.

The project owner asked on 2026-10-23: "Also the dice page should have collapsible sections, and the player/companion section should be more distinct from the adv/dis/secret tiles. I think in general the dice section could use a ui ux pass". Two earlier rulings bound it. The D&D Beyond look applies to the dice ("The dnd beyond look was mainly around the dice everything else can be relative to have we've decided before"), so this page may follow D&D Beyond's dice and roll screens more closely than the rest of the app. And alignment is measured in the browser: nothing may be off by more than 1 px.

This pass changes layout, grouping and look. It adds no op, no room data and no roll behavior. Every roll still goes where it goes today, with the same words in its accessible name.

## Scope

- **In**: the Dice panel (`client/features/dice/`): the sticky result line, the roller, the Adv, Dis and Secret tiles, the creature picker, a creature's options (saves and checks, skills, Initiative, Death Save, Traits, Actions, Bonus Actions, Reactions, Legendary Actions, Spells), several selected creatures, the group save's launch and its open notice, the Ask switch that requests a roll, Recent rolls, and how the panel opens from a token's Roll.
- **Out**: the request sheet and cards (`features/rolls/`), the group save page itself, the roll animation, and the combat uses that docs/design-v1-combat-controls.md (in design) adds. Section 6.7 says why this pass builds nothing for them.
- **Sizes looked at**: 1440 x 900 and 1024 x 768 with a mouse, 390 x 844 and 440 x 956 on touch, plus 390 x 844 and 320 x 568 at 130% where words wrapped.

Screenshots: `screenshots/dice-pass/`, kept outside the repository. Names are `<size>-<viewer>-<creature>-<page>`: `d1440`, `d1024`, `p390`, `p440`, `p390-s130` and `p320-s130`, then `dm` or `player`, then `dragon` (an Adult Black Dragon, whose legendary Cloud of Insects rolls), `thorn` (a level 5 paladin with 22 rolls, spells and three riders), `wolf` (Thorn's companion from the SRD), `group` (two goblins and the Owlbear), `owlbear-bar` and `-bar-roll` (a token's Roll), `groupsave-*`, `none`. A long panel is shot page by page (`-01`, `-02`). The fixture is the dev room at `/dev/room?diceui=1`, with the wolf and the dragon added through ops. Measurements come from the DOM and from the alignment helper (`e2e/helpers/alignment.ts`) run on the panel in the same room.

## 1. What the audit found

Ranked by what each costs at the table. Section 7 holds each fix with its size.

| # | Finding | Measured or seen | Fix |
|---|---|---|---|
| 1 | The creature picker reads as more roll modes | A player's "Thorn" and "Wolf" chips sit 8 px under Adv, Dis and Secret, the same 44 px pills with the same pressed look, and no visible label ("Roll for" is only the group's name). Three rows of like pills in a row: quick dice, modes, creatures (`p390-player-thorn-01`) | 4, 5 |
| 2 | Long scrolls | A player's Thorn is 3,033 px at 390 x 844, 6.8 heights of the 444 px sheet. Actions start 646 px down, below the first screen, Spells at 1,502, Recent rolls at 2,786. At 320 x 568 at 130% it is 3,761 px in a 191 px scroller. The dragon is 1,337 px, its Legendary Actions at 866 | 6 |
| 3 | Advantage is far from the attack | Adv and Dis sit at the top. Thorn's Longsword sits 1,097 px below them and Spiritual Weapon 2,126 px, so a player scrolls up to press Adv, then back down | 6 and 8, partly (choice 7) |
| 4 | A token's Roll cuts the roll modes | The panel lands 4 px into the Adv, Dis and Secret row (scroll 137, row at 133 on a phone, 149 and 145 on a computer), its top edge gone, and after a roll the sticky line covers it whole (`p390-dm-owlbear-bar-roll`, `d1440-player-thorn-bar-roll`) | 8 |
| 5 | Weak hierarchy | "Rolls for Thorn" is a 16 px line in a row title's weight, with no picture. The roller and the options part by the same 8 px as the chips inside the roller | 5, 7.1 |
| 6 | Initiative stands apart and its tag runs on | Initiative sits after the Skills fold in two of three columns, the third empty. The Exhausted Owlbear's tag reads "replaces 12 -4" | 5.1, 7.5 |
| 7 | One part alone on a line | The alignment check's wrap rule, 48 px each: Hunter's Mark under Flame Tongue and Divine Smite at 390 px, Divine Smite under Longsword's three at 1440, and the slot steppers of Spiritual Weapon, Spirit Guardians, Thunderous Smite and Wrathful Smite at 1440 | 7.2 |
| 8 | Two button outlines in one line | Attack, Damage and the save cells take the control outline (`controlBorder`). Group save and Ask for saves, in the same line, take the raised look's dim `border` (`d1440-dm-dragon-02`) | 7.3 |
| 9 | The sticky line is off its middle | Its words sit 16 px under its top and 0 over its foot at 1440 (8 px off), 4 and 0 at 390 (2 px) | 7.4 |
| 10 | Recent rolls rows are uneven | At 1440 a row's words sit 10 px under its top and 38 over its foot, Again 12 px below their first line, and rows of one line are 41, 61 and 65 px tall. "Older rolls are in the Log" starts 13 px inside the column | 7.6 |
| 11 | Quick dice start off the column | The d20 starts 3 px right of the field's edge at every size (the strip's room for a focus ring) | 7.7 |
| 12 | Several selected wrap badly | "STR save for 3" takes two lines at 390 px and three at 130% ("STR / save for / 3"), while "INT save / for 3" breaks elsewhere. "Saves" and "Checks" are a fourth label look: sentence case, weight 600 (`p390-s130-dm-group-02`) | 5.3 |
| 13 | The open group save is easy to miss | A plain sentence, "Acid Breath's save: set up.", between the roll modes and the creature (`p390-dm-groupsave-open-banner`) | 7.8 |
| 14 | Two fold looks in one panel | Skills folds behind a 13 px capitals label, the look the token panel moved away from. With its gaps it costs 85 px | 6 |
| 15 | The placeholder is cut | At 320 x 568 at 130% it reads "1d20+5 or 2d6+3 f" | 7.9 |

Seen and left to the combat controls design: legendary actions with no dice appear nowhere, so the Adult Red Dragon (Commanding Presence, Fiery Rays, Pounce) shows no Legendary Actions group at all, and rows a player keeps for a resource, such as "Lay on Hands" with a flat 25, show only a name.

Touch targets pass: every control is at least 44 px, and fold rows will be 48. No hover or long press is needed anywhere.

## 2. What matters most in combat

- **A player**: their attacks and spells, Advantage or Disadvantage on the next one, the result, then Initiative at the start of a fight and a Death Save while dying. Saves mostly come through request cards, which roll them. An ask also opens the group (6.4). Skills and checks are rarer mid-fight.
- **The DM**: the selected monster's actions and legendary actions, its saves when a spell lands outside an area, Initiative, and the group save from a save action.
- **Both**: knowing at a glance whose rolls these are.

So the creature's name, Initiative and the Death Save never fold, actions start open everywhere, and on a phone the saves and checks fold to one row near the top, a tap away.

## 3. The panel, top to bottom

| Part | Today | After |
|---|---|---|
| Sticky result line | As today | Its words centered in its painted box (7.4) |
| Roller | Field and Roll, the reading line, quick dice | The same, the quick dice on the column's edge (7.7) |
| Roll modes | Adv, Dis and Secret as three loose chips | One group, "Next roll" (4) |
| Open group save | A plain sentence | An info notice with Open (7.8) |
| Creature | Picker chips, then "Rolls for Thorn" | The creature card: picture, name, kind line, Ask switch, Death Save, Initiative, with a player's creatures as tabs (5) |
| Options | Saves, Checks, a Skills fold, Initiative, then labelled groups | Folding groups in today's order, Initiative gone to the card (6) |
| Recent rolls | A labelled list | A folding group, rows evened (7.6) |

The roller block and the options part by a 1 px line with 16 px above and below, the panel's section boundary (docs/design-v1-dice-ui.md 3.1). Inside each block, today's 8 px stays.

## 4. The roll mode group

One row under the quick dice, `role="group"` named "For the next roll" as today, marked `data-dice-modes`:

- **"Next roll"** at its start, in the section label look (13 px, weight 700, capitals, muted), centered on the controls' middle.
- **Adv and Dis joined**: one pill outline 44 px tall, split by a 1 px line, each half a toggle (`aria-pressed`) named "Advantage" and "Disadvantage" as today. They stay exclusive: pressing one lets go of the other. The joined look says they are one choice of two, as D&D Beyond puts Advantage and Disadvantage in one roll menu.
- **Secret apart**, 8 px after the pair, the pill with its eye icon as today, named as today ("Hide from players" for a DM, "Only the DM sees it" for a player). It answers a different question, who sees the roll, so it stands on its own.
- **Pressed looks**: the app's pressed look (accent outline and tint) on all three. The pair's split line stays visible when one half is pressed.
- **Width**: 70 + 116 + 90 px and 16 px of gaps fit in a 356 px column. Where they do not, at 390 x 844 at 130% (a 268 px column) and on smaller phones, Secret wraps under and fills its line, which the alignment check's wrap rule allows.

All three stay one-roll choices, taken by the tap that rolls, as FEATURES.md says. The row stays where it is, between the roller and the creature, so it serves both, and section 8 lands a token's Roll on it.

## 5. The creature card

The creature's block becomes a card that cannot be mistaken for a roll mode: the page background (`bg`) inside a 1 px `border` outline, radius `md`, 12 px padding, with the creature's picture. Marked `data-dice-card`. The card draws its header as `CreatureHeader` does (`features/tokens/CreatureHeader.tsx`), from a pure `creatureLook` that builds the picture, the badge and the kind line the way the token panel's private `NameBlock` does (TokenPanel.tsx:246-282). The badge's ring takes the card's fill, not `surface`, so it still parts the badge from the picture.

**Where it renders.** The card's frame, header and tabs render in `RollOptions` (the DM) and `PlayerOptions` (a player), above the keyed `<LoadedOptions key=…>`, with the loaded body as their children. So a tab keeps focus when its pick remounts the body, and the header shows while the options load. The region "Rolls for Thorn" moves up with the frame and wraps the card and the groups, keeping its name for the e2e suites that find it. It stays a region, not a `tabpanel`: the tabs sit inside it and a DM's card has none, so one landmark serves both. Each tab's `aria-controls` still names it.

### 5.1 One creature (the DM, or a player with one)

In this order, each part shown only when it applies:

1. **Header**: the picture at 48 px in its disposition's ring, a companion's carrying its character's portrait as a badge. The name at 18 px weight 700, an `h3`, wrapping. The kind line under it, 13 px muted: "Monster, CR 14 · Huge (15 ft)", "Level 5 character · Medium (5 ft)", "Companion of Thorn · Medium (5 ft)". No tags and no quick numbers: the token panel holds those.
2. **The blocked note** (offline, or viewing as a player), as today.
3. **Ask switch** for a creature a player plays, for the DM: "Ask Thorn to roll saves and checks", as today.
4. **Death Save**, while the creature is dying, full width.
5. **No stat block, or numbers this viewer lacks**: the note, "Add a stat block" for a character the viewer may edit, and the Bonus field with its validation line, as `UnknownNumbers` draws them today. The field sits here because Initiative and every save, check and skill cell read it.
6. **Initiative**, full width: "Initiative +2" with its tag, or "Score 12" and "Roll instead" side by side for a monster in a room that uses scores. With no known bonus it rolls by the Bonus field.

### 5.2 A player with two or more creatures

The picker becomes **tabs across the card's top**: `role="tablist"` named "Roll for", each `role="tab"` named by the creature's name, with its 24 px picture and its name at 16 px weight 600, 44 px tall. The picked tab wears a 2 px accent line under it and the text color, the others muted text and no line. Tabs are not pills, so nothing in the card looks like Adv, Dis or Secret. The tabs stand in for the header's name and picture, so the card does not say "Thorn" twice: under them come the picked creature's kind line, then parts 2 to 6. The strip scrolls sideways with its fades (`ScrollStrip`) when the names do not fit, as the quick dice do.

The pick is kept for the page, as today, and a bar's Roll still picks the token it came from.

### 5.3 Several selected (the DM)

The same card: up to three 32 px pictures overlapping by 8 px, "3 selected" as the `h3`, the names under it as the kind line ("Goblin 1, Goblin 2, Owlbear"), then the DC field, Initiative for the ones in the fight and "Set up a group save", which act on the whole selection. Under the card, groups as section 6: Saves and checks, Skills, Shared attacks. The cells drop their repeated words: "DEX" under the label "SAVES FOR 3", as the one-creature cells read, one line at every size, each keeping its accessible name ("DEX save for 3"), the form `e2e/groupsave.e2e.ts` taps as "DEX save for 4". The labels take the panel's one label look.

A shared attack's state (its AC, the attackers sent, their receipts and the damage tag, today `useState` in `SharedAttack`, GroupOptions.tsx:140-148) moves to a slot keyed by the attack's name within the several-selected view, never by the current selection. Its sent snapshot holds through a selection change while the attack stays shared, as today (GroupOptions.tsx:143-144). It clears when the view goes away (fewer than two selected) or the attack stops being shared, as `SharedAttacks`' filtered, keyed rows drop it today (GroupOptions.tsx:123-130). So folding Shared attacks between Attack and Damage, or before the answer comes, keeps the hits and "Roll damage for 2 hits".

### 5.4 Nothing to show yet

- **No selection** (the DM): the card's frame with "Select a token to roll for it." in muted text.
- **Loading or failed**: the card's header shows at once, and the loading line or the failure sits in its body, so the name never waits on the SRD chunk.
- **A player with no creature**: "Your character's rolls show here once you play one." in the card's frame, the asks above it as today.

## 6. Collapsible sections

### 6.1 The groups

Each section becomes a `Group` (`components/Panel.tsx`), the token panel's fold: a 48 px row, a chevron, the name at 16 px weight 700, a one-line summary at the right while folded, and a 1 px line above. The order is today's, less Initiative:

1. **Saves and checks**: the two grids, each under its capitals label with its note ("SAVES  asks Thorn. +1d4: Blessed").
2. **Skills**: today's grid.
3. **Traits**, **Actions**, **Bonus Actions**, **Reactions**, **Legendary Actions**: each only when it holds a row, as today. Actions opens with the Multiattack line, and every group's shared note ("Attacks +1d4: Blessed") is its first line inside.
4. **Spells**: "Save DC 14. Spell attack" first, then the rows. Where a creature's spells span two levels or more, each level gets a capitals label ("CANTRIPS", "LEVEL 1"), as a sheet groups them. A spell with no level (`NamedRoll.level` is optional, as for a monster's "1/Day" spells) goes under a last "OTHER" label. When no spell has a level, no labels show.
5. **Recent rolls**: the panel's own list, last.

A group with nothing in it is not drawn, so a goblin shows no Spells row.

### 6.2 How each group starts

"Computer" is a layout at least 900 px wide and 600 tall, as the token panel's `foldDefaults` reads it. Below that, "Phone", sideways phones included. The starts are the same for every kind of creature. Only the memory is kept apart by kind (6.3).

| Group | Computer | Phone | Why |
|---|---|---|---|
| Saves and checks | open | folded | On a phone it is 250 px before the first action. An ask opens it (6.4) |
| Skills | folded | folded | As today: 18 cells, used out of combat |
| Traits | folded | folded | Only traits with dice show, and they are rare and passive |
| Actions, Bonus Actions, Reactions, Legendary Actions | open | open | What a turn uses |
| Spells | open | open | A caster's turn |
| Recent rolls | open | open | Short, and where a result is reread |
| Several selected: Saves and checks | open | open | Why the DM selected several |
| Several selected: Skills | folded | folded | As today |
| Several selected: Shared attacks | open | open | Rare, short |

With these, a player's Thorn on a 390 px phone opens on the card, two folded rows and the head of Actions, and the token's Roll lands with the Actions row in view (section 8).

### 6.3 Remembered per device and per kind

- A new module, `features/dice/diceFolds.ts`, keeps the folds in `rvtt.diceFolds` in this device's storage, never sent to the room, in the pattern of `features/tokens/panelFolds.ts`: plain functions for node tests, resolved once per Room page so a crossing of 900 px never refolds, a slot in the Room scope, `useDiceFolds()`.
- Keys are `<kind>.<group>`, with three kinds: `pc` (a character, on its token or picked by a player), `companion` (a token with `companion`), and `monster` (every other creature, NPCs and objects included). Several selected use `group.<group>`. Recent rolls is one key for the device, `recent`. So folding a monster's Saves and checks never folds a character's.
- A key never tapped follows 6.2's start at the layout where the page opened. Bad JSON, a missing key or storage that throws falls back to the starts, and a blocked storage keeps a tap for the page only.
- "View as a player" reads the folds and never writes them, as the token panel's do.
- The Dice panel's folds are not the token panel's: the stat block there and the groups here hold different things, so sharing a key would fold one by tapping the other.

### 6.4 Opened by the app

Three things open a group without a tap and without writing storage. Each opens it once, on the render that first sees it, as `seenAsks` does for Skills today (RollOptions.tsx:216-221). The opening goes into the in-memory folds for that kind, for the page, so the group stays open after the answer, and the viewer may fold it again. The ids already seen live in the dice folds slot (Room scope) beside those folds, not in component state, so a tab pick that remounts the body, or a phone's Dice sheet closing, never reopens a group the viewer folded. A tap on a fold row is the viewer's and is written, outside "view as a player".

1. **A new ask for one of this creature's saves or checks** opens Saves and checks, as a skill's opens Skills today (LP9-DICE-3). Its cell shows "Asked". It opens the group in the asked creature's own fold kind (`foldKind`): `pc`, `companion`, or `monster` for a lent NPC, a summon or a beast a player owns (`playerCreatures`, options.ts:117-123).
2. **A new cast block** (a player's open ask for saves, under its spell's row) opens the group that holds the row. A cast's identity is its opening: `openedBlock` stamps each opening with a new number from the option store, so reopening the same spell counts as new. A sent ask first seen after a reload is new by its ask id.
3. **A tap on the sticky result line** opens a folded Recent rolls, then reveals the row once it has rendered, as `DicePanel`'s `show` does today. A second tap after the viewer folds it again does the same.

While an ask or a cast waits in a group the viewer folded, its summary starts with it: "Asked: DEX save", "Ask for saves waiting: Fireball".

### 6.5 Folded summaries

One line, 13 px muted, cut with "…", read by a screen reader as the fold's description (`aria-describedby`):

- **Saves and checks**: the shared notes first, then the six saves: "asks Thorn · Str +4, Dex +1, Con +3, Int +0, Wis +5, Cha +7".
- **Skills**: the ones above their ability's check, so the trained ones: "Athletics +6, Insight +4, Persuasion +6". None for a creature with none.
- **Traits** and the action groups: the rows' names, "Rend, Acid Breath (used)".
- **Spells**: "DC 14 · +6 to hit · 13 spells".
- **Recent rolls**: the newest, "Thorn 20 Longsword".

A pure `foldSummary` in `options.ts` builds them, with unit tests.

### 6.6 Keyboard and screen reader

- **Folds**: each fold row is one disclosure button inside an `h3`, named by the group's name alone so the name never changes with its state, with `aria-expanded` and the summary as its description. Tab reaches it, and Enter or Space toggles it. Focus stays on it. A folded group's controls are not drawn, so they leave the tab order and the accessibility tree. A fold the app opens (6.4) never moves focus.
- **State a fold keeps**: a folded group's controls unmount, so anything a fold must not lose lives in the option store or above the group: a shared attack in flight (5.3) and typed text the next roll uses (the Bonus field, in the card). A confirmation may drop, such as Group save's replace prompt, since its tap asks again.
- **Headings**: the creature's name and the group rows are `h3`s, so a screen reader's heading keys walk Thorn, Saves and checks, Skills, Actions, Spells, Recent rolls. The capitals labels inside a group are `h4`s, as in the token panel.
- **Creature tabs**: one Tab stop on the picked tab. Left and Right move to the next or previous creature and pick it, Home and End to the first and last. Each tab's `aria-controls` names the options region. The picked creature's region is "Rolls for Wolf".
- **Roll modes**: three toggles in one named group, each with `aria-pressed`, in reading order Adv, Dis, Secret. The visible "Next roll" sits inside the group's name "For the next roll", so a voice user who says what they see finds it.
- **Shortcut sheet**: the creature tabs' keys join the Dice table in `client/state/shortcuts.ts` and FEATURES.md ("Left, Right, Home, End: pick another creature to roll for", everyone, in the Dice panel's creature tabs).

### 6.7 Combat uses

Combat uses live in the combat section, the tracker row, the token pop-up and a turn card (the project owner's choice of 2026-10-23), not here. This pass builds nothing for them and reserves no blank space. `Group` draws an absent `action` as nothing, and a row's header keeps Used where it is, so a later change can add to either without moving this layout.

## 7. Everything else

Each is small (S, under 50 changed lines).

- **7.1 Spacing between the blocks.** The roller block (field, reading line, quick dice, roll modes) and the creature card part by a line with 16 px each side. Inside, the existing 8 px stays. The reading line keeps its reserved height (the project owner: "prevent the buttons from being shifted down").
- **7.2 Controls lines fill their lines.** A named row's controls line follows the polish pass's rule (decision 2 of 2026-10-23): its buttons, chips and slot stepper grow to share each line, at every size, so Hunter's Mark or a stepper never stands alone. A lone part fills its line, which the alignment check passes. The words inside stay centered.
- **7.3 One outline for a row's buttons.** Group save and Ask for saves take the option buttons' look (`OptionCell`: `controlBorder` outline, raised fill, 14 px weight 600), since they act beside Attack and Damage. Ask for saves is a plain `Button size="sm"` in `cast/CastBlock.tsx`, so it gains that look there. Toggles keep the pill look (Critical, riders, Used), which tells a toggle from an action.
- **7.4 The sticky line's middle.** The line takes back the pane's top padding so nothing scrolls past above it. Its 44 px row now sits in the middle of the painted box that includes that padding: half the padding above it and half below, resting or stuck. The line stays one height, before, during and after a throw.
- **7.5 Initiative's tag.** What the tap does to the tracker, then the preset, parted by " · ": "replaces 12 · −4", with the typographic minus the cells use.
- **7.6 Recent rolls.** A row's first line of words meets Again's middle, so a one-line row is one 44 px line with 8 px above and below. A row with no Again keeps the same 44 px floor. "Older rolls are in the Log" starts on the column's edge, a quiet button whose padding reaches outside its words, as "Companion of Thorn" does.
- **7.7 Quick dice on the column.** The strip keeps its 3 px of room for the first and last focus ring, and sits 3 px wider on each side, inside the pane's padding, so the d20 starts on the field's edge. This is the second exception to the dice UI pass's rule 5 (no negative margin past the content box), after the sticky line's top, for the same reason: a box that must be wider than what it shows.
- **7.8 The open group save.** "Acid Breath's save: set up." becomes an info `Notice` with Open as its action, between the roll modes and the creature card, so a DM sees an unfinished group save as a status.
- **7.9 The narrow placeholder.** Under 300 px of field the placeholder is "1d20+5", and "1d20+5 or 2d6+3 fire" above that.

## 8. How it opens from a token's Roll

A token's Roll, a selection change and a bar's Roll for a group still open the panel and scroll it (docs/design-v1-roll-options.md 4.1). The scroll now lands with the roll mode row at the scroller's top, under the sticky line when there is one, so Adv, Dis and Secret are whole and the card follows them. Where the panel already shows that row and the card whole, it does not move. Reduced motion jumps as today.

On a 390 px phone that leaves the modes, the card, the folded Saves and checks and Skills, and the head of Actions in the sheet's 444 px.

## 9. What must not change

- Every control, its action and its accessible name: "Advantage", "Disadvantage", "Dexterity save, …", "Longsword", "Longsword damage", "Group save, DC 18 DEX", "DEX save for 3", "Initiative, …". The region "Rolls for Thorn" and the group "For the next roll".
- The roll flows: busy words in place, results only in the sticky line, Critical pressing itself, Used, the slot level, the group save's start and replace, the Ask switch's ask.
- 44 px targets, 48 px fold rows, 16 px inputs, nothing on hover or long press.
- The reading line's reserved height and the sticky line's height.

## 10. Edge cases

| Case | Outcome |
|---|---|
| A player with six creatures, long names | The tabs scroll sideways with their fades. Arrow keys still reach every tab |
| A creature with no stat block | The card holds the note, Add a stat block and the Bonus field (5.1). Saves and checks and Skills as groups, with no summary numbers |
| A dying character | Death Save leads the card, above Initiative |
| An ask for a save while Saves and checks is folded on a phone | It opens once (6.4). Folded again, its summary starts "Asked: DEX save" |
| A player's cast block on a spell in a folded Spells group | Spells opens once as the block appears. Folded again, its summary names the waiting ask |
| Sticky line tapped with Recent rolls folded | Recent rolls opens for the page and the row comes into view (6.4) |
| Shared attacks folded between Attack and Damage, or the selection changed with two or more still selected | Reopened, the hits and "Roll damage for 2 hits" are still there (5.3) |
| Folds changed in "view as a player" | Shown for the preview, never stored |
| A tablet turned across 900 px | Folds keep their state (resolved once per page) |
| Storage blocked | Taps last for the page, starts follow 6.2 |
| A group whose rows all fold away by the selection changing | The group is not drawn when it holds nothing |
| 390 x 844 and 320 x 568 at 130% | Next roll's Secret wraps under the pair and fills its line. Tabs scroll. Fold rows stay 48 px, summaries cut with "…" |
| A recharge action marked Used | Its fold summary names it "(used)" |

## 11. Lanes

Two lanes and a contract that lands first. After the contract, no file is changed by both lanes. Lane 2 rebases onto lane 1's tip before its e2e run, since its alignment roots measure the finished panel. Every FEATURES.md and DM guide edit is lane 2's, in its last commit after that rebase. The lanes ship in one batch, so lane 1 never deploys alone.

### 11.1 The contract (lane 1's first commit, before the lanes branch)

- `client/features/dice/diceFolds.ts` and `diceFolds.test.ts`: the keys, `foldKind(view, creature)`, the starts by layout, resolve and write, the slot with its seen ask and cast ids (6.4), and `useDiceFolds()`.
- `client/features/dice/CreatureCard.tsx`, `creatureLook.ts` and their tests: the card's frame and header from props (pictures, the badge ringed in the card's fill, name, kind line, a tabs slot, children), and the pure picture and kind-line builder. No room reads.
- The marks: `data-dice-card` in CreatureCard, and `data-dice-modes` in `Roller.tsx` and `data-dice-recent` in `RecentRolls.tsx`, the contract's only edits to those two lane 2 files.
- `e2e/harness.ts`: `diceFoldsOpen(context)`, an init script that stores every dice fold open, called in the `before` of the suites that open the options and are not about folds: `dice.e2e.ts`, `groupsave.e2e.ts` and `savespell.e2e.ts`. The alignment sweep opens every group through its fold rows instead.

### 11.2 Lane 1: the creature's options (L)

- **Files**: `RollOptions.tsx` (the card's frame above the keyed body, a player's tabs, Initiative, Death Save and the Bonus field in the card, the groups and their folds, 6.4's first two openings, the waiting summaries, Spells by level, 7.2, 7.5, section 8's scroll target), `options.ts` (`foldSummary`, `spellLevels`), `optionState.ts` and `cast/cast.ts` (the cast's opening stamp), `cast/CastBlock.tsx` and `CastBlock.test.ts` (7.3's Ask for saves look), `client/state/shortcuts.ts` (the tabs' keys).
- **Unit tests**: `options.test.ts` (summaries, spell levels with and without levels), `RollOptions.test.ts` (the card and tab roles, the header while loading, focus staying on the newly picked tab after ArrowRight, group order, Initiative in the card, folded content not drawn, an ask and a cast opening their group once), and `diceFolds.random.test.ts`, a randomized test of taps, asks and casts arriving and closing (a lent NPC's ask among them), the same spell reopened, the body remounting, kind switches, a layout crossing and "view as a player". Its invariants: an app opening never writes storage, a new ask or cast leaves its group open on that render, a tap is stored only for its own kind, and nothing is written while viewing as a player.
- **e2e**: a new `e2e/dicefolds.e2e.ts` on E2E_PORT plus 28 (the next free offset, clear of 5433 and 5434), with its time in `e2e/durations.json`, step labels `df-`: the starts at 1440 x 900, 1024 x 768, 390 x 844 and 440 x 956, a fold kept after a reload and kept apart by kind, an ask opening Saves and checks once, for Thorn and for an NPC lent to his player (a `monster` fold), and not again after a tab pick, a player's tabs by tap and by arrow keys, and the token's Roll landing with the modes whole. Lane 1 also runs `dice.e2e.ts` and `savespell.e2e.ts` as regression guards.
- **Docs**: none. Its report lists its user-visible changes for lane 2's docs commit.

### 11.3 Lane 2: the panel's frame and several creatures (M)

- **Files**: `Roller.tsx` (4, 7.4, 7.7, 7.9), `RecentRolls.tsx` (its fold with the `recent` key, 7.6), `DicePanel.tsx` (7.1, the open notice's place, the sticky tap's opening of Recent rolls), `groupSave/GroupOptions.tsx` (5.3 with the `group.*` folds and the shared attack slot), `groupSave/GroupSave.tsx` (`OpenGroupSave` as a notice, 7.8).
- **Unit tests**: render tests for the roll mode group (names, the joined pair, Secret apart), Recent rolls' fold and summary, `GroupOptions` (the card, "DEX" cells named "DEX save for 3"), the shared attack slot across an unmount, and the open notice.
- **e2e**: `dice.e2e.ts` (test 6's in-view check with the new row, and the sticky tap from a folded Recent rolls, then again after folding it once more, each with the row in view), `groupsave.e2e.ts` (the several-selected card and cells, Shared attacks folded before the attack's answer and between Attack and Damage, then each again with a selection change that keeps two or more selected, reopened with the hits and "Roll damage for N hits"), and `alignment.e2e.ts`, step labels `dp-`, with new roots at 390 x 844, 320 x 568 and 1440 x 900, each at 100% and 130%: `[data-dice-modes]`, `[data-dice-card]` for the DM's dragon, a player's tabs and the wolf, every `[data-panel-group]` row in the Dice panel with all its groups open, `[data-dice-last]` after a roll, `[data-dice-recent]`, the several-selected card, and the open group save notice. Each counts toward the sweep's "showed at fewer sizes" rule.
- **Docs, last commit**: FEATURES.md's "Roll options" (the card, the tabs, the groups, how they start, their memory, an ask opening its group), the Dice keys table (the tabs' keys), the Adv, Dis and Secret bullet (one "Next roll" group), Recent rolls folding, and "Several creatures". The DM guide's "Roll options", "Typing a roll" and "Several creatures", in the guide's own voice, with a new `docs/dm-guide/dice.webp`.

## 12. Choices to check

Each is decided as the project owner would most likely decide, from earlier rulings. The rejected option follows.

1. **Saves and checks start folded on a phone**, open on a computer. Rejected: open everywhere. Why: phone height is tight (the grabber bar ruling), request cards roll most saves, and an ask opens the group once (6.4).
2. **One set of starts for every kind of creature**, with the memory kept per kind. Rejected: starts that differ by kind. Why: one rule is easier to learn, and the first tap is remembered anyway.
3. **Initiative and the Death Save live in the card and never fold.** Rejected: a group of their own. Why: they start a fight and keep a creature alive, and the old place left a column empty.
4. **A player's creatures are tabs with pictures inside the card.** Rejected: a Switch menu (two taps for the common pair), a radio group (the same pressed look as the modes), and the chips under a visible label (still pills beside pills). Why: the request asks for the picker to be distinct, and one tap stays one tap.
5. **The roll modes become "Next roll" with Adv and Dis joined and Secret apart.** Rejected: a three-way Normal, Adv, Dis choice (it reads as a lasting setting, and the modes reset after each roll), and one joined strip of three (Secret is not a choice against Adv). Why: it groups them as the request asks and as D&D Beyond's roll menu does, and keeps each name the e2e and voice users use.
6. **The modes keep the app's pressed accent.** Rejected: D&D Beyond's green and red. Why: the accent is the viewer's color everywhere, and the dice keep their own look in the tray.
7. **The roll mode row is not sticky.** Rejected: a sticky row under the result line, 52 px more of a 444 px sheet. Why: the folds shorten the distance to an attack by about 180 px, and section 8 lands the token's Roll on the row. This fixes audit item 3 only in part. Estimated from today's measured rows on a 390 phone, Thorn's Spiritual Weapon still sits about 2,050 px (4.6 sheet heights) below the modes, or about 1,250 with Actions folded. A menu of modes on each roll button, as D&D Beyond offers, is logged as a later idea and not designed here.
8. **The roller does not fold.** Rejected: a "Free roll" fold. Why: the request names the creature's sections, players without a stat block roll from the field, and a fold row costs 48 px on every first screen.
9. **Recent rolls folds, open at first, one memory for the device.** Rejected: no fold, or a cap of ten rows. Why: one fold look for the whole panel, and the list grows all session.
10. **The order stays as today.** Rejected: actions first. Why: with Saves and checks folded on a phone, they cost one row there, and the order is the one players know.
11. **A token's Roll lands on the roll mode row.** Rejected: on the card. Why: Advantage is the choice most often made just before an attack.
12. **Controls lines fill each line at every size.** Rejected: growing only wrapped lines. Why: the polish pass's decision 2 and its review chose every size.
13. **Spells group by level.** Rejected: one flat list. Why: a caster finds a spell by level, and the labels cost one line per level.
14. **Folded groups show summaries with numbers.** Rejected: no summaries. Why: a DM can read a Dex save off the folded row, as the token panel's groups summarize theirs.
15. **The Dice panel's folds are apart from the token panel's.** Rejected: one store. Why: the keys mean different things, and the character page already keeps most of its folds apart for the same reason (the decisions log, "Look pass (design, 2026-10-18)").
16. **NPCs and objects fold with monsters.** Rejected: a fourth kind. Why: the request names monsters, PCs and companions, and an NPC's options read like a monster's.
17. **Several selected drop "save for 3" from each cell.** Rejected: the long words. Why: they wrapped to three lines at 130%, and the label says it once, as the dice UI pass did for presets.
