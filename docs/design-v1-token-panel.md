# raccoon-vtt v1: the token panel, the stat summary and AC on tokens

Status: draft 5, after design review round 3. The project owner's answers of 2026-10-15 and round 1's settled defaults are in section 9. The token action bar's whole body, its button rows included, is this doc's (3.3), since both this doc and docs/design-v1-layout-hierarchy.md had left the rows to the other. It builds on the docked token bar (docs/design-v1-bar-dock.md) and never undoes it. Code is cited from the `bar-dock` branch tip at `d1acdaf0`.

The project owner sent feedback after the group's first real session. This doc answers the points about the token panel, the stat summary a tap on a token shows, monster stat blocks, and AC on tokens. Two other docs answer the rest at the same time: docs/design-v1-combat-flow.md (the initiative tracker, death and revive, companions and summons) and docs/design-v1-layout-hierarchy.md (sideways phones, a collapsible sidebar, the handout viewer, and the app-wide grouping pass for every panel and bar not owned here or by the combat doc). Section 3.10 states where this doc meets each of them.

Every size below is in layout pixels (`features/device/layout.ts`), so the interface size changes them as it changes everything else. Widths "inside" a box are what its content gets after borders, safe-area padding and body padding (3.12).

## 1. The project owner's points, and the answer to each

1. "From the DM side (and maybe player too when clicking on their token?), we need better stat summaries when clicking on a token."
   A tap on a token opens its action bar, so the summary goes at the top of the bar, under its header (3.2, 3.3). For a creature whose stats the viewer's device holds, it gives AC, HP, speeds and Passive Perception. For a monster or NPC with a stat block, the DM also gets its six saving throws and its resistances, immunities and vulnerabilities, read from the block. A player gets the same for the creatures whose stats they hold (their own character, a creature they own outright), and of anyone else's only what the DM already lets them see. The token panel carries the same AC, speed and Passive Perception line in its stat block's header (3.5).
2. "Monster stat blocks should be more accessible. Editing the stat block should be further down and . Overall the information our DM needs the most is stat blocks so these need to be made more front and center. Open to ideas here (maybe a button that can be clicked to show the stat block in the modal?)"
   The bar gains a "Stat block" button beside Details (3.3). It opens the token panel at the stat block, which now sits directly under the panel's image (3.4, 3.5). Wherever the bar docks beside the panel, it stays open, so the DM reads the block and deals damage at once. The project owner chose the panel over a separate pop-up (section 9). The editable Stats fields, which sit just above the block today, move to the panel's foot and fold away (3.8). The doc reads "editing the stat block" as those fields, since they are what a DM scrolls past to reach the block.
3. "The hit points section of a monster is too large. Max and temp HP can be in the same row"
   Max HP and Temp HP stand side by side at every width (3.7).
4. "Image/other images takes up too much space in sidebar for tokens, Add image and add another image should be side by side with a tooltip when hovering over add another image showing what it is for"
   One image row: a 48 px preview and, beside it, "Change image" (or "Add image") and "Add another image" side by side, Crop and Remove after them, and the other images in the same column (3.6). The two-line help paragraph goes. "Add another image" carries a tooltip and an accessible description of its purpose, and the picker it opens says the same in a visible line, so a phone user learns it without hover. Section 3.6 writes out when the two buttons wrap.
5. "Move stat block to be just under the monster image at the top of the token sidebar. Keep it collapsible. Also move the map name of the monster such as "Monster 4" to be at the very top just above the image."
   The panel opens with the token's name, then the image row, then the stat block, which folds and whose header carries the one-line summary (3.5). Nothing sits between the image row and the block. The device remembers whether the block was open, so a DM who opens it once sees it on every monster.
6. "Position and range rings should come just after conditions"
   They do: HP, Conditions, Position, Range rings (3.5).
7. "In general just do a design review pass for condensing information in the sidebar without sacrificing usability"
   Section 3.1 ranks every part by use. Rarely used setup (Stats, Token settings, Companion, Owners) folds at the foot. Three notes share one section and start two rows tall, the rest's fight warning shows only once a rest is chosen, the range rings' help line joins its field's hint, and the other images' help paragraph goes (3.6, 3.8). Nothing loses a function or keyboard path. The renames are listed in 3.11.
8. "Show AC on tokens and in initiative tracker"
   Each creature token shows its AC on a small shield in its bottom left corner, to the DM on every creature and to a player on the creatures whose stats their device holds (3.9). The tracker's AC belongs to the combat doc, which draws the same shield badge (`AcBadge`, 3.10).

## 2. Current behavior

**The token panel** (`client/panels/TokenPanel.tsx:101-128`) draws, in order:

1. The header (`:132-185`). First the image (`ImageField`, a 64 px preview with Change image, Crop and Remove beside it, `features/images/ImageField.tsx:42-60`). Then "Other images" (`features/tokens/AltImages.tsx:36-76`): a label, a help sentence that runs to two lines (`:39-45`), the images, and "Add another image" with "Remove one" on a row of their own (`:67-75`). Only then the name, the size line and the tags (`:160-172`). An owner of a player character also gets Name and "Name others see" here (`:173-182`).
2. Hit points (`features/tokens/HpSection.tsx:159-206`): the large number row, the HP entry, Max HP and Temporary HP as two full rows (`:177-198`), death saves, and the DM's life buttons.
3. Conditions (`TokenPanel.tsx:104-110`), Rest (`:111`), Notes (`:112-117`), Position with the DM's Height field (`:118`, `:209-213`), Range rings (`:119`), Sight (`:120`).
4. Stats (`:121-123`, `features/tokens/StatsSection.tsx:57-157`): for a DM up to 15 rows of fields (AC, five speeds, Hovers, initiative bonus and score, Passive Perception, senses, creature type, challenge rating, legendary actions and resistance), then "Character sheet" (`:142`) and "Card notes" (`:143-155`).
5. Stat block (`TokenPanel.tsx:124`), then Token settings (`:125`, ten to twelve controls, all open, `:227-300`), Owners (`:126`) and Remove (`:127`).

So the stat block starts below every other section but the DM's setup, and below the whole Stats form. It folds under 900 px (`features/tokens/StatBlockSection.tsx:35`), and the panel remounts for each token (`TokenPanel.tsx:63-64`), so a DM on a phone unfolds it again on every monster. Its fold button's name changes with its state ("Show the stat block", "Fold the stat block", `:58-60`).

**Reaching the block.** Only through the bar's Details and a scroll to the panel's foot, or a tracker row's "Stat block" (`features/encounter/Row.tsx:402-414`), which selects the token, hides the bar, sets the request (`features/tokens/statBlockOpen.ts:11-15`) and opens the token panel. The section then unfolds and scrolls itself into view (`StatBlockSection.tsx:40-46`).

**The token bar** (`client/canvas/TokenActionBar.tsx:147-276`): the header (name and elevation badge), one muted HP line with a life tag (`:125-126`, `:159-164`), death saves while dying (`:165-171`), the effects, the HP entry (`:195`, for the DM, the owners, and every player when "Players can apply damage and healing" is on, `features/tokens/access.ts:99`), elevation, the ground notice, the other images row, the Conditions drawer, and one wrapping row of buttons that ends in Details (`:222-266`). It shows no AC, speed or anything from a stat block.

**AC** shows on no token. A tracker row shows "AC 15" as text to the DM (`Row.tsx:137`). The party bar shows AC on a shield glyph (`features/party/PartyBar.tsx:194`, `:230-242`).

**What players receive** (`shared/project.ts`). Who owns the token and who owns the actor are two questions:

- A token with its own actor (`{ inline }`): its owners get the whole actor except `dmNotes` and `monsterId` (`projectActorOwner`, `:487-490`). Everyone else gets only its life state, its effects and the HP the DM allows (`projectActorPublic`, `:473-479`).
- A token of a character (`{ ref }`): the token carries only the reference (`:508-536`). The character is projected on its own: whole to its owners (`projectCharacter`, `:575-578`), and as life, effects and HP to everyone else (`:579-585`). So a player who owns a character's token but not the character holds that character as any other player does, without its AC.
- A hidden token (`visibility: "dm"`) reaches its owners and no other player (`tokenVisibleTo`, `:310-314`).

So a player's device holds AC, speeds, Passive Perception and `srdId` only for actors that player owns: a token's own actor they own, or a character they own. A table display is a player who owns nothing (docs/design-v1-dm-tools.md 2.1).

**The marks on a token** (`client/canvas/tokenMarks.ts:40-90`, `TokenNode.tsx:140-190`): condition chips along the top edge, the elevation badge at the top right, the HP bar under the bottom edge, a numbered token's number in the bottom right corner, the padlock in the bottom left corner, and the Bloodied notch on the right of the ring. The left half of the bottom edge holds only the padlock, and only on a locked token.

## 3. New behavior

### 3.1 Who uses what, and how often

The ranking decides the order of the bar and the panel. "Every turn" means several times a round in a fight.

| Part | DM | Player | Why |
| --- | --- | --- | --- |
| HP and the HP entry | every turn | every turn, own creature | Every hit and heal. |
| AC | every turn | rarely, own creature | The DM answers "does 17 hit?" for each attack on a monster. Players know their own. |
| Saves, resistances, immunities | most turns with spells | never | A save spell or a damage type needs them before the damage is typed. |
| The full stat block | every monster turn | Wild Shape only | A monster's attacks and traits are read on its turn. |
| Conditions | most rounds | most rounds | Added and read often, rules text on tap. |
| Speed | every turn | every turn | Movement each turn. |
| Passive Perception | a few times a session | rarely | Stealth and hidden things. |
| Elevation, facing | some rounds | some rounds | Flying and climbing. |
| Range rings | rarely | some turns | Ranged characters check reach. |
| Notes | some scenes | some scenes | Read when a creature matters to the story. |
| The character sheet link | rarely | every session, often | Players open their D&D Beyond sheet from their own token. |
| Rest | a few times a session | a few times a session | Short and long rests, out of fights. |
| Sight and carried light | at scene changes | at scene changes | A torch, a dark room. |
| Image, other images | setup, Wild Shape | setup, Wild Shape | Swapping an image is in the bar. Choosing one is setup. |
| Stats fields | setup | rarely | The numbers come from the block or the sheet. A Shield spell changes AC for a turn. |
| Token settings, Companion, Owners | setup | a companion's turn now and then | Name, kind, size, ring, layer, HP view, hidden, locked, fog. Hidden and Locked are also in the bar. |
| Delete, Dismiss | rarely | once per summon | Also in the bar. |
| Initiative bonus and score | once a fight | once a fight | Auto initiative rolls monsters. Players roll their own and read their sheet. |

So: what a DM reads on every turn goes in the bar's summary with the HP entry right after it, the block goes directly under the panel's image, play controls follow by use, and setup folds at the foot.

### 3.2 The stat summary

One component, `StatSummary` (`client/features/tokens/StatSummary.tsx`), with its rules in a pure `client/features/tokens/statSummary.ts`. It has three parts.

**Vitals.** One line of items at 14 px, label muted and value at weight 600, which wraps onto more lines where it must. Each item is made of units that never break inside, and a line may break only between units, so no unit is wider than about 140 px (about 150 in Inter, which the app has drawn in since 2026-10-17) and nothing overflows even the narrowest place it shows (3.12):

