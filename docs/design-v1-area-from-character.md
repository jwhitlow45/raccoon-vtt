# raccoon-vtt v1: an area from your character

Status: draft 2, after design review round 1 and the project owner's answers of 2026-10-17 (section 9, all decided). Code is cited from the wave 5 tip (`bbaf7cec`). This design builds on docs/design-v1-tool-options.md (the options row, its slots, priorities, value chips and popovers) and adds to its Area row (section 9.3) in one place, section 4 here. Widths and worked rows are in Appendix A, which verify rounds need not re-read.

The project owner's request (2026-10-17): "Also, for players the area feature should always have a 'from character/not from character toggle' present instead of having to tap on the character and then press area".

Every size is in layout px, as in the tool options design. "Your creatures" is defined in 3.1. "Placing" is the Area tool's state while an area is being aimed and not yet placed, "idle" its state with nothing in progress, and "picked" its state with a placed area picked, as in tool options 9.3.

## 1. Summary

- **From.** The Area tool's row gains one control, first in the row: "From Thorn". For a player with one creature on the scene it is a toggle, on by default. With two or more (a second character, a companion) it is a chip that picks which one, or No caster. With none it stays in its place, disabled, with the reason (decided, 9).
- **Always inline.** For a player it is always drawn while idle and placing, priority 1, with a 44 px square picture as its compact form. The row holds it, Shape and Place at every size the tool options design meets, the 230 px stacked row included, with the shared controls unchanged.
- **Two things, kept apart.** The saved choice says who your next area starts from, kept for the page across areas, tools and scenes. The area's caster says who the area being placed comes from. The control shows the first while idle and the second while placing (3.3).
- **Taps aim.** While your area is cast from one of your creatures, a tap on another creature aims the area at it rather than casting from it (decided, 9). Casting from someone else stays in More area options, as Set caster.
- **The DM** keeps today's flow and taps: a new area starts with no caster, and a tap on a token casts from it. Once an area is cast from a token, the same control names that token and drops or restores it.
- **One control for one job.** "Not from Thorn" (idle) and "No caster" (More area options) go. Set caster stays.
- No op, no schema, no protocol change, no server change, no new localStorage key, no new key. Nothing new reaches anyone else.

## 2. Today

- **The caster when the tool opens.** `activate` (`client/features/areas/AreaTool.tsx:309-318`) sets `defaultCaster` (`areas/store.ts:45-46`) from `defaultCaster()` (`areas/caster.ts:16-27`): a player's own selected token on this scene, else nothing. The DM never gets one, because a selection is often old and for something else (`caster.ts:9-15`). `setTool` keeps the selection (`state/store.ts:422-425`). The token window has no Area action (its buttons are Stat block, Details and Elevation, `canvas/TokenActionBar.tsx:375-390`), so "tap on the character and then press area" is a selection with the Select tool, then Area or A.
- **The idle row** (`areas/AreaOptions.tsx:335-365`). The line reads "Casting from Thorn. Tap a token to cast from it, or tap the map. Tap an area on the map to pick it." The row holds "Not from Thorn" (priority 2, tool options 9.3), Shape and Spell. Not from Thorn clears `defaultCaster` until the tool closes, and the only way back on is to select the creature and open the tool again.
- **Taps.** With nothing in progress, a tap on a token starts the last shape from it (`AreaTool.tsx:176-196`, `idleTapPicks`, `caster.ts:35-38`). A tap on open map starts it from `defaultCaster` where the shape starts from a caster (`:188-189`), else at the point. While a draft is out, a tap on another token casts from it (`fromToken`, `:113-116` and `:192-196`), a press with a caster aims from it (`:211-219`), and a sphere or cylinder goes on a tapped token (`:199-203`).
- **More area options** (`AreaOptions.tsx:488-500`): "Caster: Thorn" or "Set caster", a pressed toggle after which the next tap on a token picks the caster (`pickCaster`, `AreaTool.tsx:145-149`), and "No caster", which drops it and leaves the area where it stands (`:497`).
- **Copy** of a picked area starts a draft with the original's caster (`AreaOptions.tsx:523-525`, `draftFromTemplate`, `placement.ts:453-498`).
- **Drafts rebuilt.** A shape change (`withShape`, `placement.ts:162-178`) and a spell (`presetDraft`, `presets.ts:64-95`) build a new draft from the old, copying the fields they name. A spell's caster is the draft's, else `defaultCaster` (`applySpell`, `AreaOptions.tsx:196-202`).
- **What a caster changes.** The draft's `casterId` and `fromId` (`placement.ts:43-97`). Cones, lines and emanations start from a token (`usesFrom`, `placement.ts:115-117`), and so do cubes unless a cube spell is placed at a point (`presets.ts:66`). The template records `casterId`, which leaves the caster out unless Includes caster is on (docs/design.md 9.3), lets a cone cast from a creature turn around it (`caster.ts:53-68`), and gives a sphere its "30 ft from Thorn of 150 ft" reading (`AreaOptions.tsx:375-386`). An emanation around its caster moves with it by default (`attached`, `placement.ts:151`).
- **Who learns of it.** A shared preview sends geometry only (`aoeFrame`, `placement.ts:403-421`). A placed template's `casterId` reaches a player only while they can see the caster (`shared/project.ts:626-628`).