- AC: the shield badge (`AcBadge`, 3.9) holding the number, one unit. Its accessible name is "Armor Class 15". It is left out on a dead creature, for an AC of 0, and while `hpLess` holds (below), as on the map and in the tracker.
- HP, in the bar only, since the panel has its own section: the same text and life tag the bar's HP line shows today (`TokenActionBar.tsx:125-126`). Its units are "HP 22/30", the temporary HP "+5", and the tag, so "HP 100000/100000" (the largest, `MAX_HP_AMOUNT`, `features/tokens/hpInput.ts:33`) is one unit of about 130 px. A player who sees labels gets "Bloodied". On a dead creature the DM's Revive follows the Dead tag as one more unit, with its line "Revive brings it back with 1 HP." under the vitals, and a player who may heal it gets the combat doc's healing line there instead (docs/design-v1-combat-flow.md 3.5). While `hpLess` holds there is no HP item, so no life tag and no Revive either, whatever HP and life the actor still stores.
- Speed: the token's own speeds, walk first, then fly, swim, climb and burrow. Each mode is one unit, so "Speed 30 ft," then "fly 60 ft (hover)," then "swim 30 ft" may each start a line, and an Adult White Dragon's four modes or the maximum of five at 1000 ft wrap between modes rather than run out of the box. A walk of 0 with another speed reads "Speed 0 ft, fly 30 ft (hover)".
- Passive Perception, such as "Passive Perception 13", one unit.
- For a creature whose actor has a sheet link, usually a player character: "Open the sheet ↗", the existing link (`StatsSection.tsx:214-240`), as a 44 px unit. In the bar it sits in the row of 3.3 instead.

Each item shows only when the viewer's copy of the actor holds it, and AC, speed and Passive Perception only on a creature (kind `pc`, `npc` or `monster`). An object's summary is its HP alone, and nothing while `hpLess` holds. The initiative bonus and challenge rating stay out: auto initiative rolls monsters, players read their own sheet, and both stay in Stats and in the block (settled by default, section 9).

**HP-less tokens.** One shared predicate, `hpLess(actor, token?)` in `shared/rules/hp.ts`, defined and owned by docs/design-v1-combat-flow.md 3.6.6, is true for a companion that is an effect, or any token with max HP 0. It takes the resolved actor (a token's own, or its character's) and the token where there is one, so the Characters panel's card, which has no token, asks it too. It gates every HP-less behavior in this doc: the vitals' HP and AC items (3.2), the bar's HP entry (3.3), the Hit points section (3.7) and the map's AC badge (3.9). No place here tests a maximum of 0 on its own. A creature turned into an effect keeps its stored HP, AC and life, as that doc says, and is treated as HP-less while it is an effect, so a living or a dead one shows no HP, life tag, Revive or AC until it is a creature again.

**Saves**, when the token's stat block is shown to this viewer (`statBlockShown`, `features/monsters/statBlockLink.ts:45-48`) and has loaded: "Saves" and six units, "Str +5", "Dex −1", "Con +2", "Int +4", "Wis +2", "Cha +4", in the block's own numbers and minus sign (`signed`, `shared/statBlock.ts:89-91`). All six, not only the proficient ones, since any of them can be called for and six short units fit one or two lines.

**Defenses**, from the same block, one line each when not empty, in the 2024 block's words and order: "Vulnerabilities …", "Resistances …", "Immunities …" (damage and condition immunities joined as the block prints them, such as "Poison; Charmed, Poisoned"). These are running text, which wraps between words and inside a word only when one word is wider than the box (`overflow-wrap: anywhere`). Each line clamps at three lines in the bar (a room monster may type 500 characters, `shared/protocol.ts:506`). The whole text stays in the block, one tap away.

**Where the block's numbers come from.** `tokenStatBlock` (`statBlockLink.ts:24-31`) gives the link. A room monster reads `statBlockOf(view.monsters[id])` at once, from state only the DM holds. An SRD monster needs the SRD chunk (`loadMonsters`, `shared/srd/monsters.ts`) and `statBlockFromSrd` (`shared/statBlock.ts:342`), memoized per `srdId` in a module map. A hook, `useLinkedBlock(token, actor, access)`, returns `none`, `loading`, `failed` with a retry, or `ready` with the block, from a pure `linkedBlockState(link, monsters, srd)` that the tests drive. A block that `statBlockFromSrd` cannot read (it throws, which the shipped SRD never does, its tests run all 330) counts as `none`.

**Loading.** The first SRD token a device opens loads the chunk (about half a megabyte, once per page). Until then the saves line holds its place with the shared indicator, "Loading saves…", after the usual 200 ms (`components/Loading.tsx`), so a quick load never flashes and the bar grows at most once. A failed load shows "Saves did not load. Reload to try again." with the room's Reload, which waits for queued edits and the connection first (`components/LoadBoundary.tsx`). A Retry could not work: the chunk is a module, and Chrome keeps a module that failed for the life of the page. The vitals never wait: they come from the actor.

**What a player may see.** The summary reads only the viewer's copy of the room, so it can never show what the projection held back. A player's device holds AC, speeds, Passive Perception and `srdId` only for actors that player owns (section 2). So for every other creature the summary is the HP the DM allows and nothing else. That includes a character's token the player owns without owning the character: they hold the character as other players do, so they get its HP as "Players see the party's HP" allows and no AC, speed or Passive Perception, in the bar, the panel and on the map. This doc keeps that exception rather than change the projection, since token ownership without character ownership is the DM handing a player control of a body, such as a charmed ally, whose sheet stays its own player's (Decided item 3 in section 9, and the tests in section 7). An owner of a token linked to an SRD monster, such as a druid's Wild Shape, gets that SRD block's saves and defenses, as they already get its block (`statBlockShown`). A room monster's block never reaches a player. Nothing is added to any projection.

### 3.3 The token bar

Status: changed by docs/design-v1-token-window.md (3.2, 5.8, 8.9). Undo move, Doesn't count and the door lead on a line of their own, then Conditions, Hidden and Multi-select ("Select several" here) on one line, with Request a roll after them. The less-often row loses Move bar and Reset bar position. The body gains Size after the steady line and before the less-often row. A window resized under 300 px tall takes the short layout.

The single-token bar keeps its frame, header, dock behavior and every control (docs/design-v1-bar-dock.md). This doc owns its whole body, the button rows included.

**Its body, in order:**

1. The header, unchanged: grip, name in two lines at most, elevation badge, Close.
2. The vitals line, in place of today's HP line, with the combat doc's Revive after the Dead tag for the DM.
3. Under the vitals, while dead: Revive's line for the DM, or for a player who may heal it the combat doc's healing line.
4. The HP entry, where the viewer has one (`TokenActionBar.tsx:195`) and `hpLess` does not hold (3.2), with the combat doc's dead lines under its field. It comes right after the vitals, since it is the control used most (3.1).
5. Death saves, unchanged, while dying (not while stable).
6. The effects, unchanged.
7. Saves, then the defense lines, for a linked block shown to this viewer.
8. The "read more" row: "Stat block" when the block is shown to this viewer and the link is a room or SRD monster, "Open the sheet ↗" when the actor has a sheet link, then "Details". Details moves here from the end of the button row. Stat block and Details both open the panel, so they sit with the summary they expand.
9. Elevation, the ground notice, the other images row ("Swap image") and the Conditions drawer, in today's order.
10. The play row and the less-often row, below.

**A short bar.** A bar is short when its capacity is under 300 px. Its capacity is the `maxHeight` that `placeBar` and `shareLane` would give a bar of unbounded content at the same spot (content passed as `Infinity`, bar-dock 1.2 and 1.3), or the overlay's height when compact (bar-dock 1.4). It never reads the bar's own content, which `shareLane` uses to place a moved bar hung by its bottom (`client/canvas/barDock.ts:304-305`), so opening "More stats", or the short layout itself, never changes the answer. It counts what the lane gives the bar: a docked bar on a desktop that tall alert cards push down toward its 120 px floor is short while they stand there. A bar that spans an upright phone is the exception: it hangs above or below its token, so its room changes with where the tapped token stands. Its capacity is instead the least room any token's bar gets on that screen, the screen's alone: a token where the room above and below it are equal, a little under the free area's middle, leaves each side about half the free area (`barDock.ts` `spanRoomAtWorst`). A spanning bar is short when that room is under 210 px, what its full layout takes to show Apply with no scroll: the frame's 61 px, two lines of vitals and the gap after them, and the HP entry's two 44 px rows (`SPAN_SHORT_BAR_PX`). So a phone keeps one layout, and Apply one place in view, whichever token is tapped (decided, section 9). At 390 x 844 that room is about 263 px, or 239 with the turn band, so the bar is full. At 130% (300 x 649) it is about 166 px, or 142 with the band, so the bar is short, with Apply in view. Short bars are a phone held sideways at any interface size, a large phone held sideways in the wide layout (932 x 430), every screen too short to dock or span, a docked bar under tall alert cards, and a spanning bar on an upright phone at 130% or smaller. On a short bar:

- The vitals line holds the AC shield and HP (with its tag and Revive). Speed and Passive Perception leave it, so it keeps to one line for any ordinary number.
- The HP entry puts its field and Apply first and its mode buttons under them (`HpEntry` gains `fieldFirst`). Typed math (`-7`, `+5`, `=20`, `t5`) works from the field alone.
- Speed, Passive Perception, saves and defenses sit in one disclosure after the effects, "More stats", closed when the bar opens and not remembered. Its name says more than saves and defenses because it holds speed and Passive Perception too. It is a 44 px button with `aria-expanded`, and it leaves out what is empty, so a creature with none of the four has no disclosure.

The arithmetic, for the project owner's sideways phone: the bar's content starts 61 px below its top (border 1, padding 4, the 48 px sticky header, a gap of 8). At 844 x 390 at 130% with 47 px side and 21 px bottom insets, the docked bar is 151 tall (bar-dock 1.4). One vitals line (21) and a gap (8) put the field and Apply at 90 to 134, inside the bar. With the full layout the vitals took two lines and the entry's mode row came first, which put Apply at about 203, out of view. At 844 x 390 at 100% the bar may draw at most 241 (390 less the 52 px top bar, the 60 px toolbar, the 21 px home-bar inset and 16 px of margins), and Apply ends at 134 too. A bar with an alerts summary row keeps 99 px at 130% (bar-dock 1.3), the header and the vitals, and its HP entry scrolls, as the bar's controls scroll there today. On a dead creature, Revive (a 44 px button on the vitals line) and its line move the field down about 50 px, so at 130% Apply needs a scroll there, where Revive is the control that applies.

**The button rows.** Today one wrapping row holds every button in the order they were added (`TokenActionBar.tsx:222-266`): Undo move, Doesn't count, the door, Conditions, Light, Hidden, Locked, Request a roll, Duplicate, Delete, Select several, Details, Move bar and Reset bar position. They become two wrapping rows, ranked by 3.1. Each button still shows only where it does today, and keeps its name, look and behavior.

The play row:

1. **Undo move** (`:398-405`), only just after this device moved the token. It answers a mis-drop, so it must be found at once.
2. **Doesn't count** (`:416-438`), for the DM and the owners, only on the acting creature after it moved this turn. It answers the move just made, a shove or a teleport.
3. **Open door** or **Close door** (`features/doors/DoorButton.tsx:14-38`), on a player's own token with a door in reach. A door is used the moment it is reached.
4. **Conditions**, for the DM and the owners. Most rounds.
5. **Request a roll**, for the DM, on a creature a player plays. A few times a fight.
6. **Hidden**, for the DM. An ambush revealed, a creature slipping away.
7. **Light** (`features/vision/LightChip.tsx:21-41`), for the DM and the owners, on a vision scene or while the token is lit. At scene changes. Its choices still open at the start of this row (`order: -1`).
8. **Select several**, for everyone. Occasional, and the way into the group bar.

The less-often row, which starts on a line of its own:

9. **Locked**, for the DM. Set once for a set piece.
10. **Duplicate**, for the DM. Setup.
11. **Delete**, for the DM, armed as today. For a companion's owners who are not the DM, the combat doc's **Dismiss** takes this place, armed the same way (docs/design-v1-combat-flow.md 3.6.9). The DM keeps Delete and gets no second button.
12. **Move bar**, then **Reset bar position** while the bar is away from its spot, only while it docks (bar-dock section 2). They arrange the bar itself.

Why two rows: the first holds what is used during play, the transient answers first. The second keeps the destructive and setup buttons apart from them, so a quick tap meant for Conditions or Hidden never lands on Delete or Dismiss, which still need their second tap. The second row costs at most one line over today's wrapping, and for most players it holds only Move bar.

What changes from today: Request a roll and Hidden move ahead of Light, Locked and Duplicate join Delete on the second row, Select several moves ahead of them, and Details leaves for the read-more row. A pure `barButtons(input)` in `client/canvas/barButtons.ts` returns the two rows' button ids from who the viewer is and what applies, and a pure `barShort(room)` says whether the bar is short, so both are tested without rendering (section 7), and the bar draws from them.

**The whole bar, by case.** Each line shows only where its rule above holds. A short bar moves speed, Passive Perception, saves and defenses into "More stats" after the effects.

- A monster, for the DM: header, vitals (AC, HP, speed, Passive Perception), HP entry, effects, saves, defenses, Stat block and Details, elevation, other images, the Conditions drawer, then Undo move, Doesn't count, Conditions, Hidden, Light, Select several, and Locked, Duplicate, Delete, Move bar, Reset bar position. Dead: Revive after the Dead tag and its line under the vitals, no AC.
- An NPC, for the DM: the same as a monster. Without a stat block it has no saves, defenses or Stat block, so the read-more row is Details alone. On an NPC a player plays, such as a companion, Request a roll joins the play row after Conditions, and the DM keeps Delete. Where `hpLess` holds, the vitals and HP entry are empty, so the bar opens with the effects.
- A player's own creature, their character or a creature they own outright: header, vitals, the healing line while dead, HP entry, death saves while dying, effects, saves and defenses only for an SRD link such as a Wild Shape, then Stat block (an SRD link), Open the sheet ↗ (a sheet link) and Details, elevation, other images, the Conditions drawer, then Undo move, Doesn't count, Open door, Conditions, Light, Select several, and for a companion Dismiss, then Move bar and Reset bar position. A character's token they own without owning the character shows that character's HP as other players see it, and no AC, speed or Passive Perception (3.2).
- Someone else's creature, for a player: header, the HP the DM allows, and with "Players can apply damage and healing" on the HP entry with Damage and Heal (`access.ts:99`) and, on a dead creature, the combat doc's healing line. Then Details, then Undo move (when "Who can move any token" let them move it) and Select several, and Move bar.

Docked with room to spare, at 304 px (a desktop, a tablet), for the DM on an SRD goblin that moved on its turn. `(15)` is the AC shield:

```
+----------------------------------+
| :: Goblin 4                  [X] |
| (15) HP 10/10  Speed 30 ft       |
| Passive Perception 9             |
| [Damage][Heal][ Set ][Temp]      |
| [7 or -7             ] [Apply]   |
| Saves Str -1 Dex +2 Con +0       |
|       Int +0 Wis -1 Cha -1       |
| [Stat block] [Details]           |
| Elevation      [-5] 0 ft [+5]    |
| [Undo move] [Doesn't count]      |
| [Conditions] [Hidden] [Light]    |
| [Select several]                 |
| [Locked] [Duplicate] [Delete]    |
| [Move bar]                       |
+----------------------------------+
```

A monster with defenses adds lines under the saves, such as:

```
| Immunities Poison; Exhaustion,   |
|   Poisoned                       |
```

The same goblin on a short bar: a phone held sideways, 844 x 390 at 100% or 130%, or 932 x 430. Apply is in view without scrolling:

```
+----------------------------------+
| :: Goblin 4                  [X] |
| (15) HP 10/10                    |
| [7 or -7             ] [Apply]   |
| [Damage][Heal][ Set ][Temp]      |
| [More stats                   v] |
| [Stat block] [Details]           |
| Elevation      [-5] 0 ft [+5]    |
| [Undo move] [Doesn't count]      |
| ...                              |
+----------------------------------+
```

The same goblin dead, for the DM, with room to spare. The AC shield leaves, Revive follows the Dead tag, and its line sits under the vitals:

```
+----------------------------------+
| :: Goblin 4                  [X] |
| HP 0/10 [Dead] [Revive]          |
| Speed 30 ft  Passive Perception 9|
| Revive brings it back with 1 HP. |
| [Damage][Heal][ Set ][Temp]      |
| [7 or -7             ] [Apply]   |
| Saves Str -1 Dex +2 Con +0       |
| ...                              |
+----------------------------------+
```

Spanning a phone held upright, 390 x 844 (348 inside), the vitals and the saves each fit one line:

```
+--------------------------------------------+
| :: Goblin 4                            [X] |
| (15) HP 10/10  Speed 30 ft  Passive Perception 9
| [Damage][Heal][ Set ][Temp]                |
| [7 or -7                       ] [Apply]   |
| Saves Str -1 Dex +2 Con +0 Int +0 Wis -1 Cha -1
| [Stat block] [Details]                     |
| Elevation                [-5] 0 ft [+5]    |
| [Conditions] [Hidden] [Light]              |
| [Select several]                           |
| [Locked] [Duplicate] [Delete]              |
+--------------------------------------------+
```

A player's own character, a player's own companion, and two players tapping a goblin whose HP the DM shows as labels, the second with "Players can apply damage and healing" on:

```
+----------------------------------+   +----------------------------------+
| :: Thorn                     [X] |   | :: Wildfire Spirit           [X] |
| (16) HP 31/38 +5  Speed 30 ft    |   | (13) HP 15/15  Speed 30 ft,      |
| Passive Perception 14            |   | fly 30 ft (hover)                |
| [Damage][Heal][ Set ][Temp]      |   | Passive Perception 10            |
| [                    ] [Apply]   |   | [Damage][Heal][ Set ][Temp]      |
| [Open the sheet ↗] [Details]     |   | [                    ] [Apply]   |
| Elevation      [-5] 0 ft [+5]    |   | [Details]                        |
| [Open door] [Conditions] [Light] |   | Elevation      [-5] 0 ft [+5]    |
| [Select several]                 |   | [Conditions] [Light]             |
| [Move bar]                       |   | [Select several]                 |
+----------------------------------+   | [Dismiss] [Move bar]             |
                                       +----------------------------------+
+----------------------------------+   +----------------------------------+
| :: Goblin 4                  [X] |   | :: Goblin 4                  [X] |
| Bloodied                         |   | Bloodied                         |
| [Details]                        |   | [   Damage   ][    Heal    ]     |
| [Select several]                 |   | [5 or +5             ] [Apply]   |
| [Move bar]                       |   | [Details]                        |
+----------------------------------+   | [Select several]                 |
                                       | [Move bar]                       |
                                       +----------------------------------+
```

The bar grows by the summary: about 40 px of vitals and, for a linked monster, about 40 px of saves and up to three short defense lines, all after the HP entry. It already grows upward to the room it has, scrolls with "Scroll for more", and goes compact on a short screen (bar-dock 1.4), so no rule there changes. Its drawn box, which the lane and Fit read, grows with it.

**Escape, Back and Close while the panel shows the token.** Today the bar's Close, Escape and Back let go of the token (`dismissal`, `state/selection.ts:82-86`, `useEscape`, `pages/RoomChrome.tsx:126`). Where the bar stays open beside the token panel (3.4), letting go would empty the panel the DM is reading and drop its focus. So while the token panel shows the selection (`tokenPanelShown`, `Room.tsx:291`), the bar's Close (the dock's too), Escape and Back hide the bar (`showActions(false)`) and keep the selection. The panel keeps the token, and focus moves to the panel's tab from 900 px up or the sheet's heading below, where `useSheetReturnFocus` has nothing to take. A tap on empty map still lets go, as bar-dock section 3 says. Elsewhere they let go as today. One function, `barDismiss(local, tokenPanelShown)` beside `dismissal`, gives "hide" or "let go", and Room, RoomChrome and Stage's bar close all read it. A sheet, a dialog and a text field keep their precedence (`lib/escape.ts`), so on a phone Escape and Back close the sheet first.

**A second Escape lets go.** With the bar hidden (by `barDismiss`, by Details, or by the alerts summary) and no group held in Select several, Escape lets go of the selection, so the keyboard always has a way to deselect before H, L, Delete or the arrow keys act on a token no longer in view. `dismissal` gains a third answer, "token": no bar showing, a selection, Select several off, and no map pane open (a label, pin or light pane). `escapeTarget` takes it after the sheet, the dialog, the field, the bar and the group, and `useEscape` then calls `ui.select(null)`. While a map pane is open, Escape is left to the pane, which closes on it as today (`features/builder/labelEdit.ts:121-123`, `LabelPane.tsx:39-50`), and the next Escape lets go. Back keeps today's rule (`Room.tsx:298`), so Android's Back still leaves the room only when nothing above is open. With Select several on and its bar hidden, Escape keeps bar-dock's rule: it ends the mode, or does nothing while the token panel shows the group (`dismissal`'s "group").

### 3.4 Open the stat block: one shared action

`openStatBlock(scope, ui, tokenId)` in `client/features/tokens/statBlockOpen.ts` is the one way to show a token's stat block, in the token panel as the project owner decided (section 9). The bar's "Stat block" calls it, the tracker row's "Stat block" calls it in place of its own four lines (`Row.tsx:405-412`), and design-v1-combat-flow.md calls it for any other tracker entry point it adds. It:

1. Selects the token, unless it is already the selection.
2. Sets the request for it in the Room scope (`statBlockRequest`, now `{ tokenId, focus: true }`), so a "view as a player" preview never reaches the DM's own panel, as today.
3. Opens the token panel (`ui.openPanel("token")`): the side panel's Token tab from 900 px up, the Token sheet below.
4. Hides the bar (`ui.showActions(false)`) only where the bar cannot stand beside the panel: where it folds under the sheet (`foldsUnderSheet` with the sheet open, `pages/fold.ts:30-32`: a portrait layout under 900 px, or the very short mode of docs/design-v1-layout-hierarchy.md 4.2, its `sheetMode` "full", as at 480 x 320 at 130% and at 649 x 300 with the turn band), or where the free width beside a side sheet is under the bar's narrowest width, 230 px (bar-dock 1.3, as at 667 x 375 at 130%, whose sheet at its 60% cap leaves 189). Everywhere else, the side panel from 900 px up and the right sheet on a phone held sideways, it leaves the bar as it was: open when "Stat block" came from the bar, and as a tracker row found it otherwise (`ui.select` keeps the bar's state, `state/selection.ts:39-41`). There the DM applies damage in the bar while reading the block beside it (settled by default, section 9). Details keeps hiding the bar at every width, since its panel repeats every control in the bar.

The stat block section, once it shows that token, unfolds through the request override (3.5), scrolls itself to the top of the panel (`block: "start"`, smooth unless the device asks for reduced motion), moves focus to its fold button, whose name is "Stat block" and whose `aria-expanded` is true, and clears the request. The override keeps the block open across remounts, and neither the request nor the override writes the stored folds (3.5). Room does not also send focus to the panel for this path, unlike Details (`Room.tsx:238-246`). Pressing "Stat block" again while the block shows scrolls and focuses it again. Escape, Back and Close then hide the bar and keep the panel (3.3).

The outliner and the party bar need nothing: a tap on a row selects the token and opens its bar, whose "Stat block" is one more tap. The Monsters panel keeps its own block view.

### 3.5 The token panel's order and folds

The new order. A part shows only where it does today (`TokenPanel.tsx:100-128` and each section's own rule) unless the table says otherwise.

| # | Part | Shows for | Starts | Why here |
| --- | --- | --- | --- | --- |
| 1 | Name, size line, tags | everyone | open | The owner's ask: the name at the very top. |
| 2 | Image row, with the other images in its column | everyone (buttons for the DM and owners) | open | The owner's ask: the image under the name. Compact (3.6). |
| 3 | Stat block, its header carrying the summary line: AC, speed, Passive Perception | as today (`statBlockShown`) | open on a large wide layout, folded elsewhere, then as this device last left it | The owner's ask: directly under the image, foldable (settled by default, section 9). |
| 3b | The summary line alone, where row 3 does not show, with the sheet link for a character | the DM and anyone whose device holds the actor | open | The numbers the folded Stats used to show. |
| 4 | Hit points | everyone | open | Every turn. Compact (3.7). |
| 5 | Conditions | everyone | open | Most rounds. |
| 6 | Position: elevation, facing | everyone | open | The owner's ask: just after conditions. Height moves to Token settings. |
| 7 | Range rings | as today | open | The owner's ask: just after conditions. |
| 8 | Notes: for everyone, on the card, for DMs only | as today, the card's notes joining them | open | Read when a creature matters. |
| 9 | Rest | as today | open | A few times a session. |
| 10 | Sight | as today | open | Scene changes. |
| 11 | Stats: the fields and the "Sheet link" field | the DM and owners | folded | Setup. The summary shows the numbers. |
| 12 | Token settings: the DM's today, plus Height, plus the "Make a companion" button on a token that is neither a PC nor a companion. For an owner who may rename the token (a PC's, or a companion's, docs/design-v1-combat-flow.md 3.6.4), Name and "Name others see" where they apply | the DM, an owner who may rename it | folded | Setup. |
| 13 | Companion, the combat doc's section (its 3.6.9): "Belongs to" and the turn | on a companion only: the DM and its owners | folded, with the character's name beside its label | Set once, then a turn change now and then. Next to Owners, which a companion's link decides. |
| 14 | Owners | the DM | folded, with the names (or "None") beside its label | Setup. |
| 15 | Remove | the DM | open | One button, also in the bar. |

**The stat block's header.** The section's heading holds its disclosure, "Stat block" (3.8). Under it, in the section's header and outside the button, sits the summary line, folded or open: the token's own AC, speed and Passive Perception, which may differ from the printed block. So a folded block still shows the numbers the DM reads every turn, and nothing comes between the image row and the block. Where row 3 does not show (a character, a player's view of a creature they own without an SRD link, an NPC the viewer may not read the block of), the summary line stands alone as row 3b, with "Open the sheet ↗" for a character with a link. Where the viewer holds none of its items, as for another player's monster, there is no summary line.

**Folds.** A foldable section's label becomes a disclosure: a heading holding a full-width 44 px button with a chevron and the label, `aria-expanded`, named by the label alone so the name never changes with its state (`components/Button.tsx:38-44`). A short summary may sit after the button, outside it: the stat block's summary line (always), the companion's character and the owners' names (while folded). Folded content is unmounted. A field being typed in loses focus to the fold button first, and fields commit on blur (`features/tokens/ui.tsx:106-108`), so nothing typed is lost.

**The fold contract.** Five sections fold: `statBlock`, `stats`, `settings`, `companion` and `owners`.

- **Stored.** `rvtt.tokenPanelFolds` in localStorage, read and written in try and catch as every `rvtt.*` key is, holds `{"statBlock":true,"stats":false,"settings":false,"companion":false,"owners":false}`. A missing key, bad JSON, a value that is not a boolean, or storage that throws reads as that section's default. One value serves every room, every token and both roles, so a DM who opens the stat block once sees it on every monster, and a DM setting up many tokens keeps Token settings open.
- **Defaults.** The stat block starts open on a layout at least 900 px wide and 600 tall, where the side panel has room for it beside the map. Elsewhere it starts folded: a phone, an upright tablet, and a large phone held sideways in the wide layout such as 932 x 430, whose side panel body is about 250 px tall. A block runs one to three phone screens and would push HP and conditions out of view. The other four start folded.
- **Resolved once per Room.** A Room scope slot, `panelFoldsSlot` in `client/features/tokens/panelFolds.ts` (the `scopeSlot` pattern of `statBlockOpen.ts:11`), resolves the five values the first time a token panel reads it, from storage and, for missing values, the defaults at the layout size of that moment. It keeps them for the Room's lifetime. Room draws the Token sheet and the side panel's tab in separate trees (`Room.tsx:524`, `:585`), so crossing 900 px remounts the panel, and the slot keeps the folds as they were instead of resolving the defaults again.
- **The request override.** A stat block request (3.4) sets a transient override in the Room scope, `statBlockOpened: { tokenId }`, beside `panelFoldsSlot` in the same file. While it names the selected token, that token's stat block shows open whatever the slot says. It lives in the Room scope, so it survives the remount when the layout crosses 900 px, either way. It clears when the selection changes to another token or to none, and when the viewer taps the stat block's fold, which then writes the slot and storage as any tap does. It never writes storage or the slot.
- **Written.** A viewer's tap on a fold writes the slot and storage. A request writes neither (above). The DM's "view as a player" preview has its own Room scope and slot, which reads storage and never writes it, as layout's `rvtt.sidePanel` (docs/design-v1-layout-hierarchy.md 4.1).

**Stays put.** The panel still remounts per token (`TokenPanel.tsx:63-64`), so an armed Delete or a half-typed field never carries over, and the folds come from the slot, not from the old mount.

On a desktop's side panel (327 inside), for the DM on an SRD goblin with the block open:

```
+------------------------------------+
| Goblin 4                           |
| Small (5 ft)  [Hidden from players]|
| (img) [Change image] [Add another image]
|       [Crop] [Remove]              |
|------------------------------------|
| v STAT BLOCK                       |
| (15) Speed 30 ft  Passive Perception 9
| Goblin Warrior                     |
| Small Fey (Goblinoid), Chaotic ... |
| AC 15 Initiative +2 (12)           |
| ... abilities, traits, actions ... |
| Stat blocks from the SRD 5.2.1 ... |
| [Copy to this room's monsters and edit]
| [Detach]                           |
|------------------------------------|
| HIT POINTS                [Healthy]|
| 10 / 10                            |
| [Damage][Heal][ Set ][Temp]        |
| [7 or -7              ] [Apply]    |
| Max HP [    10 ]  Temp HP [     0 ]|
| [Mark dead]                        |
|------------------------------------|
| CONDITIONS                   [Add] |
| None.                              |
|------------------------------------|
| POSITION                           |
| Elevation      [-5] [  0 ] [+5]    |
| Facing        [-45] [  0 ] [+45]   |
|------------------------------------|
| RANGE RINGS                        |
| (5)(10)(15)(30)(60)(90)            |
| (120)(150) [Custom ft]             |
|------------------------------------|
| NOTES                              |
| For everyone                       |
| [                                ] |
| On the card                        |
| [                                ] |
| For DMs only                       |
| [                                ] |
|------------------------------------|
| REST  [ Short rest ][ Long rest ]  |
|------------------------------------|
| > STATS                            |
| > TOKEN SETTINGS                   |
| > OWNERS                      None |
|------------------------------------|
| REMOVE    [Delete this token]      |
+------------------------------------+
```

A companion adds "> COMPANION   Bree" between Token settings and Owners. A token that is neither a PC nor a companion has the "Make a companion" button inside Token settings instead.

The Token sheet on a phone held upright (356 inside), the block folded at first:

```
+--------------------------------------+
| < All panels      Token          [X] |
| Goblin 4                             |
| Small (5 ft)                         |
| (img) [Change image] [Add another image]
|       [Crop] [Remove]                |
|--------------------------------------|
| > STAT BLOCK                         |
| (15) Speed 30 ft  Passive Perception 9
|--------------------------------------|
| HIT POINTS                  [Healthy]|
| 10 / 10                              |
| ...                                  |
+--------------------------------------+
```

The Token sheet on a phone held sideways (340 px wide, 306 inside, 259 with 47 px insets). The preview and both first buttons need about 320 px, so the buttons move under the preview. The pair needs about 264 px, so at 259 "Add another image" takes the next line (3.6):

```
+--------------------------------+
| Goblin 4                       |
| Small (5 ft)                   |
| (img)                          |
| [Change image]                 |
| [Add another image]            |
| [Crop] [Remove]                |
|--------------------------------|
| > STAT BLOCK                   |
| (15) Speed 30 ft               |
| Passive Perception 9           |
|--------------------------------|
| HIT POINTS ...                 |
+--------------------------------+
```

A player's own character, at the side panel: name, image row, then row 3b, "(16) Speed 30 ft Passive Perception 14 [Open the sheet ↗]", then HP and the rest, with Stats and Token settings (their Name fields) folded. A player looking at a goblin: the name the DM allows, the image without buttons, then HP as the DM allows (with the entry under "Players can apply damage and healing"), Conditions, Position as text, Range rings and the note for everyone when they have any.

**What the order saves**, for the DM on an SRD goblin at the side panel, counting 44 px rows and 18 px lines (estimates, checked in the e2e by the block's top): the name now leads instead of following about 300 px of image controls and help, the block's fold button starts about 200 px down instead of after every play section and the Stats form (some 20 rows of fields), and the folded foot is three 44 px rows (four on a companion) where Stats, Token settings and Owners were about 30 rows.

### 3.6 Name and image

**The name block.** The token's name (`displayName`, so "Goblin 4") as today's heading, whole, wrapping. Under it the size line and the tags (Hidden from players, Locked, Name hidden) on one wrapping line. The combat doc's companion tag ("Companion of Bree") joins them on a companion (3.10).

**The image row.** `ImageField` gains `previewSize` (the token panel passes 48, every other caller keeps 64) and `extra`, content placed in its button column. The row is the preview and a column, which hold, in order:

1. "Change image" (or "Add image") and "Add another image", as one pair.
2. "Crop" (an uploaded image only) and "Remove" (any image).
3. While the token has other images: "Other images", the images as 44 px buttons ("Wear image 1"), and "Remove one", with one help line under them, "Tap one to wear it." or, while removing, "Tap an image to remove it."

When the pair wraps, by plain flex wrapping and no fixed breakpoint:

- The pair's two buttons keep 8 px sides instead of 12, and the preview's gap is 8 px, so the pair is about 264 px at 14 px text (114 and 146, and a 4 px gap, as measured).
- The preview and the column share a line wherever the panel holds the preview (48), the gap (8) and the pair on one line, about 320 px. The column's basis is the pair's width. That is the side panel without a right inset (327 inside), a phone held upright (356) and every tablet.
- Otherwise the column moves under the preview at the panel's full width, and the pair shares a line wherever that width holds it, 264 px: a phone's sideways sheet without insets (306), the side panel of a large phone held sideways (268 with its 59 px inset) and a phone held upright at 130% (266).
- Under 264 the pair takes two lines, as in a phone's sideways sheet with 47 px insets (259) and the very short mode at 480 x 320 at 130% (243 inside). Where a line is narrower than one button, its label wraps inside the button, which grows taller and stays 44 px or more.

The Openverse credit stays under the row (`ImageField.tsx:86`). Someone who may not change the image sees the preview alone. Nothing comes between the image row and the stat block.

**"Add another image"** keeps its name and flow (picker, then crop, `AltImages.tsx:77-98`). Its purpose is in three places, so none depends on hover:

- `title`, the tooltip the project owner asked for: "Another image this token can wear, for Wild Shape or a disguise. A tap on it here or in the token's bar puts it on."
- `aria-describedby`, pointing at the same sentence in a visually hidden element (`VISUALLY_HIDDEN`, `client/lib/a11y.ts:24`).
- The picker it opens shows the same sentence as a visible line above its tabs (`ImagePicker` gains `hint`, its title stays "Choose an image"), so a phone user reads it on the first tap, with Close to back out.

At the limit of six (`MAX_ALT_IMAGES`), it is replaced by today's note, "That is as many as a token keeps. Remove one to add another." (`AltImages.tsx:76`). The empty state's two-line paragraph goes, since nothing is there to explain until an image is added.

### 3.7 Hit points

The section keeps its parts and order: the large number row with the life tag, the HP entry, then one row where there were two:

```
Max HP [ 100000 ]   Temp HP [ 100000 ]
```

Two labeled number fields at today's 88 px (`NUMBER_FIELD_WIDTH`, `components/Field.tsx:28`), which shows all six digits of `MAX_HP_AMOUNT` (100000), in a group named "Maximum and temporary HP". Their visible labels are "Max HP" and "Temp HP" and their accessible names stay "Max HP" and "Temporary HP", so the existing names hold. The two stand side by side at every width, in two equal columns (the project owner, 2026-10-16: a pair that wrapped onto two lines read as unrelated fields). Where the pair is at least 320 px wide, each label sits beside its field. Narrower, both labels go above their fields together, so the fields keep one line and never stagger. The pair's own width decides, through a container query, since the same section sits in the side panel, a phone's sheet and the Characters panel's card. A field gives up a few pixels before a wider label would push it out of its column. The columns hold an 88 px field down to a 192 px pair, narrower than any panel the app draws. Death saves (while dying), the stable note and the life buttons stay where they are, since death and revive belong to design-v1-combat-flow.md (3.10). While `hpLess` holds (3.2), the section follows the combat doc's HP-less state (its 3.6.6): no 0/0, no Bloodied and no HP entry. The Characters panel's card uses the same section and gets the same row.

### 3.8 The rest of the panel

**Stat block** (`StatBlockSection.tsx`). It moves to row 3, folds through the fold contract (3.5), and its header carries the summary line. Its fold button replaces "Show"/"Hide" (3.11). For a room or SRD link the content is today's: the block, the SRD credit, and under it Edit, or "Copy to this room's monsters and edit", and Detach. Those stay at the block's foot, under what they act on, and fold with it. With no link, the section's header is its label and "Attach a stat block" (the DM only) on one 44 px row, with the summary line under it, no fold and no note. A deleted link keeps its note and Detach. While the SRD chunk loads, "Loading the stat block…" as today (`:134`).

**Position.** Elevation and Facing, as today. Height, a setup number, moves into Token settings with its hint.

**Range rings.** The presets are 44 px circles, whatever their digits, so the row reads as one set. The field for another distance ends the same wrapping row, with no label or help lines under it: its placeholder "Custom ft" says what it takes, and its accessible name, "Custom ring distance in feet", starts with those words, so a voice user says what they see (the project owner, 2026-10-16). The project owner asked for the one block on 2026-10-16, after the help lines took more room than the rings. With four rings on, one short muted line shows under the row: "At most 4 rings. Turn one off to add another." The presets that are off and the field stay in the tab order, `aria-disabled` and described by that line, the field read only, and a tap on them does nothing. A disabled control would leave a keyboard or screen reader user no way to find it or the reason.

**Notes.** One section with up to three labeled fields: "For everyone" (the token's note), "On the card" (the actor's notes, which the DM and the actor's owners read, today's "Card notes" section) and "For DMs only". Each multiline field starts two rows tall instead of three (`ui.tsx:114`, a new `rows` prop) and still resizes. The section's rule is the union of today's two.

**Rest.** The fight warning (`RestSection.tsx:46`) shows only once a rest is chosen, so it no longer adds two lines to every creature's panel during a fight.

**Stats** (folded). `StatsSection` splits into exported parts, the fields, the sheet link and the notes, and keeps its combined export for the Characters panel's card, which does not change. The token panel draws the fields and the "Sheet link" field here, the link itself in the summary, and the notes in Notes.

**Token settings** (folded): today's fields plus Height. For the DM on a token that is neither a PC nor a companion, one more control, the "Make a companion" button, one design with the combat doc's (its 3.6.3). It opens, in place inside Token settings, "Belongs to" (a Select of the characters, none chosen) and the turn Select, starting at `shared` ("On Bree's turn, listed under Bree"), with a confirm button and Cancel, whose words are the combat doc's. The confirm sends one `token.update` with `companion` and stays disabled until a character is chosen. After it the button goes and the Companion section shows. Cancel closes the form and sends nothing. For an owner who may rename the token, the same fold holds Name and "Name others see" where they apply, which leave the top of the panel.

**Companion** (folded, on a companion only): the combat doc's section, whose contents are that doc's (its 3.6.9 and 3.7.6). This doc places it after Token settings and before Owners, since a companion's link decides its owners, and puts its fold in the fold contract (3.5).

**Owners** (folded) and **Remove**: unchanged inside, except what the combat doc shows in Owners for a companion.

### 3.9 AC on the map

**What shows.** A shield badge with the creature's AC in it, in the token's bottom left corner, inside its footprint, as the number badge sits in the bottom right (`TokenNode.tsx:176-189`). It is part of the marks (`tokenMarks`), drawn in the marks pass above every token and the fog, dimmed with a hidden token, and carried by a token being dragged.

It shows when all of these hold:

- The token is a creature (`pc`, `npc` or `monster`).
- The viewer's copy of its actor holds an `ac` from 1 to 100 (`shared/protocol.ts:204` allows 0 to 100). An AC of 0 is a companion with none, such as Spiritual Weapon (docs/design-v1-combat-flow.md 3.6.6), and shows nothing. The DM holds every creature's AC, and a player the AC of the actors they own (section 2), as the project owner decided (section 9). Other players, a player who owns a character's token but not the character, the table display and the DM's "view as a player" preview see no other AC, and nothing is added to any projection.
- It is not dead. A corpse's AC answers nothing, and the badge comes back with Revive.
- `hpLess` does not hold (3.2). An effect has no AC to answer, whatever its actor stores.
- The token is big enough for marks (`DECOR_MIN_PX`) and at least twice the badge's height tall, and its width holds the badge, a gap, and the number badge's width when the token has a picture and a number (since that badge may show at the bottom right, `showsNumberBadge`, `lib/boardText.ts:443-445`). Otherwise it gives way, and the bar and the tracker still say the AC.

**Its look.** The party bar's shield outline (`PartyBar.tsx:230`), kept as `SHIELD_PATH` in the new `client/components/AcBadge.tsx`, scaled to the badge's box, filled `surfaceRaised` with a 1 px `text` outline as the number badge is, and the number centered in `text` at weight 700 at the board's badge size (`badgeTextPx`, `lib/boardScale.ts:93`). Its height is `ceil(badgeTextPx + 9)`, and its width the larger of 0.85 of that and the number's measured width plus 8, so it fits 1, 2 or 3 digits. At the pin zoom and 100% that is 20 px tall, and 21 wide for 15 or 29 for 100, so a medium creature at 40 px a cell shows it, and at 30 px a cell only Large and up do. The Konva group is named `ac-badge` for the e2e.

**The padlock.** The lock moves into the marks too (`tokenMarks` returns its place, `TokenNode.tsx:144`, `:153-162` draw it there). Without an AC badge it keeps its corner. With one it stands just above the badge on the left edge, where the token is tall enough to keep it under the chip row (at the pin zoom, 51 px, so a Large creature). Where it is not, as on a locked medium creature at the pin zoom, the AC badge gives way and the lock keeps its corner, since a drag that does nothing needs its reason more than the AC. Neither badge is a label obstacle: both sit inside the token's own body box, which labels already keep off, so no label moves.

**In the DOM**, `AcBadge` draws the same shield with the number in it, sized to its content as the map's is: `md` for the bar and the panel, 22 tall and the larger of 20 or the number's width plus 8 wide (20 for 9, about 24 for 99, about 32 for 100) with a 13 px number, and `sm` for dense rows such as the tracker's and the party bar's, 18 tall and the larger of 16 or the number's width plus 6 wide with an 11 px number. A pure `acBadgeBox(ac, size)` gives the box, and returns nothing for 0. The badge is `role="img"` with the accessible name "Armor Class 15", and a `title` of "Armor Class" as an extra. The shield is the D&D sign for AC, and the panel's Stats field names it in words.

### 3.10 Interfaces with the other two docs

design-v1-combat-flow.md:

- The tracker row shows AC with the same badge as the token: `AcBadge` at `sm` from `client/components/AcBadge.tsx`, for each row whose actor the viewer's copy holds AC for, and none for 0 or the dead. Who sees which row's AC is that doc's call within the projection.
- A tracker row's "Stat block" calls `openStatBlock(scope, ui, tokenId)` (3.4). This doc's build makes that one-call change in `Row.tsx`, and whichever build lands second keeps the call.
- Death and revive: that doc's Revive follows the Dead tag on the bar's vitals line, for the DM, with its line under the vitals, and a player's healing line takes the same place (3.3). The AC shield leaves the vitals line on the dead, as on the map and in the tracker. That doc's dead lines under the HP entry's field are its own, and they follow the entry in both the full and the short layout. The panel's life buttons (`HpSection.tsx:275-288`) stay where 3.7 leaves them for that doc to change.
- Durations a detached companion leaves behind: that doc's explanation sits in this panel's Conditions section, beside the effects it concerns, since a detached token no longer shows the Companion section (that doc's 3.6.9).
- The HP-less companion: that doc owns the rule and the shared `hpLess(actor, token?)` predicate (its 3.6.6), including what turning a creature into an effect keeps. This doc's vitals, AC, HP entry, HP section and map badge read that one predicate (3.2).
- Companions and summons: the summary and the panel follow ownership of the actor, so a player who owns a wildfire spirit's token reads its vitals and, if it links an SRD monster, its saves. The name block's tag line names the link with that doc's words ("Companion of Bree"). Dismiss, for a companion's owners who are not the DM, takes Delete's place in the bar's less-often row (3.3). The panel shows that doc's Companion section on companions only, after Token settings and before Owners, folded through this doc's fold contract, and the "Make a companion" button sits in Token settings (3.5, 3.8).
- `TokenPanel.tsx` edits for companions (Owners' "Played by whoever plays Bree" text, "Players see HP as" showing "Follows Players see the party's HP", the name block's tag, the Companion section's component and the "Make a companion" button with its form) are that doc's build step 6. This doc's step 3 places them. Whichever build lands second keeps the other's edits in the order of 3.5.
- `TokenActionBar.tsx`: this build adds the summary, the short layout and the rows' order (`barButtons`), that one Revive, the dead lines and Dismiss. Whichever lands second puts the other's buttons where 3.3 says.
- `HpSection.tsx`: this build adds the Max and Temp row and `HpEntry`'s `fieldFirst`, that one the entry's dead lines and the HP-less state. Whichever lands second keeps both.

design-v1-layout-hierarchy.md:

- Foldable sections: `Section` in `components/Panel.tsx` gains `fold: { open, onToggle, summary? }` (3.5). If that doc defines a foldable section too, the two are one component and this doc takes its look.
- The token action bar, its button rows included, is this doc's (3.3), as that doc's 6.1 says.
- A collapsible side panel: `openStatBlock` and Details both open the token panel through `ui.openPanel("token")`, which that doc makes show a hidden side panel or sheet (its 4.1 and 4.2).
- The party bar is that doc's M9: it shows `AcBadge` at `sm` and "PP 13" as text. This build does not edit `PartyBar.tsx`. Whichever build lands second keeps `AcBadge.tsx` as 3.9 specifies, so if M9 lands first it creates the file to this spec and this build uses it.
- The app-wide grouping pass leaves the token panel and the token action bar to this doc.

### 3.11 What stays, and name changes

Every control keeps its function and keyboard path. Every fold button is a native button reached by Tab and toggled by Enter and Space. These names and places change, for the e2e and anyone who learned them:

| Before | After | Why |
| --- | --- | --- |
| The stat block's "Show the stat block" or "Fold the stat block" button, text "Show" or "Hide" | The section heading's disclosure "Stat block", `aria-expanded` | A disclosure's name never changes with its state (`Button.tsx:38-44`). |
| The "Card notes" section, its field named "Notes" | The "On the card" field in Notes, named "Card notes" | Three notes in one section. |
| The "Character sheet" section | "Open the sheet ↗" in the summary, the "Sheet link" field in Stats | The link is play, the field is setup. |
| Height under Position | Height under Token settings | Setup. |
| Name and "Name others see" at the panel's top, for an owner of a PC | The same fields in Token settings | Setup. |
| Details at the end of the bar's button row | Details in the bar's read-more row | It expands the summary. Same name. |
| The bar's one row of buttons in the order they were added | The play row and the less-often row, in 3.3's order | Ranked by use, Delete kept apart. Every button keeps its name. |
| The bar's Close, Escape and Back letting go while the token panel shows the token | They hide the bar and keep the token | The panel the DM reads stays filled (3.3). |
| The HP entry's mode row above its field, on every bar | On a short bar, the field and Apply first | Apply in view on a phone held sideways (3.3). |
| Escape with the bar hidden and a token selected, outside Select several: nothing | It lets go of the token | A keyboard way to deselect (3.3). |

`role="dialog"` and the names of both bars, the panel's tab and sheet names, the HP entry's names, "Change image", "Add another image", "Attach a stat block" and "Delete this token" stay.

### 3.12 Widths used in this doc

What content gets inside each box, after borders, safe-area padding and body padding (`components/Sheet.tsx:76-108`, `Room.tsx:1278-1286`, `:1333`, `TokenActionBar.tsx:700-725`), all border-box:

| Box | Inside |
| --- | --- |
| Side panel, 360 wide, 1 px left border, 16 px body padding | 327 |
| Side panel on a large phone held sideways in the wide layout, 932 x 430, with a 59 px right inset | 268 |
| Bottom sheet, phone held upright at 390, 1 px borders, 16 px padding | 356. At 130% (300 wide): 266. Upright tablet at 820: 786 |
| Right sheet, phone held sideways, 340 wide | 306. With a 47 px right inset, as an 844 x 390 phone has at any interface size: 259 |
| The very short mode (docs/design-v1-layout-hierarchy.md 4.2, `sheetMode` "full"): the whole screen less the side safe areas and 16 px padding, with no border | 243 at 480 x 320 at 130%, always. 523 at 649 x 300 with the turn band |
| Docked bar, 304 wide, 1 px borders, 12 px side padding | 278 |
| Spanning bar, phone held upright at 390 | 348. At 130%: 258 |
| Compact bar at 480 x 320 at 130%, 259 wide | 234, as measured |

## 4. Data model and protocol

None. AC, speeds, Passive Perception, `srdId` and `monsterId` are already on the actor and projected as section 2 says, and the saves and defenses come from blocks the DM's state or the SRD chunk already hold. Stored rooms, backups and event replay are untouched. The only stored value is this device's `rvtt.tokenPanelFolds` (3.5), which a missing or broken value reads as the defaults. `rvtt.*` keys are per device and never synced.

## 5. Edge cases and states

**By state and role.** "Viewing as" is the DM's "view as a player" preview, which runs on the previewed player's projection and its own Room scope, and never writes `rvtt.tokenPanelFolds`.

| State | DM | Player who owns it | Other player | Viewing as a player |
| --- | --- | --- | --- | --- |
| Monster linked to an SRD block | Bar: vitals, HP entry, saves, defenses, Stat block, Details. Panel: block at row 3 with the summary in its header. Map: AC badge. | Vitals, saves, defenses and Stat block (they hold `srdId`). Badge. | HP as allowed, Details. With "Players can apply damage and healing", the HP entry with Damage and Heal. No badge. | As the previewed player. Stat block opens the preview's own panel. |
| Monster or NPC linked to a room monster | As above, numbers read at once from state. | Vitals only: owners never get `monsterId`. No Stat block. Badge. | As above. | As the player. |
| Monster or NPC with no stat block | Vitals, Details, no Stat block. Panel row 3 is one row with "Attach a stat block" and the summary line under it. Badge. | Vitals, Details. Badge. | HP as allowed. | As the player. |
| Link to a deleted room monster | Vitals, no saves, no Stat block. Panel: the note and Detach, the summary line. | Vitals. | HP as allowed. | As the player. |
| Character | Vitals, "Open the sheet ↗" when linked, Details. Panel row 3b. Badge. | The same, for a player who owns the character. The sheet link is play, so it sits in the bar. | HP as "Players see the party's HP" allows. No AC, no badge (decided, section 9). | As the player. |
| A character's token the player owns, without owning the character | As a character. | The character's HP as other players see it, the HP entry (owners get it), no AC, speed or Passive Perception, no badge, no summary line in the panel (3.2). | As a character. | As the player. |
| Companion or summon a player owns (its own actor) | As a monster or NPC, Request a roll in the play row, and Delete, not Dismiss. The panel's Companion section after Token settings. | Vitals, and saves and Stat block when it links an SRD monster. Badge. Dismiss in Delete's place. Token settings holds its Name. | HP as the combat doc's companion rule allows. | As the player. Dismiss shows, and a press is refused there as every preview op is. |
| An HP-less token (`hpLess`: a companion that is an effect, or any token with max HP 0, such as Spiritual Weapon) | No vitals and no HP entry. Details, the play row, Delete. No badge. Panel: the combat doc's HP-less state. | The same, with Dismiss. | Nothing of its HP (the combat doc's 4.5). | As the player. |
| A creature companion turned into an effect, alive or dead | Its stored HP, AC and life stay, and `hpLess` holds: no HP item, life tag, Revive, AC or HP entry, no badge. Turned back into a creature, all of them return as stored. | The same, with Dismiss. | Nothing of its HP. | As the player. |
| Object or marker | HP only, Details. No badge. Panel: no summary line, no stat block. | The same. | As allowed. | As the player. |
| Hidden from players | As visible, dimmed on the map with its badge, the "Hidden from players" tag in the name block. | The token reaches its owners (`project.ts:310-314`): dimmed, with the tag, its vitals and its badge as for any creature they own. | Never on their device. | As the player: shown only if the previewed player owns it. |
| Name hidden from players | The real name, the "Name hidden" tag. | Its real name, since owners get the whole token. | The public name. | As the player. |
| Dying | Vitals with the Dying tag, the HP entry, death save pips under it, badge shown. | The same, and they fill the pips. | The label as allowed. | As the player. Pips flash refused. |
| Stable | Vitals with the Stable tag, the HP entry, the stable note in the panel, no pips. Badge shown. | The same. | The label as allowed. | As the player. |
| Dead | Vitals with the Dead tag and Revive after it, Revive's line under the vitals, no AC on the vitals line or the map, no pips. | Vitals with Dead, no AC, and the combat doc's healing line under them. No Revive. | "Dead" as allowed. With "Players can apply damage and healing", the healing line and the HP entry. | As the player. |
| Several selected | The group bar is unchanged: no summary, no Stat block. Each token keeps its badge. The panel shows the last one picked, as today. | The same. | The same. | The same. |
| A name of 80 characters | Bar header clips at two lines (bar-dock 1.2). Panel heading wraps whole. Plates on the map as today. | The same. | The same. | The same. |
| A long stat block (an ancient dragon) | Folded at first except on a large wide layout. Open, it pushes HP down the side panel, where the bar holds HP. Each defense line in the bar clamps at three lines. | An SRD Wild Shape's block, the same. | Not shown. | As the player: an SRD block the previewed player owns shows, the same. |
| Speeds in four or five modes (Adult White Dragon, or all five at 1000 ft) | The speed item wraps between modes in the bar and the panel, never inside one, with no horizontal overflow. On a short bar it sits in "More stats". | The same. | Not shown. | As the player. |
| AC of 9, 99 or 100 | The badge widens to its digits on the map, in the bar, the panel and the tracker. | The same. | Never had it. | As the player. |
| The SRD chunk still loading, or failed | "Loading saves…" after 200 ms in the bar, "Loading the stat block…" in the panel. Failed: "Saves did not load. Reload to try again." and Reload, in the panel "The stat block did not load." the same. Vitals never wait. | The same for an SRD Wild Shape. | Nothing loads. | As the player. |
| No AC on the actor (an old or partial actor), or AC 0 | The AC item and badge are left out. | The same. | Never had it. | As the player. |

**By size.** "130%" is the interface size. Layout sizes in parentheses. Inside widths are from 3.12.

| Size | Bar | Panel | Image row | Max and Temp HP | Stat block default, and Stat block's action | Map badge |
| --- | --- | --- | --- | --- | --- | --- |
| Phone upright, 390 x 844 | Spans (348 inside), full layout: vitals and saves each one line. | Bottom sheet, 356 inside. | Preview and both first buttons on one line. | Side by side, labels beside. | Folded. The action hides the bar (it folds under the sheet) and opens the sheet at the block. | Medium creatures at the pin zoom and closer. |
| Phone sideways, 844 x 390 with 47 px side and 21 px bottom insets | Docks at 304 (278 inside), at most 241 drawable, so short: AC and HP on one line, field and Apply next, "More stats". | Right sheet, 259 inside (306 without insets). | Buttons under the preview, the pair on two lines (it needs 264). | Side by side, labels above. | Folded. Keeps the bar beside the right sheet (441 px of free width). | As above. |
| Tablet upright, 820 x 1180 | Docks at 304, full layout. | Bottom sheet, 786 inside. | One line. | Side by side, labels beside. | Folded. Hides the bar (it folds under the sheet), opens the sheet. | As above. |
| Tablet sideways, 1180 x 820 | Docks at 304 left of the side panel, full layout. | Side panel, 327 inside. | One line. | Side by side, labels beside. | Open. Keeps the bar, opens the Token tab. | As above. |
| Desktop, 1280 x 800 | Docks at 304, full layout. | Side panel. | One line. | Side by side, labels beside. | Open. Keeps the bar. | As above. |
| Large phone sideways in the wide layout, 932 x 430 with 59 px side and 21 px bottom insets | Docks with at most 281 drawable (430 less 52, 60, 21 and 16), so short. | Side panel, 268 inside, its body about 250 tall. | Buttons under the preview, the pair on one line. | Side by side, labels above. | Folded (under 600 tall). Keeps the bar. | As above. |
| Phone upright at 130% (300 x 649) | Spans, 258 inside, short wherever its token stands (3.3): AC and HP on one line, the field and Apply next, in view, and "More stats". Compact only on a shorter phone (320 x 480, bar-dock 1.4), where it is short and the overlay scrolls. | Sheet, 266 inside. | Buttons under the preview, the pair on one line. | Side by side, labels above. | Folded. Hides the bar. | Badge 24 px tall, so tokens of 48 px and up. |
| Phone sideways at 130% with 47 px insets (649 x 300), no turn band | Docks at 151 tall, short: Apply ends 134 px down, in view. | Right sheet, 259 inside, body 109. | Buttons under the preview, the pair on two lines (it needs 264). | Side by side, labels above. | Folded. Keeps the bar beside the sheet (246 px of free width, over 230). | As above. |
| The same with the turn band in a band | Compact (163 tall), short, scrolls as a whole, and folds while the panel shows. | The very short mode: the whole screen, 523 inside, body about 223. | Preview and pair on one line. | Side by side, labels beside. | Folded. Hides the bar: the very short mode folds it. | As above. |
| Small phone sideways at 130% with 47 px insets (480 x 320, 369 x 246) | Compact overlay, 259 wide (234 inside), over the toolbar (bar-dock 1.4), short. Every line wraps, the whole overlay scrolls, and "Stat block" scrolls into view and takes a tap. | Always the very short mode: the whole screen, 243 inside, body about 169 with the bar put away, or with its Show in the header, where four buttons keep to one row. In a fight with the alerts summary in the header too, its five buttons stack the header, and the body is about 147. | Buttons under the preview, the pair on two lines. | Side by side, labels above. | Folded. Hides the bar: the very short mode folds it. | As above. |
| Desktop at 130% (985 x 615) | Docks at 304, full layout. | Side panel, 327 inside. | One line. | Side by side, labels beside. | Open (615 tall). Keeps the bar. | As above. |

**Other cases.**

- **The panel's first visit on a device.** Stored folds missing: the defaults, resolved once for the Room. Private mode or storage throwing: the defaults, kept for the Room, no error.
- **Crossing 900 px while open** (a rotation, a new interface size). The panel remounts in the other tree and reads the same Room slot and request override, so nothing refolds: not a fold from storage or the defaults, and not a block a request opened over a folded default. A request already sent keeps its focus target.
- **The token deleted or swapped while its block is open.** The panel remounts for the new selection or shows "Tap a token to see it here." as today. A pending request for a token that is gone is cleared by the next request or a new selection.
- **The selection on another scene** (a tracker row for a creature elsewhere). The row's Stat block shows only where it does today (`statBlockTokenId`), unchanged.
- **The side panel on another tab, a sheet already open, or the panel list open on a phone.** `ui.openPanel("token")` replaces it, as Details does. A blackout keeps the selection and the request, and the section answers it when it mounts again.
- **The bar compact on a short screen.** The summary and "More stats" scroll with the rest of the overlay. The field and Apply sit right under the vitals.
- **A docked bar under tall alert cards** (a desktop in a fight with several concentration checks). While its capacity is under 300 px it is short, and it returns to the full layout when the cards go. Its content never decides it, so it does not flip as the short layout shrinks it or as "More stats" opens.
- **"Make a companion" opened, then Cancel or a change of token.** Nothing is sent, and the form starts again at no character and `shared` next time.
- **Escape after "Stat block" with the bar open beside the panel.** It hides the bar and keeps the token in the panel. A second Escape lets go, and the panel shows "Tap a token to see it here." A tap on empty map lets go at once.
- **A room monster edited while its tokens show** (another DM device). The saves and defenses follow the state at once. The token's own AC and speeds do not, since a token is an independent copy (`statBlockLink.ts:5-12`).
- **Keyboard only.** Tab reaches every new button. The badge in the DOM is not focusable and is read by name. The fold buttons and "More stats" expose `aria-expanded`. Escape and Back keep their order from bar-dock section 3, with the change of 3.3.

## 6. FEATURES.md

Under "Tokens":

- New, after the line on numbered copies: "Each creature shows its AC on a small shield in the bottom left corner of its token. The DM sees every creature's, a player sees the AC of the creatures whose stats they have: their own character and creatures they own. A dead creature's shield hides, and on a token too small for it the action bar still says its AC."
- The line "Up to 6 other images per token…" gains: "In the token's panel, "Add another image" sits beside "Change image", and its tooltip and the picker it opens say what other images are for."
- New: "A token's panel starts with its name, then its image, then for a monster or NPC its stat block, whose header shows its AC, speed and passive Perception even when folded. Then HP, conditions, position, range rings, notes, rest and sight. Stats, token settings, a companion's settings and owners fold away at the foot. This device remembers which you opened, the stat block included. Max HP and temporary HP share one row."

Under "Phones, tablets and connection", after the action bar line from bar-dock:

- "The action bar opens with a summary: AC, HP, speed and passive Perception for a creature whose stats you have, then the HP entry, then for the DM a monster's or NPC's six saving throws and its resistances, immunities and vulnerabilities from its stat block. On a phone held sideways the bar keeps AC, HP and the HP entry at the top, and "More stats" holds the rest. "Stat block" opens the whole block in the token's panel, with the action bar still open beside it on a wide screen or a phone on its side, except where the panel fills a very short screen. A player's own character offers "Open the sheet". "Details" sits beside them."
- "The action bar's buttons come in two rows. The first holds what play needs: Undo move, Doesn't count and the door when they apply, then Conditions, Request a roll, Hidden, Light and Select several. The second holds Locked, Duplicate, Delete (or Dismiss for a companion's player) and Move bar."
- The line "Android's Back button and the Escape key close an open sheet, handout or action bar before they leave the room." gains: "While the token's panel shows that token, they and the bar's Close put the bar away and keep the token in the panel. With the bar away, Escape lets go of the token."

Under "Characters and monsters", the line "Full stat blocks on tokens…" becomes: "Full stat blocks on tokens: a monster or NPC token's panel has its stat block right under its image for the DM, with abilities, saves, skills, senses, languages, CR, traits, actions, bonus actions, reactions and legendary actions, and folds. "Stat block" in the token's action bar or a tracker row's options opens it. Edit opens a room monster in the editor, and an SRD monster offers "Copy to this room's monsters and edit". "Attach a stat block" links a token that has none, and Detach unlinks it."

docs/design-v1-visual.md 3.3's Token row gains "Order and folds: docs/design-v1-token-panel.md."

## 7. Tests

**Unit**, `node:test`:

- New `client/features/tokens/statSummary.test.ts`:
  - Vitals by viewer: the DM on a monster (AC, HP, speed, Passive Perception), an owner on a character (the same and the sheet link), a player who owns a character's token but not the character (HP only), a player on another's monster (HP as allowed only, none when hidden), an object (HP only), an HP-less companion (nothing), a living and a dead creature companion turned into an effect (nothing: no HP, life tag, Revive or AC), an actor missing each field in turn.
  - The units: the speed text split per mode (walk only, walk and fly with hover, walk 0 with fly, an Adult White Dragon's four, all five at 1000 ft), HP and temporary HP as separate units, no unit over 140 px by the measure the canvas uses (since Inter, no unit wider than the narrowest box's 234 px, by Inter's widths).
  - AC: left out at 0 and on the dead, shown at 9, 99 and 100.
  - The short layout's split: AC and HP in the vitals, speed and Passive Perception with saves and defenses in "More stats", and no disclosure when all four are empty.
  - Saves from a room monster (`statBlockOf`) and from an SRD monster (`statBlockFromSrd` of a real entry), with the SRD minus sign.
  - Defense lines: none, each one alone, all three in the block's order.
  - `linkedBlockState`: none, room, SRD loading, SRD ready, SRD failed, deleted, an SRD id the chunk lacks, a block that does not parse.
  - A player's view never yields saves for a room-monster link, since the view holds no `monsterId`.
- New `client/canvas/barButtons.test.ts`: the two rows for the DM on a monster (alive and dead), on an NPC, and on a creature a player plays, for a player on their own character, on their companion and on another's creature, docked and spanning, with and without Undo move, Doesn't count, a door and a vision scene. Details is in neither row. Dismiss takes Delete's place only for a companion's owners who are not the DM. `barShort` at a capacity of 299 and 300, at 844 x 390 (241) and 932 x 430 (281) with their insets, for a docked bar at 1280 x 800 whose lane holds alert cards tall enough to leave it under 300, and for a spanning bar on upright phones at 100% and 130%, which gives one answer wherever the token stands. A moved, bottom-anchored bar with alerts and a nonzero bottom gap gives the same answer for content of 220 and of 350 px, and opening "More stats" never changes it.
- New `client/features/tokens/panelOrder.test.ts`: the section list for the DM on an SRD monster, an unlinked NPC, a character, a companion and an object, for an owner of a character, of a character's token without the character, of a companion and of an SRD Wild Shape, and for another player on a monster. Companion shows only on a companion, and the "Make a companion" button only in the DM's Token settings of a token that is neither a PC nor a companion. Its form starts at no character and the turn `shared`, and sends one update only from its confirm.
- New `client/features/tokens/panelFolds.test.ts`: the defaults at 899 and 900 px wide and 599 and 600 tall. Resolution with a valid value, a missing key, bad JSON, a non-boolean, and storage that throws, each at 899 and 900. A slot resolved at 899 keeps its values when the layout then reads 900, and the other way, with empty, invalid and throwing storage. A tap writes the slot and storage, keeping the other sections' values. A request sets the override and writes neither. With the stat block folded in the slot (stored, and by default), a request at 899 px then a crossing to 900 px keeps the block open, and so does a request at 900 then a crossing to 899. Selecting another token, letting go, or a tap on the fold clears the override, and only the tap writes. A preview slot never writes storage.
- New `client/features/tokens/statBlockOpen.test.ts`: `openStatBlock` selects the token (or keeps a selection of it), sets the request with focus, and opens the token panel. It hides the bar where `foldsUnderSheet` holds (390 x 844, 820 x 1180, and the very short mode at 369 x 246 and at 649 x 300 with the turn band) and where the free width beside a side sheet is under 230 (513 x 288), and leaves it at 844 x 390, 649 x 300 without the band and 1280 x 800.
- `client/state/selection.test.ts`: `barDismiss` hides the bar and keeps the selection while the token panel shows it, and lets go otherwise. `dismissal` gives "token" for a selection with the bar hidden and Select several off, after `barDismiss`, after Details and after the alerts summary, and still gives "bar" and "group" where it did.
- `client/lib/escape.test.ts`: the "token" target comes after a sheet, a dialog, a text field, the bar and the group, and is not given while a label, pin or light pane is open, so that Escape closes the pane and the token stays selected. Back's rule is unchanged by it.
- New `client/components/acBadge.test.ts`: `acBadgeBox` for 0 (nothing), 9, 99 and 100 at `sm` and `md`, each wider than the one before from 99 on.
- `client/canvas/tokenMarks.test.ts`: the AC badge's box in the bottom left corner inside the footprint at 100% and 130%, and its width at 9, 99 and 100. Left out for an object, a dead creature, no `ac`, AC 0, a token for which `hpLess` holds, a token under twice the badge's height, and a token too narrow beside a reserved number badge. The lock in its corner without AC, above the badge when tall enough, and alone with the badge left out when not. `boxes` unchanged by either.
- `shared/project.test.ts`: a player's copy of a monster they do not own has no `ac`, `speeds`, `passivePerception`, `srdId` or `monsterId`. An owner's copy of an SRD-linked token with its own actor has `ac` and `srdId` and no `monsterId`. A player who owns a character's token but not the character gets the token with only `{ ref }` and the character without `ac`. A hidden token reaches its owner and no other player. These guard the badge and the summary.

No integration tests: nothing on the server changes.

**e2e**, one file after another as docs/design-v1-visual.md 5.3 says:

- New `e2e/tokenpanel.e2e.ts`, on E2E_PORT plus ten, as the other two docs assign it. A DM, a player who owns a character, an SRD Wild Shape token and a second character's token without that character, and a room with an SRD goblin, an Adult White Dragon, a room monster with a long Immunities line, a token with all five speeds at 1000 ft and AC 100, a token with AC 9, an unlinked NPC and a locked ogre.
  1. DM at 1280 x 800: tapping the goblin shows, in the bar, "Armor Class 15" by role img, "HP 10/10", "Speed 30 ft", "Passive Perception 9", then the HP entry, then the six saves, then "Stat block" and "Details". Its buttons come in 3.3's order, by their tops and lefts, with Locked starting a new line. The canvas holds an `ac-badge` with "15" on the goblin and none on the object. Damage that kills the goblin takes the shield off its vitals line and the map.
  2. "Stat block" leaves the bar open, selects the Token tab, and puts focus on the "Stat block" button with `aria-expanded` true, the block's name in view. With the panel scrolled to its top, that button's top is within 240 px of the tab panel's top, and the summary line sits under it. Escape then hides the bar, the Token tab still shows the goblin, and focus is on the Token tab. A second Escape lets go: the goblin's outline goes and the Token tab shows "Tap a token to see it here." `rvtt.tokenPanelFolds` is unchanged by the request.
  3. The panel's headings come in the order of 3.5. Stats, Token settings and Owners start with `aria-expanded` false, and no Companion section shows on the goblin. Opening Token settings and reloading keeps it open, and `rvtt.tokenPanelFolds` holds it. "Change image" and "Add another image" share a line with the preview (tops within 2 px), and so do "Max HP" and "Temporary HP", each label beside its field at 327 px. "Add another image" has the description of 3.6, and the picker it opens shows that line. The range rings are circles with the "Custom ft" field ending their row. Four rings on show the limit's line, and the other presets and the field are `aria-disabled`, take focus and are described by it, until Clear.
  4. The room monster: its Immunities line clamps at three lines in the bar and shows whole in the block. The unlinked NPC: no "Stat block" in the bar, and "Attach a stat block" in the panel's stat block row. The locked ogre at the pin zoom: the lock above the AC badge. The tokens with AC 9 and AC 100: the badge holds all digits on the map, in the bar and in the panel, its text inside its box.
  5. Overflow: the dragon's and the five-speed token's bars and panels, at 1280 x 800, 390 x 844 and 480 x 320 at 130% with 47 px side and 21 px bottom insets, have `scrollWidth` no wider than `clientWidth` for the bar, the summary and the panel body, and their speed items start new lines only at a mode.
  6. DM at 390 x 844: the bar spans with the vitals on one line. Details shows the block folded. Opening it, then tapping another monster and Details, shows it open. "Stat block" from the bar hides the bar, opens the Token sheet at the block, and focuses its button. Rotating to 844 x 390 keeps the block open. Then, with storage cleared and the slot folded, a fresh room at 899 x 844: "Stat block" on a monster, a resize to 900 x 844, and the block is still open in the side panel. The reverse, 900 then 899, the same. Tapping another monster shows its block folded.
  7. DM at 844 x 390 at 100% and at 130%, both with 47 px side and 21 px bottom insets, and at 932 x 430 with 59 px side and 21 px bottom insets: tapping the goblin shows Apply inside the bar's box without scrolling (`scrollTop` 0), with "More stats" closed under the HP entry and opening to show speed, Passive Perception, saves and defenses. With no fight running, "Stat block" keeps the bar open beside the right sheet, which opens at the block. At 130% with a fight running and the turn band in a band, it opens the very short mode at the block, and the bar folds into its header. The wrap checks follow the sheet mode and its inside width (3.12). In the side sheets (259 inside, at 100% and at 130% without the band) and the 932 x 430 side panel (268 inside), the image row's buttons sit under the preview, "Change image" and "Add another image" share a line exactly when the column is at least both buttons' widths and the gap, as measured, and otherwise stack, and the Max and Temp HP fields share a line with both labels above them. In the very short mode at 130% with the band (523 inside), the preview and both buttons sit on one line, and Max and Temp HP on one row, as the size table's row for it says. No horizontal scroll anywhere. The HP pair's labels are checked against the size table at every width the run visits: beside at 327, 356 and 786, above at 259, 266, 268 and 243.
  8. Player at 390 x 844: their character's bar shows AC, HP, speed, Passive Perception, "Open the sheet ↗" and Details, and no Saves. The second character's token they own shows its HP and no AC, and no `ac-badge`. The goblin's bar shows only its HP label and Details, the canvas holds no `ac-badge` on the goblin, and the player's socket state for the goblin has no `ac`. With "Players can apply damage and healing" on, the goblin's bar shows the HP entry with Damage and Heal. The Wild Shape token shows its saves after "Loading saves…" (the chunk's route delayed 600 ms), and its "Stat block" opens its SRD block.
  9. Several selected: the group bar has no "Stat block" and no Saves.
- `e2e/size.e2e.ts`, `desk.e2e.ts`, `bardock.e2e.ts` and `playerphone.e2e.ts` find Details, "Change image", "Attach a stat block" and the HP entry by name, so they run unchanged. Any of them that opens Token settings fields first opens the fold. A step that pressed Escape on a bar with the token panel showing now expects the bar hidden and the token kept, and one that pressed Escape with the bar hidden and a token selected (as the end of `desk.e2e.ts` case 8 does after Details) now lets go of the token.

## 8. Build plan

One workspace from the bar-dock build, four commits, FEATURES.md lines in the commit that ships each:

1. `feat(tokens): armor class shield on creature tokens`
   - New `client/components/AcBadge.tsx` with its test: `SHIELD_PATH`, `acBadgeBox` and `AcBadge` (`sm`, `md`), sized to the number. `PartyBar.tsx` is not edited here: the party bar is docs/design-v1-layout-hierarchy.md M9's, and whichever build lands second keeps `AcBadge.tsx` as 3.9 says.
   - `client/canvas/tokenMarks.ts` and its test: `ac` and `lock` in, their places out.
   - `client/canvas/useBoardText.ts`: passes `ac` (a creature, alive, 1 to 100, not `hpLess`), whether the lock shows, and the number badge reserve. `client/canvas/Stage.tsx`: hands `lockShown` (`:475`) to it.
   - `client/canvas/TokenNode.tsx`: `AcMark` (a Konva group named `ac-badge`: the shield path and the number), and LockMark at the place the marks give.
   - `shared/project.test.ts`: the privacy cases of section 7.
   - FEATURES.md: the AC line.
2. `feat(tokens): stat summary, stat block button and button rows in the token bar`
   - New `client/features/tokens/statSummary.ts` with its test, and `StatSummary.tsx` with `useLinkedBlock` and "More stats".
   - `client/features/tokens/statBlockOpen.ts` with its test: `openStatBlock`, the request's `focus`, and the bar rule of 3.4.
   - New `client/canvas/barButtons.ts` with its test: the rows' order and `barShort`.
   - `client/canvas/TokenActionBar.tsx`: the vitals line in place of the HP line, the HP entry right after it, saves and defenses, the read-more row with Details moved there, the short layout, and the two button rows drawn from `barButtons`. The combat build's Revive, dead lines and Dismiss go where 3.3 says, whichever lands second.
   - `client/features/tokens/HpSection.tsx`: `HpEntry` gains `fieldFirst`. The combat build edits the same entry, and whichever lands second keeps both.
   - `client/state/selection.ts` with its test (`barDismiss`, `dismissal`'s "token"), `client/lib/escape.ts` with its test (the "token" target), `client/pages/RoomChrome.tsx` (`useEscape`), `client/pages/Room.tsx` (`putAway`, and `tokenPanelShown` passed to Stage) and `client/canvas/Stage.tsx` (the bar's close): Escape, Back and Close while the panel shows the token.
   - `client/features/encounter/Row.tsx`: the row's Stat block calls `openStatBlock`. The combat build edits the same file, and whichever lands second keeps the call.
   - FEATURES.md: the action bar summary line, the button rows line, the Escape lines and the stat block line.
3. `feat(tokens): token panel order, folds and compact image and hp rows`
   - `client/components/Panel.tsx`: `Section` with `fold`. `client/features/tokens/ui.tsx`: `Section` passes it on, `TextField` gains `rows`.
   - New `client/features/tokens/panelOrder.ts` and `panelFolds.ts` with their tests: the section list, the fold defaults, the Room slot, the request override, reading and writing.
   - `client/panels/TokenPanel.tsx`: the order, the name block, the summary line, Height and the owner's name fields into Token settings, the "Make a companion" button's place, the Companion section's place on companions, and the folds. The companion edits inside it (Owners' text, "Players see HP as", the name block's tag, the Companion section and the "Make a companion" button with its form) are the combat build's step 6, and whichever lands second keeps both in 3.5's order.
   - `client/features/tokens/StatBlockSection.tsx`: the fold through the slot, the disclosure, the summary line in its header, the one-row Attach, focus on a request.
   - `client/features/images/ImageField.tsx` (`previewSize`, `extra`, the wrapping rule), `client/features/images/ImagePicker.tsx` (`hint`), `client/features/tokens/AltImages.tsx` (the add button and the other images in the column).
   - `client/features/tokens/HpSection.tsx`: the Max and Temp row (the combat build edits the same section, whichever lands second keeps both). `StatsSection.tsx`: its parts exported. `TokenNotes.tsx`: the card's notes. `RestSection.tsx`: the warning after a choice. `client/features/measure/RangeRingsSection.tsx`: the hint.
   - FEATURES.md: the panel and other images lines. docs/design-v1-visual.md 3.3's pointer.
4. `test(e2e): token summary, AC badge and token panel order`: `e2e/tokenpanel.e2e.ts`, and any fold-opening or Escape step section 7 names in the existing files.

## 9. Decided

The project owner answered on 2026-10-15, and design review round 1 settled three more points by their recommended defaults.

1. **Where "Stat block" opens: in the token's panel.** Decided by the project owner. The side panel on a wide screen or the Token sheet on a phone, not a separate pop-up (3.4).
2. **The stat block folded at first except on a large wide layout, then as last left on that device.** Settled by default (3.5).
3. **AC: the DM sees every creature's, players see their own.** Decided by the project owner. "Their own" is the actors their device holds: their characters and creatures they own outright. A player who owns a character's token but not the character sees no AC on it, and nothing is added to any projection (3.2, 3.9).
4. **The summary's contents: AC, HP, speed and Passive Perception, and for the DM a stat block's saves and defenses, without the initiative bonus or challenge rating.** Settled by default (3.2).
5. **A dead creature's AC shield hides, and comes back with Revive.** Settled by default (3.9), and the combat doc's tracker follows the same rule.
6. **The bar's HP entry comes right after the vitals line**, with saves, defenses and the read-more row after it, and on a bar under 300 px tall speed, Passive Perception, saves and defenses in one "More stats" disclosure (D3). Settled by default (3.3).
7. **The stat block sits directly under the image**, its header carrying the one-line AC, speed and Passive Perception summary, folded or open. Other images and the summary never sit between the image and the block (D4). Settled by default (3.5, 3.6).
8. **"Stat block" keeps the bar open wherever the bar docks beside the panel**, by `foldsUnderSheet` and the bar's 230 px narrowest width rather than 900 px (D5). Settled by default (3.4).
9. **A spanning bar's short layout is decided once per screen size**, from the least room any token's bar gets there, not from where the tapped token stands, so Apply sits in the same place on a device and in view (session 1 build review, Q2 and its round 2). Settled by default (3.3).

The order of the token action bar's button rows is this doc's (3.3), since both this doc and docs/design-v1-layout-hierarchy.md had left it to the other.

## As built: FL-13, proficiency in text (D-261030-539)

The saves line in the bar and under "More stats" (3.3) draws "Saves" and six plain units. FL-12's borders on a proficient save are gone, and `LinkedBlock` no longer carries a proficiency map. The stat block section lists proficiencies in the two lines described in docs/design-v1-dice-ui.md.