## 3. The From control

### 3.1 Which creatures it offers

The control offers, in this order:

1. **Your creatures on this scene** (players only): tokens on the scene in view that you own, directly or through their character (`ownsToken`, `features/tokens/access.ts:59-63`), companions included, objects (`kind: "object"`) left out. Your characters first, then the rest, each by the name you see (`displayName`), then by id. A creature the DM has hidden counts, since it still reaches its owner (`shared/project.ts:313-318`) and a tap on it casts today. A dying, stable or dead one counts too, but is never chosen by default (3.3).
2. **The area's own caster** while placing, when it is not one of yours and stands on this scene: the token it is cast from now, or was last cast from. The draft keeps that token as `lastCaster` once the caster is dropped, so a dropped caster can be turned on again. It comes from Set caster, Copy, or, with no caster of yours, a tap (3.5).

The DM's list is item 2 alone: the DM runs every token, so ownership says nothing about which one casts.

Where two offers would read the same (two tokens of one character), the later ones read "Thorn 2", "Thorn 3", in the list's order.

### 3.2 Its form

- **One offer: a toggle.** A pressed toggle, "From Thorn", pressed while the area starts from Thorn. One tap turns it off or on. Its name is fixed and `aria-pressed` says on or off (docs/design-v1-visual.md 3.7). Its tooltip is "Cast areas from Thorn".
- **Two or more: a chip.** A choice chip in the kit's chip look, whose words are the value: "From Thorn", "From Pip" or "No caster", drawn at the widest of them. Its popover, titled "Cast from", holds one row per offer, the picture before the name, a companion's name followed by "companion" in muted words, and No caster last. A pick closes it (tool options 7.2). Its name is its visible words, as the Kept rulers chip's is (tool options 9.2), since they already say what it sets.
- **None: disabled, with the reason** (a player with no creature on the scene, decided 9.2). It keeps its place and its slot, so the row never changes shape when a creature comes or goes. Its words are "From" and your first character by name, wherever that character is, or "From you" with no character at all. It is `aria-disabled` with the disabled look, and stays a Tab stop described by its reason, "None of your creatures is on this scene.", as the range ring presets do (`features/measure/RangeRingsSection.tsx:23-26`). Its tooltip says the reason, a press does nothing, and the idle line starts with the same sentence.
- **Compact form.** A 44 px square holding the picture: the creature's `Portrait` (`features/encounter/parts.tsx:27`) at `theme.layout.options.disk` (24 px), the token's image, else its character's, else initials. No caster and "From you" show a plain circle crossed by a slash, drawn in code in the toolbar's glyph style (tool options 17.2). The chip's square carries the small caret in its top right corner that the toolbar's menu buttons carry (tool options 5.1), in place of the caret beside its words.
- **Names.** The name is the one you see, cut with an ellipsis past a new token, `theme.layout.options.name` (the width of about ten characters), so a long name never sets the row's width. The whole name stays in the control's name and tooltip.
- **One element.** The toggle, the chip and the disabled toggle are one button in one slot, `from`, in a component of the areas folder built from the kit's button and chip looks, its popover base and `ChoiceRows`. A change between them while it has focus (a companion arriving) keeps focus on it. In the strip's measuring layer it draws a face with no handlers, as the kit's controls do (`useSlotPlace`, tool options 6.2). No shared control changes.

### 3.3 The saved choice and the area's caster

Two values, kept apart:

- **The saved choice** says who your next area starts from: a creature (its token id, and its character's id where it has one), "none", or nothing yet. It lives in the page's room scope (`AreaScope`, in place of `defaultCaster`, `store.ts:43-48`), as the last tool and tuck do. **While idle, the control shows it.**
- **The area's caster** is the draft's `casterId` (for a cone, line, cube or emanation cast from a creature, the same token as its `fromId`). **While placing, the control shows it**: on with that creature, or off.

**The saved choice resolves** against your creatures on this scene by the first of these that holds:

1. **A fresh selection of yours.** When the Area tool opens with one of your creatures selected (`selectedId`, also the last token of a Multi-select group, `state/selection.ts:16-17`), and that selection was made after the choice last changed, the creature becomes the choice. The scope counts every change of the room's selection, so an old selection never undoes the choice ("off" holds across tools with Thorn still selected), while letting go and selecting Thorn again still counts.
2. **The choice**, if it names one of your creatures here: by token id, else by the first token of the same character on this scene (`characterToken`, `features/rolls/logic.ts:48-56`), which is how it follows the party to another scene. "None" holds as none.
3. **The default**: your only living character here, else your only living creature here, else none. Living means its life is Alive. A companion never wins over a character, and two characters wait for a pick. A choice whose creature is no longer here resolves this way too, shown in the control before any area starts from it.

The DM has no saved choice: the DM's areas start with none, as today, for today's reason (`caster.ts:9-15`).

**A new area** starts with the resolved choice as its caster (`startDraft`), and with `lastCaster` set to it.

**What changes which:**

| Action | The area's caster | The saved choice |
|---|---|---|
| The control: on, off, or a pick of yours or No caster | Changes (placing) | Changes |
| The control: a pick of someone else's token (item 2) | Changes | Unchanged |
| A fresh selection of yours as the tool opens | (no area yet) | Changes |
| A tap or Set caster that makes one of yours the caster | Changes | Changes |
| A tap or Set caster that makes someone else's token the caster | Changes | Unchanged |
| Copy of a picked area | The original's | Unchanged |
| A shape change or a spell | Kept, `lastCaster` too | Unchanged |
| A creature leaves the scene or is deleted while placing | Only what pointed at that creature is cleared (below) | Unchanged |

**A creature gone.** When a creature leaves the scene or is deleted while an area is being placed, the draft clears only the references that point at it (`withoutCreature`). Every other reference and the area's free geometry stay:

- **`casterId` was it**, the active caster. The area has no caster. Where `fromId` was the same creature (a cone, line, cube or emanation cast from its edge), the area has no origin left and waits for a tap, as a draft whose token is gone does today. Where the area stands on its own (a sphere, a cylinder, a cube placed at a point), it stays where it is, with no range reading. Ice Knife keeps its target.
- **`fromId` was it, and it was not the caster** (Ice Knife's target). The target goes, the caster stays, and the line asks for a new target, as a fresh Ice Knife's does (`placementHint`, `presets.ts:98-104`).
- **Only `lastCaster` was it** (the caster already turned off). Only the offer to turn it back on goes. The area keeps its place and shape: Ice Knife on a goblin with From off still surrounds the goblin when Thorn is deleted.

Where the active caster is cleared, the control shows off, or disabled where you have no creature left here. Where only Ice Knife's target went, From stays on with its caster. Nothing stands in for the gone creature.

A reload starts again from step 3, which is right for every player with one character, so no device storage is added (the tool options design adds none either). The DM's "View as a player" page keeps its own.

### 3.4 What on, off and a pick do

In the idle state they set the saved choice, and the next area starts from it. While placing they set the area's caster at once:

| Shape | From a creature | No caster |
|---|---|---|
| Cone, line | Starts at the creature's edge (`castFromToken`), keeping its aim and pitch. Includes caster stays as set, off by default | Free: it stays where it stands and turns about its origin |
| Cube | On the creature's edge, its bottom at the creature's elevation, with Cube reaches. A cube spell placed at a point (`presets.ts:66`) stays where it is, the creature recorded as its caster | Free, centered where it stands |
| Emanation | Surrounds the creature, Moves with token on for a new area | Free, around where it stands |
| Emanation around a target (Ice Knife) | The creature is the caster. A tap picks the target, as today | The target stays, with no caster |
| Sphere, cylinder | Stays where it is placed, or waits for a tap. The creature is recorded, so the line reads the distance from it against the spell's range | Stays, with no range reading |

"From a creature" sets `casterId`, and `fromId` too where today's preset rule starts the shape at a caster (`presets.ts:66`), and sets `lastCaster`. "No caster" is today's No caster (`AreaOptions.tsx:497`): `casterId` and `fromId` go, a target emanation keeps its target, the area keeps where it stands (`freePointOf`), and `lastCaster` stays.

**Rebuilt drafts keep the caster.** `withShape` and `presetDraft` both carry `lastCaster` over, as they carry the draft's id. A spell picked while placing takes the area's caster, or none while it is off, and never falls back to the saved choice: `applySpell` reads `casterId`, else `fromId` for a shape that is not a target emanation, and nothing more. While idle, the spell's draft is a new area, which starts from the saved choice (`startDraft`). So off, a shape change, then on, comes back from the same creature, and so does off, a spell, then on.

### 3.5 Taps

For a player, **while the area's caster is one of your creatures** (placing), or while idle with the saved choice on, a tap on any other token aims rather than casts (decided, 9.1):

| Shape | A tap on another token |
|---|---|
| Cone, line, or cube cast from the caster's edge | Aims from the caster toward the token's center, snapped by Rotation snap, and a drag from that press keeps aiming (today's aim, `AreaTool.tsx:211-219`, with the token's center for the press) |
| Cube placed at a point (Entangle, Black Tentacles: a caster and no `fromId`, `presets.ts:66`) | Centers the square on the token by the free cube's snapping rule, at the height that rule gives (`snapCubeCenter` and `freePointHeight`, `:224-227`). The caster stays, `fromId` stays unset, the aim is kept, and a drag from that press moves the square, as the free cube's center grab does. The same whether the cube has no point yet or already stands elsewhere, and for a tap on the caster itself, so the cube never turns into one cast from the caster's edge (today's token branch, `:192-196`, would make it so) |
| Sphere, cylinder | Goes on the token, as today (`:199-203`) |
| Emanation around the caster | Stays around the caster |
| Emanation around a target | Picks the target, as today |

A tap on the caster itself grabs the aim, as today (`:216-217`), except for a cube placed at a point (its row). To cast from someone else, Set caster in More area options picks any token, yours included. A chip pick picks among yours.

Otherwise every tap rule of `AreaTool.tsx` stays: with no caster, a tap on a token casts from it, on open map it starts at the point, and on a placed area's open ground it picks that area. The DM's taps are today's in every state, since a DM's caster is never "one of yours". A player's area cast from someone else's token (through Set caster, Copy, or a tap with From off) also keeps today's taps, as the DM's does.

**The line.** Idle with From on, it says what a tap does with the last shape used: "Casting from Thorn. Tap the map or a creature to aim it. Tap an area on the map to pick it." for a cone, line or cube, "…to place it." for a sphere or cylinder, and "Casting from Thorn. Tap the map to start it around Thorn. Tap an area on the map to pick it." for an emanation. Idle with it off: today's line. A player with no creature here: "None of your creatures is on this scene." before today's line. While placing, the line is today's, except for a cube placed at a point with your creature as its caster, whose hint "Tap a token to cast from it, or tap the middle of the square." (`presets.ts:101`) becomes "Tap the middle of the square, or a creature to center it there."

The control follows the taps by the table in 3.3. A press on the map moves nothing under the finger, and the row refits by the tool options rules (6.4).

### 3.6 In the row

| | Idle | Placing | Picked |
|---|---|---|---|
| Slot `from`, a player | First, priority 1, always drawn | First, priority 1, always drawn | Not drawn |
| Slot `from`, the DM | Not drawn | First, priority 1, while the area has an offer (3.1) | Not drawn |
| Compact form | The 44 px picture square | The same | |

- **No glyph-and-words form.** The slot carries no `glyph` flag (tool options 6.2): words, or the square alone where the fit needs the room.
- **Why first.** It says whose area this is before what shape it takes, and it stands in the same place in both states.
- **Why not when picked.** That row edits a placed area, whose caster this control does not change, and its line already says "cast by Thorn". The control comes back with Done or a tap away.
- **The fit**, from the real `fitRow` and measured widths (Appendix A). Area's priority-1 set while placing becomes From, Shape and Place: in compact forms with ⋯ it is 223 px (44 + 60 + 63, two gaps, ⋯), under `MERGE_MIN` (256, tool options 4.1) and the narrowest stacked room (230, at 320 x 568 at 130%). So From, Shape and Place are inline at every size in tool options 4.3 and 13.1, for any name length and either form. The costs, accepted (decided, 9.3): Cancel (priority 2), inline today from 304 px, waits behind ⋯ below 422 px with a short name (Appendix A gives the other forms). Shared (priority 4), inline today from 387 px, waits behind ⋯ below 538 px and from 591 to 622 (a computer's floating row, the DM's pair at 932 x 430, an upright tablet at 130%), and is inline from 715.
- Tuck, the holds, the pins and focus follow the strip's rules unchanged.

### 3.7 The DM

- **Idle**: no control, since the DM's list is empty (3.1). Today's row and taps.
- **Placing**: once the area is cast from a token (a tap, Set caster, or Copy of an area with a caster), the toggle "From Goblin 1" shows, on. Off drops the caster and leaves the area where it stands. On brings it back to the goblin's edge. The toggle stays for that area, so a dropped caster can come back.
- **No list of every token.** A scene of thirty goblins is a worse picker than the map, and a tap already casts from any of them.

### 3.8 State and sync

- The saved choice is the page's alone (3.3). The control changes the draft, which is private as today. A shared preview's frame carries geometry only, so a caster change reaches other devices only as the area's new shape and place, as a drag does.
- `template.create` carries `casterId` as today, and the projection drops it for anyone who cannot see the caster (`shared/project.ts:626-628`).

### 3.9 Accessibility and keys

- **The toggle**: a button with the fixed name "From Thorn" and `aria-pressed`, 44 px tall. In its compact form the name stays and the tooltip says it whole (tool options 9.6's naming rule).
- **The disabled toggle**: `aria-disabled`, still a Tab stop, its description the reason (3.2).
- **The chip**: `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`. Its popover is a non-modal dialog named "Cast from", holding a `radiogroup` of native radios named "Cast from", the chosen one checked. In its compact form its name stays its words.
- **The line** stays the polite live region. The toggle changes the idle line's first sentence, so a screen reader hears the change there too.
- **Keys.** No key and no key-plus-pointer combination is added. The control is a Tab stop in the row, pressed with Enter or Space as any button, and the chip opens with the keyboard by the existing `optionsOpenKey` row. A letter that works in one tool's row only would be the room's first, and most players are on phones. The shortcut sheet does not change.

## 4. Shared contracts

Additions to docs/design-v1-tool-options.md, stated here once. The strip, the fit, the value chip and the popover base stay that design's, and this design adds no rule to them.

- **9.3, idle.** The slot "Not from Thorn" is replaced by `from` (3.6): first, priority 1, compact: the 44 px picture square, always drawn for a player. The line as 3.5.
- **9.3, placing.** `from` first, priority 1, compact: the same square. "No caster" leaves More area options. Set caster ("Caster: Thorn") stays there, and is how a player casts from someone else's token while their own is the caster (3.5).
- **9.3, picked.** Unchanged.
- **13.2's Area rows.** As Appendix A.
- **7.2, rows.** A row option may carry a picture before its words, as it carries a swatch (`RowOption`, `features/measure/controls.tsx:1046`).
- **4.1's floor.** Unchanged. Area's priority-1 set stays under it (3.6).

## 5. Edge cases

### 5.1 By situation

Pat is a player with the character Thorn. "On" and "off" are the control's state as the Area tool opens.

| Situation | What the control shows |
|---|---|
| Thorn on the scene, nothing selected | Toggle "From Thorn", on |
| Thorn and his companion Pip | Chip "From Thorn" (the only character), Pip and No caster in it |
| Two characters, Thorn and Ash | Chip "No caster" until one is picked, then that one |
| Pip only, Thorn elsewhere | Toggle "From Pip", on |
| Thorn on another scene | "From Thorn", disabled, with the reason |
| No character at all | "From you", disabled, with the reason |
| Thorn hidden by the DM | As if shown: "From Thorn", on |
| Thorn dying, stable or dead | Toggle "From Thorn", off. A tap turns it on |
| Pip selected as the tool opens, or the last token of a Multi-select group | "From Pip", on, and saved |
| A goblin selected as the tool opens | Ignored, as today |
| Pat selects Thorn, opens Area, turns it off, picks Draw, then Area with Thorn still selected | Still off (no fresh selection) |
| Pat turns it off, lets go of Thorn, selects him again and opens Area | On (a fresh selection) |
| Pat, with it off, taps Thorn while placing a cone | The cone casts from Thorn, and the toggle turns on |
| Pat, with it on, taps a goblin while placing a cone | The cone aims at the goblin. Still "From Thorn" |
| Pat, with it on, taps Pip | The cone aims at Pip. To cast from Pip, the chip |
| Pat, with it on, uses Set caster on a goblin | The cone casts from the goblin. The chip "From Goblin 1" holds Thorn and No caster. The saved choice stays Thorn |
| Pat copies a placed area cast by a goblin | Placing shows "From Goblin 1". After it, idle shows the saved choice |
| Off, then a shape change or a spell, then on | Back from the same creature (3.4) |
| The caster of a cone from Thorn is deleted while placing | Off, no substitute. The cone waits for a tap |
| Thorn deleted while his Fireball waits to be placed | Off. The sphere stays where it is, with no range reading |
| Ice Knife on a goblin, From off, then Thorn deleted | Still around the goblin. Only the offer to turn Thorn back on goes |
| Ice Knife's target deleted | The caster stays, and the line asks for a new target |
| Entangle from Thorn, a tap on a goblin | The square centers on the goblin, still cast by Thorn, with no `fromId`. A drag from the tap moves it |
| The DM adds or removes Pip during play | Toggle and chip switch. The choice holds while its creature is here. Focus stays on the control |
| The party moves to another scene | The tool resets as today. Thorn's token there is found by his character |
| A reload | The default (3.3 step 3) |
| Picked | No control. Back after Done |
| Tucked | It tucks with the row |
| A phone sheet or the very short sheet | Hidden with the options, as today |
| The DM, idle | Nothing |
| The DM, placing after a tap on a goblin | Toggle "From Goblin 1", on. A tap on another goblin casts from that one, as today |
| The DM's "View as a player" page | Pat's control, with its own choice |

Each shape: 3.4 and 3.5.

### 5.2 By size

The control is inline while idle and placing, for a player and for the DM's caster, at every size the tool options design lists (4.3, 13.1): phones upright (stacked, 230 to 374 px), sideways (merged 275 to 422, the pair 301 to 387, stacked 259 and 370 at 480 x 320), an upright tablet (804, 615), computers (floating 591 and 622, merged 715 and 960 at 1280 x 480), at 100% and 130%. The narrowest rooms show the square alone. Appendix A gives each room's row.

### 5.3 Self-sweep

Swept against 5.1, 5.2 and each shape before commit. Fixed as classes before round 1:

- three controls for one job (Not from Thorn, No caster and the new control)
- a choice lost when the tool closed
- token ids that differ between scenes
- a toggle that vanished once turned off (`lastCaster`)
- a chip that said No caster while a goblin cast
- the DM's stale selection
- a dead default
- hidden creatures
- a change of kind under focus
- long names setting the row's width
- anything new on the wire

Round 1, each fixed as a class:

- **A stale selection undoing a choice**: only a fresh selection counts (3.3 step 1).
- **The next area and the area in hand shown as one value**: the saved choice while idle, the area's caster while placing, with every action's effect on each in one table (3.3).
- **Rebuilt drafts dropping state**: `withShape` and `presetDraft` carry `lastCaster`, and a spell never falls back to the saved choice while placing (3.4).
- **A gone caster replaced silently**: cleared, never substituted (3.3).

Round 2, each fixed as a class:

- **A shape the tap table left out** (a cube placed at a point, whose caster has no `fromId`): its own row, and the table now names every way a draft can hold a caster (3.5).
- **A departure that cleared more than its own references** (Ice Knife's target lost with its former caster): `withoutCreature` clears only what pointed at the creature that left (3.3).
- **Widths assumed rather than measured**: the shared controls' widths are read from the dev room's measuring layer, the new control's are measured from its looks, the compact form is a 44 px square so the set fits the unchanged Shape and Place, and every worked row comes from the real `fitRow` (Appendix A), for short and capped names and both forms.
- **A control whose place changed with the scene**: always drawn, disabled with none (decided, 9.2).
- **Taps that pulled against the toggle**: a tap aims while your creature casts (decided, 9.1). The line says so.

Checked and left alone: the DM's taps, the spell presets, the reminders (they read the template, which is unchanged), the shared preview, the token window (it has no Area action).

## 6. Tests

Unit tests, `node:test`:

- `client/features/areas/caster.test.ts`:
  - `areaCreatures`: owned directly and through the character, a companion, a hidden one, not an object, not one on another scene, not someone else's, characters first then by name, "Thorn 2" for a second token of one character, none for the DM.
  - `savedChoice`: a fresh selection of yours wins and becomes the choice, an old one does not (off with Thorn still selected stays off), letting go and selecting again counts, someone else's selection is ignored, the choice by token and then by character on a new scene, "none" holds, the only living character, the only living creature, a dying or dead one never the default, two characters give none, a gone creature falls to the default, the DM none.
  - `fromShows`: idle shows the saved choice, placing shows the area's caster, for each row of 3.3's table: Copy of a foreign caster's area, Set caster on a goblin, explicit None, the caster deleted (off, no substitute).
  - `withoutCreature`: the active caster of a cone deleted (no caster, no origin, waits for a tap), of a sphere or an Entangle cube (no caster, the area stays), of Ice Knife (its target stays), Ice Knife's target deleted (the caster stays), and an already-off Ice Knife on a goblin with Thorn deleted (still on the goblin, `lastCaster` cleared, nothing else changed).
  - `castFrom`, for every row of 3.4, on and off: `casterId`, `fromId`, the point kept or cleared, a target kept, `lastCaster` kept after off.
  - `fromOffers`: the area's caster joins when it is not yours and stays after off, and the form (toggle, chip, or disabled with its words) by count.
  - `tokenTap`: for each row of 3.5's table and each role, whether a tap aims, casts, centers or picks a target, keyed on whether the caster is one of yours. Entangle with Thorn as caster: a fresh draft (no point) and one already standing elsewhere, a tap on a goblin centers the square on it by `snapCubeCenter`, keeps `casterId` Thorn and leaves `fromId` unset, and its gesture is the center grab, so a drag from the tap moves the square. A tap on Thorn centers it on Thorn the same way.
- `client/features/areas/placement.test.ts` and `presets.test.ts` (new where missing): off, then `withShape`, then on, and off, then `presetDraft`, then on, both from the same creature.
- `client/pages/optionsLayout.test.ts`: `fitRow` for Area placing and idle with `from`, at every room of Appendix A, for a short name, a capped name and both forms, with the measured widths: From, Shape and Place always inline.

e2e:

- New `e2e/areas.e2e.ts`, on the next free port offset when it lands (17 today, unless the parallel split panel build takes it). A DM on a computer, Pat on a phone (390 x 844, then 844 x 390, then 320 x 568 at 130%) and Kim on a second phone, a scene with Thorn and three goblins, and a second scene:
  1. Pat opens Area with nothing selected: "From Thorn" is pressed. A drag from open map aims a cone from Thorn's edge, and Place stores Thorn as `casterId`.
  2. With Thorn selected: Area, then off. Draw, then Area with Thorn still selected: still off. Let go of Thorn, select him again, Area: on. Off: a tap on the map starts a free cone there, and Place stores no caster.
  3. With it on, a tap on a goblin while placing a cone aims the cone at it, and the toggle stays "From Thorn". Set caster on the goblin: the chip "From Goblin 1". Place, Done: idle shows "From Thorn". Entangle from the search, then a tap on a goblin: the square centers on it and the template stores Thorn as caster. Moved elsewhere, a tap on another goblin centers it there, and a drag from that tap moves it.
  4. Fireball with From on: the line reads its distance from Thorn against 150 ft. Off: no distance.
  5. Spirit Guardians surrounds Thorn and moves with him once placed.
  6. The DM adds Pip: the chip "From Thorn", with Pip and No caster in its popover, each with its picture. Pip picked: Burning Hands from Pip's edge. A reload: "From Thorn".
  7. Off, a shape change, on: from Thorn again. Off, Burning Hands from the search, on: from Thorn again.
  8. Copy of the goblin's placed area: placing shows "From Goblin 1", and idle afterwards shows the saved choice.
  9. The DM moves Thorn and the players to the second scene: "From Thorn", on, from the token there. The DM deletes Thorn's token while Pat places a cone from him: off, nothing in his place. Ice Knife on a goblin with From off, then Thorn deleted: still around the goblin. With Thorn gone: "From Thorn" disabled, a Tab stop with its reason, and the idle line says why. Thorn dead: off by default.
  10. The DM: no control while idle. A tap on a goblin: "From Goblin 1", on. A tap on another goblin casts from it, as today. Off leaves the cone where it stands, on brings it back to the goblin's edge. More area options holds Set caster and no No caster.
  11. At 320 x 568 at 130%, idle and placing, with a short and a ten-character name: the square, the shape glyph and Place inline, and their drawn widths match Appendix A's.
  12. Accessibility: the toggle's name and `aria-pressed`, the disabled toggle's description, the chip's dialog and radio group, focus kept on the control as Pip arrives.
  13. While Pat changes the control with Shared off, Kim's socket gets no ephemeral event and no op.
- `e2e/options.e2e.ts`: the sweep gains "Area idle, two creatures" (the chip), "Area idle, no creature" (disabled) and "Area placing, from a goblin" (the DM's toggle), so its priority-1 rule checks `from` inline in the merged and pair arrangements and its reach rule checks it at every size.
- `e2e/smoke.e2e.ts` test 6 passes unchanged (Thorn's drag casts from Thorn either way) and gains one check: "From Thorn" is pressed.
- The build runs `areas`, `options`, `smoke`, `layout` (its Area tests read the row's controls) and `reach`.

## 7. Build plan

One part in one workspace, after wave 5 deploys. Each commit typechecks, passes the unit tests and builds.

1. `feat(areas): which creature an area is cast from, as pure rules`: `client/features/areas/caster.ts` (`areaCreatures`, `savedChoice`, `fromShows`, `fromOffers`, `castFrom`, `tokenTap`, `withoutCreature`, with `defaultCaster` folded into `savedChoice`) and its test, `lastCaster` on `AreaDraft` and carried by `withShape` (`placement.ts`) and `presetDraft` (`presets.ts`), with their tests.
2. `feat(areas): a from toggle always in the area tool's row`: a new `areas/FromControl.tsx` (3.2), `areas/AreaOptions.tsx` (the `from` slot while idle and placing, the lines, Not from Thorn and No caster removed, `applySpell` without the saved choice while placing), `areas/store.ts` (the saved choice and the selection count in `AreaScope`), `areas/AreaTool.tsx` (`activate` reads a fresh selection, a new draft starts from the choice, taps by `tokenTap`, a tap or Set caster on your creature sets the choice, a departed creature through `withoutCreature`), `features/measure/controls.tsx` (a row's picture), `components/Icon.tsx` (the no-caster glyph), `lib/theme.ts` (`theme.layout.options.name`), the fit tests, FEATURES.md and docs/features.md (section 8).
3. `test(e2e): the area's from control`: `e2e/areas.e2e.ts`, the three states in `e2e/options.e2e.ts`, the check in `e2e/smoke.e2e.ts`.
4. `docs: point the tool options design's area row at the from control`: one line under docs/design-v1-tool-options.md 9.3, "Amended by docs/design-v1-area-from-character.md section 4."

## 8. FEATURES.md

In "Areas of effect", after "Place an area freely, or cast it from a token…":

- "A player's area tool always shows who the next area comes from, such as "From Thorn". It starts on when Thorn is your only character on the scene, and a tap turns it off or on. With a companion or a second character it lists them, and No caster. With none of your creatures on the scene it stays, greyed out, and says why. It stays as you left it until you reload, and selecting your creature before opening the tool still casts from it. While an area comes from your creature, a tap on another creature aims it there. Set caster in More options casts from someone else. The DM's areas start with no caster, and once one is cast from a token the same button drops or restores it."

docs/features.md section 9, the line "A new area starts from the player's own selected creature…" gains: "Built in v1 wave 6: the area tool always shows a player's From control, on for their only character on the scene, a list with a companion or a second character, disabled with the reason when none is here, and kept for the page. While it is on, a tap on another creature aims at it."

The shortcut tables do not change.

## 9. Decided

The project owner answered on 2026-10-17:

1. **A tap on another creature while "From Thorn" is on aims the area at it.** Casting from someone else stays in More area options (3.5).
2. **"Always present" means always drawn.** With none of a player's creatures on the scene the control is disabled, with the reason, so its place never changes (3.2). The row is fitted with it always present (3.6, Appendix A).
3. **Cancel and Shared go behind ⋯ while placing where the row is tight.** From, Shape and Place stay inline. Cancel waits behind ⋯ below 422 px (inline today from 304), which is most phones. Shared waits behind ⋯ below 538 px and from 591 to 622, a computer's floating row at 1280 x 800 included (inline today from 387), and stays inline from 715. Both are one tap away, and picking another tool also discards the area. The tool options design's Area row is unchanged.

## Appendix A. Worked rows

**Widths.** The shared controls' were read from the dev room's measuring layer (`[data-measure]`, `/dev/room` at 1280 x 800): Shape 111 (135 with its glyph, 167 hosting Size, 191 hosting with its glyph, 60 compact), Size 152, Place 63, Shared 74, Cancel 72, Spell 96 at least and 170 at most. The From control's were measured from its looks in Chrome, with the same mock giving Place, Cancel and Shared to the pixel: the toggle "From Thorn" 104 and at the name cap 133, the chip "From Thorn" 118 and at the cap 147, the compact square 44. ⋯ is 44 and its gap 4, slots 4 apart.

**Method.** Each row below is the output of `fitRow` (`client/pages/optionsLayout.ts:282`) for that room, with no pins. The build's `optionsLayout.test.ts` cases are these rows. "Square" is From's compact form, "shape glyph" the shape chip's glyph alone, "glyph and Sphere" its glyph beside its words, "Sphere 20 ft" its words hosting Size.

**Placing**, a sphere, From as a toggle with a short name ("From Thorn"):

| Room | Rooms of tool options 4.3 | Row (then ⋯) | Today, without From |
|---|---|---|---|
| 230, 259, 275 | 320 x 568 and 480 x 320 at 130% (stacked), 667 x 375 (merged) | square, shape glyph, Place | Sphere, Place at 230. glyph and Sphere, Place at 259 and 275 |
| 284, 301, 304 | 390 x 844 at 130%, 667 x 375 at 130% (pair), 320 x 568 | From Thorn, shape glyph, Place | Sphere 20 ft, Place. At 304 Sphere, Place, Cancel |
| 343, 356, 358 | 844 x 390 at 130% (pair), 568 x 320 (pair), 844 x 390 (merged) | From Thorn, Sphere, Place | glyph and Sphere, Place, Cancel |
| 366, 370, 374, 387 | 932 x 430 with the side panel, 480 x 320, 390 x 844, 932 x 430 at 130% | From Thorn, glyph and Sphere, Place | Sphere 20 ft, Place, Cancel. At 387 Sphere, Place, Shared, Cancel |
| 422 | 932 x 430, merged | From Thorn, Sphere, Place, Cancel | glyph and Sphere, Place, Shared, Cancel |
| 455 | 667 x 375, the DM's pair | From Thorn, glyph and Sphere, Place, Cancel | Sphere 20 ft, Place, Shared, Cancel |
| 538 | 844 x 390, the DM's pair | From Thorn, glyph and Sphere, Place, Shared, Cancel | Sphere, Size, Place, Shared, Cancel |
| 591 to 622 | 1280 x 800 at 130% and 100% (floating), 932 x 430 the DM's pair, 820 x 1180 at 130% | From Thorn, glyph and Sphere, Size, Place, Cancel (Shared in ⋯) | glyph and Sphere, Size, Place, Shared, Cancel |
| 715 | 1280 x 480, the DM's merged row | From Thorn, glyph and Sphere, Size, Place, Shared, Cancel | the same, Spell too |
| 804, 960 | 820 x 1180, 1280 x 480 merged | everything, Spell too | the same |

**Other forms**, where they differ from the rows above:

- **A capped name** (toggle 133): the square from 230 to 304, with Cancel inline at 301 and 304. From 343 to 358: From, shape glyph, Place. 366 to 374: From, Sphere, Place. 387: glyph and Sphere. 422: Sphere 20 ft, Place. Cancel from 455, Shared from 538, Size from 602, Shared waiting at 602 to 622.
- **The chip, short name** (118): the square from 230 to 284. 301 to 343: From, shape glyph, Place. 356 to 370: From, Sphere, Place. 374 and 387: glyph and Sphere. 422: Sphere 20 ft, Place, with Cancel behind ⋯. Cancel from 455, Shared from 538, Size from 591, Shared waiting at 591 to 622.
- **The chip, capped name** (147): the square from 230 to 304, with Cancel inline at 301 and 304. 343 to 374: From, shape glyph, Place. 387: From, Sphere, Place. 422: glyph and Sphere. Cancel from 455, Shared from 538, Size from 615, Shared waiting at 615 and 622.
- **Disabled**: "From Thorn" (104) as the toggle. "From you" (89) keeps its words from 275 and gives the shape chip its wider forms a step sooner (glyph and Sphere from 343, Sphere 20 ft at 387, 455 and 538), with Cancel from 422 and Shared as the toggle has it.

The fit is not monotonic between neighboring rooms (a capped name shows Cancel at 301 but not at 343, where From keeps its words and the shape compacts). That is `fitRow`'s rule, owned by the tool options design (6.3 steps 2 and 3), and every one of those rows keeps From, Shape and Place inline.

**Idle** (no ⋯), the toggle with a short name: the square, shape glyph and Spell at 230 and 259. From Thorn, shape glyph and Spell from 275. From Thorn, Sphere and Spell from 343. The shape's glyph from 356. Spell grows into what is left. A capped name moves those steps to 301, 356 and 374, the chip to 284, 343 and 358, the capped chip to 343, 366 and 387.

**The DM**, placing with a caster: the toggle rows above. Idle, and placing without a caster: tool options 13.2, unchanged.
