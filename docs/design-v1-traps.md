# raccoon-vtt v1: triggers and traps

Status: draft 3, 2026-10-18, revised for review rounds 1 and 2 and the project owner's answers (section 14). The project owner chose "Triggers and traps" (docs/features.md section 13) as one of three "Later" items to design next, with "Movement and walls" (docs/design-v1-movement.md) and "Attached tokens" (docs/design-v1-attach.md). All three change what happens when a token moves, so they share one description of a move (section 13) and one rule for hidden state (section 7). They build and deploy in that order, movement first, each with its own versions, so traps builds on movement's routes and spots and on attach's groups. Code is cited from main at `88f031251`.

## 1. Summary

- **A trap is a new DM-only entity on a scene**: a zone (squares, a trip wire or a door), when it goes off and for whom, what it does, and whether players have found it. It is not an area template: areas are spells with casters and owners, and a trap needs squares, wires, doors, an armed state and uses.
- **It goes off on its own, on the server.** The reducer tests every walk, every landing from the height controls, every turn start and end, and every door opened, against the armed traps of the players' scene outside a blackout. The same rule runs on replay.
- **What it does to the map happens at once**, in the op that set it off: the creature stops where it stepped on it, a door shuts or locks, a light goes out, hidden creatures or stamps appear, a pit opens, and players read a line and hear a short sound.
- **Its save and damage go through the group save.** The DM gets a card, "Collapsing Roof went off: Thorn, Bree", and one tap opens the group save filled from the trap, with the creatures it hit as rows, frozen where they stood when it went off. Apply settles the card in the same op. Nothing about HP happens without the DM, as for areas (design 9.3).
- **Hidden stays hidden, by one rule** (section 7): what each player can observe of an op depends only on the op, their own view and the traps. A creature the players cannot all see never changes a stop, a players' line, a found mark or a refusal, and an unfound trap never reaches a player's device.
- **No stepping back out.** A player's Undo move is refused when a trap cut that move short or showed its player anything (6.5). A silent trap leaves Undo as it is.
- **Finding and disarming** follow SRD 5.2.1: the trap stores its checks, the trap pane asks for them through Request a roll, and the DM marks it found or disarmed. A DM-only hint names a creature whose Passive Perception would notice it.

## 2. Today

- **Area reminders** (design 9.3, `shared/reducer/areaTriggers.ts`) are the nearest thing: a log line when a creature enters an area, or starts or ends its turn in it, during a fight only. `remindAfter` (`:237`) sweeps each moved token's straight leg every half cell (`alongLeg`, `:196`), a teleport included. A hidden area with an `enter` reminder fakes a trap today, but does nothing outside a fight, nothing to the map, and offers no save.
- **The group save** (docs/design-v1-roll-options.md 5, "roll options" below) takes a `Source` (`client/features/dice/groupSave/chain.ts:34`) and a fill, rolls monsters on the server, asks players through requests, and applies one `actor.outcome` (`shared/protocol.ts:1311`) as one op and one undo. It copies `Fill.name` into each request's note (`chain.ts:225`).
- **Doors** (`doorSet`, `shared/reducer/map.ts:571`), **lights** (`buildLights`, `:544`), **heights** (`buildHeight`, `shared/reducer/heights.ts:48`), stamps' and tokens' `visibility`: the things a trap changes, each through its own reducer function in the same transaction.
- **Moves** carry where a token lands (`moveFields`, `protocol.ts:928`), and movement adds a route. The height controls send `token.update` patches of `elevation` alone (`client/features/tokens/groupEdit.ts:104`). `applyOp` runs `remindTurnEnd`, dispatch, `endSaves`, then `remindAfter` (`shared/reducer.ts:124-127`). The actor runs `splitCheck` and the sight piece count after reducing (`server/rooms/actor.ts:1120-1130`), and the size guard refuses any op once a room is over a limit (`server/rooms/sizeGuard.ts:111-114`).
- **Sound** is synthesized with Web Audio (`client/features/encounter/alerts.ts`), behind This device's sound switch, so no file needs a license. The icon set has `lorc/wolf-trap`, and the stamps `gb-square-pit` and `gb-hole`.

## 3. The rules (SRD 5.2.1, Gameplay Toolbox, "Traps", pages 199 to 201)

- **Triggers**: "Traps are often set to go off when a creature enters an area or touches an object. Examples of triggers include stepping on a pressure plate, crossing a trip wire, turning a doorknob, or using the wrong key in a lock." So the zones are squares (a plate, a pit's lid), a wire and a door.
- **Reset**: "If a trap resets after activating, that fact is noted in this entry. A trap is otherwise inert after activation." Fire-Casting Statue "resets at the start of the next turn", Poisoned Darts "if it has activated fewer than three times". The statue fires "when a creature moves onto this trap's pressure plate for the first time on a turn or starts its turn there".
- **Who it hits** differs from who sets it off. Collapsing Roof: "The first creature that crosses the trip wire causes the supports to topple", then "Each creature beneath the unstable section of ceiling must succeed on a DC 13 Dexterity saving throw". Falling Net falls "on it". The statue's "15-foot Cone of magical flame" hits "each creature in the Cone". Every example trap forces a save or deals damage with none, and none makes an attack roll.
- **Detect and disarm**: "As a Search action, a creature can examine the trapped area and make a DC 11 Wisdom (Perception) check", or "As a Study action ... a DC 15 Intelligence (Investigation) check, detecting the pit". Disarms range from "no ability check required" and "Wedging an Iron Spike ... prevents the trap from triggering" to Poisoned Needle's "DC 15 Dexterity (Sleight of Hand) check. On a failed check, the creature triggers the trap."
- **Passive Perception** (Rules Glossary): "The GM uses this score when determining whether a creature notices something without consciously making a Wisdom (Perception) check." Not for a Study action's Investigation. **Pits**: "The lid remains open thereafter", 10, 30, 60 or 120 ft deep by level.

## 4. What the DM and players see and do

### 4.1 Building a trap

- **The Trap tool**, DM only, a setup tool after Pin (`TOOL_ORDER` 65 and `SETUP_TOOLS`, `client/features/toolbarOrder.ts`), behind Setup on a phone. No key: the free letters name nothing about traps, and setup tools are opened rarely. Its options hold **Start from**: Blank, Alarm (a note only, nothing players can see), and the SRD traps (Appendix A), with **Party level** 1–4, 5–10, 11–16 or 17–20. A preset picks its zone's kind, which can also be picked by hand: **Squares** (drag a rectangle snapped to whole cells, or tap one square, "Add squares" for up to 8), **Trip wire** (from point to point, ends on cell corners and edge midpoints, at most 20 cells), or **Door** (tap a door on a grid edge or a free door).
- A tap on a trap with the tool opens its pane, as does its row in the Outliner's new Traps group (4.6).
- **The trap pane**: a bottom sheet on a phone and a pane beside the map from 900 px, as the label, pin and light panes are. Its first line says where it started ("From Hidden Pit, levels 1–4"). The sections fold to one line each:
  1. **Name**, "Players see this name once the trap is found."
  2. **Goes off when**: for squares "A creature steps onto it" (on), "starts its turn on it", "ends its turn on it", "steps off it". A wire: "A creature crosses it". A door: "A creature opens it". **Who**: Party creatures (default), Other creatures, Any creature. "Small or larger only". "Only creatures on the floor", which leaves out fliers, burrowers and riders.
  3. **Afterwards**: "Goes off once" or "Arms again at the start of the next turn", "At most N times" (empty is no limit), "Stops the creature where it goes off" (on, with "A silent trap should not stop the creature: its player would notice."), "Marks itself found when players see it go off" (on), and for squares, once, "Opens a pit N ft deep".
  4. **Hits**: "The creature that set it off", "Everyone on the trap" (squares only), "Everyone in these squares" (drawn), or "Everyone in an area", placed with the Area tool's shapes and handles in a mode that saves the shape into the trap.
  5. **Save and damage**: the group save's fields (roll options 5.4): a save or none, its DC, half or none on a pass, damage parts, conditions on a fail and how long they last.
  6. **Players read**: a line of up to 200 characters ("The floor gives way!") and a **Sound**: none, click, rumble, crash, whoosh or hiss, each with a play button.
  7. **It also**: up to 8 actions picked by a tap on the map: "Close / Open / Lock this door", "Put out / Light this light", "Show this hidden creature", "Show this hidden stamp".
  8. **Finding and disarming**: up to two checks to find it ("Wisdom (Perception) DC 15: the pressure plate"), "Hint when a creature's Passive Perception would notice it" (on with a Perception check), and how it is disarmed, a line with an optional check.
  9. **DM note**, up to 1,000 characters, shown on the card when it goes off.
- The pane's foot: **Armed** and **Found** switches, **Ask to search**, **Ask to disarm**, **Set it off**, and Delete on a second tap. Each change sends `trap.update` with only the fields it changed, so two DM devices editing different fields never undo each other, and an edit never overwrites the server's own writes. Arming a trap with no uses left asks for its uses first. A pit that would take the scene past its wall limits is refused here, never when it opens (6.7).
- **On the DM's map** (a `traps` entry in the layer registry, board layer, order 35, under the fog as areas are): squares hatched in the theme's danger color, a wire as a dashed line with a pin at each end, a door trap as a badge on the door, each with the wolf-trap icon and its name. Armed is strong, sprung grey, disarmed a grey dashed outline, found marked with an eye. The hits draw faintly while the pane is open. Redrawn on change only.

### 4.2 Arming, disarming and setting off

- A new trap is armed. The Armed switch disarms and re-arms it, a sprung trap included. **Set it off** takes the selected tokens, else those on it now, as the creatures that set it off (`trap.spring`): for a failed disarm, a lever, or a trap on a scene that is not the players'. It goes off whatever its state.
- **Ask to search** and **Ask to disarm** open Request a roll (design 9.11) filled with the check, the DC and the note "Search" or "Disarm", never the trap's name, with the selected creatures as targets. The DM reads the answers on the live card and flips Found or Armed.

### 4.3 When it goes off

The DM gets a toast, "Hidden Pit went off: Thorn.", with **Save and damage** when the trap has a save, damage or conditions, and a **card on the DM desk** (`client/features/rolls/DmDesk.tsx:66`, where request cards live, in and out of fights) while it has a pending occurrence (6.1): who set it off, who it hits, what it did ("Closed the north door."), what it could not do ("Could not show Goblin 3: it was deleted."), the DM note, Save and damage (or Apply, for conditions with no save) and Dismiss. Its line goes to the DM's log, and its sound plays where sound is on.

When only a creature the players cannot all see set it off in a player's op (5.5), the card says so: "The imp set it off, out of the players' sight. The trap is still armed for them." It offers **Do its effects** (`trap.act`, once: the doors, lights, reveals, pit and players' line), **Mark sprung**, and Dismiss. In the DM's own op the effects run at once (5.5).

Players:

- The creature stops on the spot where it set the trap off, when the trap stops creatures. Their device predicted the whole drag, since it holds no trap, so the token moves back to that spot when the server answers. A pit then opens under it.
- The DM's line, "Thorn: The floor gives way!", in every player's log when the springing is perceived (6.4), and as a toast for whoever plays the creature, with its sound where sound is on. A trap with no line shows nothing but its effects.
- Doors, lights, revealed creatures and stamps, and the opened pit, through their own projections. The trap itself, once found.
- **Undo move is refused** for a move a trap stopped, or whose springing wrote the players' line: "Could not undo moving Thorn: something happened on the way. Ask the DM." The phone bar stops offering Undo move and Teleport here once the server's ack marks the move (6.5). A trap that stopped nothing and showed that player nothing leaves Undo move as it is.
- Their request card once the DM opens the group save, its note "Trap" until the trap is found (4.4).

### 4.4 The group save from a trap

- A new `Source`, `{ kind: 'trap', trapId, due }` (`chain.ts:34`), whose rows are the occurrence's hits, frozen when it went off (5.6). The fill line reads "From Collapsing Roof: Dexterity save, DC 13, 2d10 Bludgeoning, half on a pass." "Against a spell" starts off. **Two names.** `Fill` gains `publicName`, which every player-facing string the page sends uses: each request's note and the label of a roll made in the open. It is the trap's name once found, else "Trap". The page, the card and the DM's own secret lines keep the real name.
- With no save the page opens on "No save: everyone takes it", so a pit applies in one tap. The preset's note says what the page cannot know ("succeeds automatically if it's Huge or larger: mark those Pass"). Apply sends `actor.outcome` with `trap: { trapId, due }`, which settles the occurrence in the same op. Where it changes no creature, as when everyone passes against Falling Net, it still sends the outcome, naming none, so the springing settles all the same: the button reads "Settle: it changes no one", and the page's open requests close with it as with any Apply. A second DM device's Apply or Dismiss is refused, "It was settled meanwhile.", and a lost answer is settled by the receipt (roll options 5.5), so a trap applies at most once. The page follows the trap's scene, as it follows an area's (roll options 5.10).

### 4.5 Found traps, for players

- A found trap reaches players as its name and zone: squares hatched in a neutral warning color, a wire as a dashed line, a door with a badge, and "Disarmed" once the DM disarms it. Never whether it is armed or sprung, its DC, effects or note: the party saw it go off or it did not.
- A player's drag whose route crosses a found trap that is not disarmed says "Crosses Hidden Pit" on the drag label, and the DM's drags say it for every armed trap. Client only. Found is the party's: everyone sees what one character found, as the table hears it.

### 4.6 The Outliner and the hint

- The Outliner (`client/features/outliner/rows.ts`) gains a Traps group: each trap with Armed, Sprung or Disarmed, Found or Hidden, and "Its door is gone" for a door trap whose door was removed. A tap frames it and opens its pane.
- **The Passive Perception hint.** A party creature that ends a walk (its move's plan walks it anywhere, even back where it started) within 10 ft of an armed, unfound trap (by the room's distance rule, from its footprint to the zone's nearest square, each square on its own ground), while the zone is in the party's sight on a vision scene or not fully fogged elsewhere, whose `passivePerception` is at least the DC of the trap's Perception check, gets the DM a toast and a line: "Thorn's Passive Perception (16) would notice the pressure plate of Hidden Pit (DC 15)." with Mark found. Once a trap has hinted, it remembers that creature in `noticedBy` and hints no more until its find checks change: one creature able to notice it is all the DM needs, and one id needs no eviction rule. It never marks anything found by itself.

## 5. The rules engine (`shared/rules/traps.ts`, `shared/reducer/traps.ts`)

### 5.1 Which ops can set a trap off

- **Walks**: `token.move` and `token.moveMany`, each moved group by its route (13.1), and attach's Get off (`token.detach` with a place). A teleport is tested only where it lands.
- **Landings**: a `token.update` whose patch is only `elevation` (with `rotation` or not), which the height controls send, is a vertical walk with two spots, where it was and where it lands.
- **Turns**: `encounter.next`, for the creature whose turn ends and the one whose turn starts, and a removal that passes the turn on. A Next that changes nothing (`pressChangesNothing`, `shared/reducer/encounter.ts:256`) tests nothing. Previous and undo start no turn.
- **Doors**: `door.set` that opens a closed or locked door, with the creature that opened it (5.3).
- **By hand**: `trap.spring`.
- **Never**: setup placements (`token.create`, a `token.update` of position, size or scene), `token.attach`'s seat leg, `build.height` lifting tokens, a scene's duplicate, `sys.restore`.
- **Where**: only traps on the players' scene go off by themselves, and only while no blackout is on, so a DM builds on another scene or behind the pause screen safely. `trap.spring` works anywhere.

### 5.2 Who sets it off

Every input here is one every player's projection holds (section 7).

- A creature: not an object, not dead (`isCreature`, `shared/reducer/areaTriggers.ts:53`, reading `kind` and `life`, which players receive).
- `who`: `party` is a token whose projected `party` flag is set: a member of kind player owns the token or its character (design 7.3). The DM's `partyVision` mark does not count, since players never receive it. `others` is every other creature, `any` both.
- `minSize: 'small'` leaves Tiny creatures out, by movement's `sizeCategory` (`shared/rules/footprint.ts`), so a custom size counts by its longer side and is Tiny only at half a square or less.
- `floor`: at the spot, `standing(elevation, ground) === 'ground'` (`shared/rules/heights.ts:154`, the ground from `footprintGround`, `:144`), so fliers above it and burrowers below it do not count, and the token is not carried `on` another by a link every player sees (attach's link graph as a player who owns nothing sees it). A `drag` token counts by its own elevation, so one a flier lifts is off the floor.
- The squeezed footprint while it squeezes (design 9.8).

### 5.3 Progress, spots and zones

- **Seen by all.** A creature is *seen by all* when a player who owns nothing would receive it before the op (a table display's view: not hidden by the DM, not withheld under fog or out of the party's sight), and a link is seen by all when both its ends are. This is the contract's *public members*: whatever another viewer can observe of a move (the sampling step, which members walk and stop, the springings players see) reads only these.
- **Spots and progress.** A move's groups are attach's `moveGroups(before, named)`: each token the op names with what it carries, stopping at any other named token, so a token the op does not name walks once, with the nearest named token up its chain, whatever the names' order and through a loop attach permits. A token alone is a group of one. A group's **public members** are those seen by all, with the links seen by all: attach's `publicMembers`. A named token not seen by all walks in the private pass. Each public member's **spots** are movement's `routeSpots(build, route, token, step)` along its route, the holder's route plus its offset with attach's elevation rule: snapped positions with `squeezed`, `stand` and `progress`, `[piece, k, n]`. The step is the finest among the public members (half a square when any of them steps by halves, else 1), so all of them share `n` per piece and are judged at one moment. At progress `p` each stands on its latest spot at or before `p`. A teleport and a vertical walk have two spots, at progress 0 and 1. Every other member, the mover's own hidden familiar included, walks in the private pass on its own step (5.5) and never changes the public step.
- **Squares**: a member is on the trap at a spot when one of its occupied cells (`occupiedCells`, `shared/rules/footprint.ts:134`) is a square of the zone and it passes `floor` there. **Steps onto** is a spot that is on after one that is not, **steps off** the reverse. A creature already on it that moves within it sets nothing off, and a flier landing on it steps onto it.
- **Wire**: crossed between two spots when the segment joining the footprint's centers meets the wire and the first center is not on the wire's line, by the exact orientation test of `shared/rules/segments.ts`, with `floor` at the first spot. A teleport crosses nothing.
- **Door**: the opener is in the op. `door.set` gains `by?: TokenId`: the token whose action bar opened the door, or for a tap on the door, the selected token, else the player's own token that reaches it, nearest first and then by id, chosen on the device. A player's `door.set` that opens must carry `by`, their own token reaching the door (`reachesDoor`, `shared/permissions.ts:1154`), else it is refused (`invalid`, "Choose who opens the door."), replacing today's "any token of their own reaches it". Closing needs no `by`. A DM's open may leave it out, and then sets no trap off: the DM opening doors from afar.
- **Turn start and end**: the creature whose turn it is stands on it.

### 5.4 The order of events

- An **event** is a member reaching a spot that sets a trap off. Within one group, events order by progress, piece first, then `k / n`. A `token.moveMany`'s groups walk straight legs at once, one piece each, so its events order by `k / n`. Fractions compare exactly by cross-multiplying, ties by holder id, then member id.
- An armed trap goes off at its first event, with every creature whose event for it falls at that same progress: two creatures crossing a wire side by side set it off together. A trap sprung earlier in the op, or sprung or disarmed before it, does nothing. A stopped group's later events are dropped.
- **Once a moment.** A trap goes off at most once per op, except that `encounter.next` holds two turns, the one that ends, tested first, and the one that starts.
- **Afterwards**: the trap becomes `sprung`, and `usesLeft`, when set, goes down by one. `resets: 'never'` stays sprung. `resets: 'nextTurn'` arms again at the start of the next turn in a fight, before that turn's own tests, so the statue fires on a creature that starts its turn on the plate. Outside a fight it arms again at the end of the op that set it off, and `encounter.end` arms every sprung `nextTurn` trap. A trap with 0 uses left stays sprung.

### 5.5 The public and private passes, and stops

- **The public pass** (section 7) runs first, from `planMove`, before dispatch (13.2 step 1), for every op, the DM's included. Its creatures are the public members of each group (5.3), the creature whose turn starts or ends when it is seen by all, and a door's opener when it is. It decides every stop, every springing players perceive, the trap's state, uses and found mark, the players' line, undo's `trapped` mark and the actions.
- **Stops.** A group's **walkers** are its public holder and public `drag` tokens, never an `on` token. When a trap that stops creatures goes off for a walker at progress `t`, the whole group stops at the latest progress `s <= t` where every walker stands on a spot with `stand`: movement's rule that the token may stop there (its core fits, squeezed only where `squeezeFits` holds) and that its route cut at that spot passes the leg test (movement M15), so the landing is legal for every walker on its own offset route. Progress 0, where the group stood, is a stand by definition, even where its start touches a wall, as today's moves may step off one, so a stop never refuses the op. A snapped spot can sit off a diagonal or taut route's line and clip a corner the route passed (a Medium token from (0,0) to (2,1) past a wall from (1.25, 1.25) to (1.75, 1.25) snaps to (1,1)), and then an earlier spot is taken. The trap still goes off at `t`. The op is rewritten to land the holder there, its route cut, and dispatch moves the group, the path and the cost by the shorter move (movement 4.4).
- **The private pass** runs after the public one, for every creature that is not seen by all: a hidden passenger or dragged creature, a holder with no public member, a hidden creature whose turn starts or ends, a hidden opener. They follow wherever the public pass put their group, each on its offset route, and a trap never stops one. A hidden `drag` member walks only up to its own wall stop (movement 7.1, attach 4.2), and what it carries walks that stopped route by its own offset (attach), so none of them sets off anything past the stop, in planning, moments and dispatch alike. One may set off a trap the public pass left armed, and what that writes depends on whose op it is:
  - **In a player's op** it writes only what no public rule reads: an occurrence (6.1) and a DM line, both marked `hidden`. The trap stays armed, its uses and found mark unchanged, its actions and players' line not run. So every player observes exactly what they would without that creature, the mover included, and the trap can still go off for them later. While a trap holds a pending hidden occurrence, a further private springing of it adds nothing. The DM's card (4.3) offers Do its effects and Mark sprung.
  - **In the DM's own op** (the contract's third listed reveal) it goes off as the trap is set: sprung, uses down, its actions run (5.7), so a hidden goblin the DM walks onto a plate slams the door. It writes no players' line, stops nothing and marks nothing found, so the reveal is the actions alone. No refusal ever shows it (6.7). A hidden creature the DM walks across a pit drops in only when its move ends on the pit's squares, as every token standing there does when it opens (5.7).
- **A hidden creature on a trap a public one also sets off** joins nothing public: the public springing is as if it were not there, and it is in the hits only when the moment puts it on the zone, which only the DM's occurrence holds.

### 5.6 Who it hits, frozen at the moment

- The **moment** of a springing is the room as its event saw it: every group of the op on its latest spots at or before the event's progress (for a `token.moveMany`, the same fraction of each leg), groups stopped earlier at their stops, hidden members on their own spots at that fraction, up to their own wall stops, everything else as before the op. Turn ends use the room before `encounter.next`, turn starts the room after the turn started, and a door the room after it opened.
- On the moment: `trigger` is the creatures that set it off. `zone` is every creature with an occupied cell on the trap's squares (for a wire or a door, `trigger`). `cells` is every creature with an occupied cell in those squares. `area` is `creaturesInArea` (`shared/rules/aoe.ts`) on the stored shape with the scene's walls and the room's inclusion rule.
- Only creatures, not the dead. `who`, `floor` and size decide who sets it off, never who it hits: a collapsing ceiling hits the goblin beside the cleric. At most 50 by token id, the card saying how many more, which the DM adds by selecting them. The list is stored with the occurrence, DM only, and never worked out again.

### 5.7 What it does

- After the events, for each springing that runs its actions (every public one, and a private one in the DM's own op) in event order, and then each trap's listed order: `doorSet` for a door, a light's put with `on` changed, a token's or stamp's `visibility` to `'all'`, and a pit. A target gone since is skipped and named on the card.
- **A pit** sets each of its squares' ground to its stored floor (6.1), at least −100 ft, through `buildHeight`, and moves the tokens standing there by attach's group rules: a holder takes what it carries `on` it down with it, offsets kept, and a `drag` token lands on its own ground (attach 2.2). Attach's link pass then runs again before the transaction ends (13.2), so a dragged creature left 10 ft above its fallen holder comes loose. Walkers then meet a ledge at the pit's edge. A pit opens once: a re-armed pit trap sets the same floor, which changes nothing.
- Then `found` when the springing is perceived (6.4), the occurrence (when the trap has a save, damage or conditions, and for every private springing in a player's op, so its card can offer Do its effects), marked `acted` when this springing ran its actions, `noticedBy`, and the lines (6.3).
- **Never over a limit.** Every byte and wall piece these writes can add is reserved or counted ahead (6.7), so none can refuse the op. If an action would still pass a limit, as only a room already over a cap allows, that action is skipped and the DM's line says why ("Could not open the pit: the scene is at its wall limit."). A pit checks its opened ground against the split's caps and the sight pieces' before it writes anything. The op is never refused for it and the room is never left over a limit.

## 6. Data model and ops

### 6.1 The model

```ts
type RoomState = { ..., traps: Record<TrapId, Trap>,   // scene-scoped, like pins
  trapLog: LogEntry[],                   // DM only: the last 30 DM trap lines (6.3)
  trapSeen: LogEntry[] }                 // the last 20 players' trap lines (6.3)

type Trap = { id, rev, sceneId,         // id: a plain id (below)
  name: string,                          // 1 to 80, the name rules (design 6), no lone surrogate
  zone: TrapZone,
  state: 'armed' | 'sprung' | 'disarmed',
  found: boolean,
  rig?: TrapRig }                        // always stored, absent in a player's projection, so no player device can run a trap

type TrapZone =
  | { cells: CellRect[] }                // 1 to 8 rectangles of whole cells inside the scene, 400 cells in all
  | { wire: { a: [x, y], b: [x, y] } }   // cells, multiples of 1/2, inside the scene, 0.5 to 20 cells long
  | { door: DoorRef }                    // door.set's ref
type CellRect = { x, y, w, h }           // whole cells, w and h 1 to 20

type TrapRig = {
  on: ('enter' | 'leave' | 'turnStart' | 'turnEnd')[]   // squares only, 1 to 4. A wire goes off when crossed, a door when opened
  who: 'party' | 'others' | 'any', minSize?: 'small', floor: boolean
  resets: 'never' | 'nextTurn'
  usesLeft?: number                      // stored 0 to 99, absent for no limit. Ops set 1 to 99 (6.2)
  stops: boolean, foundOnSpring: boolean
  pit?: { floor: number }                // squares only: the ground its squares take when it opens, ft, -100 to 199
  hits: 'trigger' | 'zone' | { cells: CellRect[] } | { area: TrapArea }
  save?: { ability: AbilityKey, dc: number, onPass: 'half' | 'none' }   // dc 1 to 50
  damage?: { formula: string, type: DamageType }[]   // 1 to 4, the Dice panel's formulas
  conditions?: ConditionKey[]            // at most 3 (LIMITS.outcomeEffectsEach)
  lasts?: { mode: 'turnStart' | 'turnEnd' | 'rounds', rounds?: number }   // each creature's own turn
  message?: string                       // 1 to 200, single line. Every trap text refuses a lone surrogate
  sound?: 'click' | 'rumble' | 'crash' | 'whoosh' | 'hiss'
  actions: TrapAction[]                  // at most 8
  find: TrapCheck[]                      // at most 2
  notice: boolean
  noticedBy?: TokenId                    // the reducer's: the creature the hint named
  disarm?: { text?: string, check?: TrapCheck }   // text at most 200
  note?: string                          // at most 1,000
  preset?: string                        // the SRD trap it started from, a slug of at most 40
  due?: TrapDue[] }                      // the reducer's: occurrences waiting for the DM, at most 3 a trap and 10 a room, oldest first
type TrapArea = Pick<AreaTemplate, 'shape' | 'size' | 'width' | 'height' | 'origin' | 'yaw' | 'pitch' | 'faceOffset' | 'anchor' | 'includeOrigin'>
type TrapCheck = { ability: AbilityKey, skill?: SkillKey, dc: number, what?: string }   // what at most 80
type TrapAction =
  | { door: DoorRef, state: 'open' | 'closed' | 'locked' }
  | { light: LightId, on: boolean }
  | { show: { tokenId: TokenId } | { stampId: StampId } }
type TrapDue = { id: string, at: string, how: TrapHow,   // id: its line in trapLog
  by: TokenId[], more?: number,          // who set it off: at most 10, those players own or see first, then by id
  hits: TokenId[], hitsMore?: number,    // at most 50 by id
  perceived?: true, hidden?: true, acted?: true }   // its line reached every player (6.4), a player op's private springing (5.5), its actions ran (5.7, 6.2)
```

- **`rig` is one optional block** so a player's projection leaves it out whole, and the trap step skips a trap without one. A player's device, which runs the same reducer for its prediction, can never set off a found trap with half its fields.
- **`due` lives on the trap**, so a reload or a second DM device rebuilds the cards from the traps, as save-ends cards come from the effects (roll options 6.1). An occurrence holds all `trap.act` needs, its creatures and whether players were told, apart from the DM ring, which can roll past it. A fourth occurrence on one trap drops that trap's own oldest. Then an eleventh in the room drops the room's oldest. A dropped one's line keeps its counts.
- **Plain ids.** A trap's own id must be plain (`/^[A-Za-z0-9_-]{1,64}$/`, as every id the app makes), and the reducer stores a token id in `due.by`, `due.hits`, `noticedBy` or a line's `by` only when it is plain, so each serializes to at most 66 bytes and the reserves of 6.7 hold. A creature with another id is counted in `more` or `hitsMore` and left for the DM to select. The protocol's ids may be any 64 characters, which JSON can escape to 386 bytes, and a client could make one. Who receives a line never reads these lists (6.4), so an id's form never decides delivery.
- **Text** in a trap (name, message, note, disarm text, a check's `what`) refuses a lone surrogate, so it serializes to at most 3 bytes a UTF-16 unit. A trap's own fields, everything but `due`, `noticedBy`, `state`, `found`, `usesLeft` and `rev`, serialize to at most 9 KiB (`LIMITS.trapBytes`, Appendix B), which `trap.create` and `trap.update` check.

### 6.2 Ops and permissions

| Op | Who | Notes |
| --- | --- | --- |
| `trap.create { trap }` | DM | A plain id. `due` and `noticedBy` refused, `usesLeft` 1 to 99 or absent. Every ref (the door, the lights, stamps and tokens of its actions) must be on the trap's scene, else `invalid`. |
| `trap.update { trapId, patch: { name?, zone?, state?, found?, rig? } }` | DM | `rig` names only the fields that changed, each replaced whole, never `due` or `noticedBy`. A change of `find` clears `noticedBy`. `usesLeft` 1 to 99, or null for no limit. Arming a trap whose uses are 0 needs uses in the same patch: "Give it at least one use, or no limit." |
| `trap.delete { trapId }` | DM | |
| `trap.spring { trapId, tokenIds }` | DM | 0 to 50 creatures on its scene as the ones that set it off. Whatever its state, stops nothing, uses down to 0 at least, its actions run as a DM op's springing does (5.5), and its line as 6.3 says. |
| `trap.act { trapId, due }` | DM | Do its effects: runs the trap's actions and players' line for a pending occurrence not `acted`, which only a private springing in a player's op leaves, and marks it `acted` in the same op. Refused `invalid`, "It was done meanwhile.", otherwise. The save and damage stay pending, settled as below. |
| `trap.settle { trapId, due, sprung? }` | DM | Dismisses an occurrence, with `sprung` marking the trap sprung (Mark sprung). Refused `invalid`, "It was settled meanwhile.", when it is not pending. |
| `actor.outcome { ..., trap?: { trapId, due } }` | DM | Settles the occurrence in the same op, refused the same way. |
| `door.set { ..., by? }` | as today | 5.3: a player's open needs `by`, the opener, which must reach the door. |

Players send no trap op. Every string is bounded by zod (6.1). The import schema takes stored values (`usesLeft` 0 to 99, `due`, `noticedBy`, the rings) and drops non-plain ids from them.

### 6.3 Lines

- **The DM's lines**, in `trapLog`, never the shared log: `{ type: 'trap', trapId, name, how: TrapHow, by: TokenId[], more?: number, hits: number, did: { action: number, ok: boolean }[], seen?: number[], hidden?: true }`, `how` one of `'enter' | 'leave' | 'turnStart' | 'turnEnd' | 'cross' | 'open' | 'hand'`, `by` as the occurrence's, `seen` the indexes in `by` of creatures players who do not own them could see at the moment (`seenByNonOwners`, `shared/project.ts:378`), and the hint's `{ type: 'trapNotice', trapId, tokenId, passive, dc }`. The DM's Log panel merges `trapLog` and `trapSeen` with the log by time.
- **The players' lines**, in `trapSeen`: `{ type: 'trapSeen', by, more?, message, sound? }`, written when the trap has a `message`: by a perceived public springing (6.4), and by the DM's `trap.act` and `trap.spring`. Every one reaches every player and every table display, so `trapSeen` holds only lines every player receives. `by` names only creatures seen by all, which is display, cut per viewer to those they may see now. No trap id, name, hits or actions. A line for some players only would go where the room log's own lines go, and traps writes none.
- **Retention per audience.** `trapLog`'s audience is the DMs, `trapSeen`'s every player, and each ring drops only its own oldest, so no line a viewer cannot see ever pushes out one they could. Every line is cut to its ring's bound when written (dropping `by` from the end into `more`), so a ring never passes its reserve.
- **Ids.** A line's id is its op's `seq:index`, as the room log's. The players' lines count with the room log's lines, since every player gets both. The DM's lines count on their own from 900000, so a line only the DM sees never moves the id of a line a player gets, and the DM's merged panel never holds two lines with one id.
- **Delivery** reads the occurrence's `perceived`, judged over every creature that set the trap off (6.4), never the `by` a line keeps for display or how its ids are stored.
- Settling writes no line of its own: the outcome writes its HP and condition lines.

### 6.4 Projection

- A DM gets every trap on its scene and both rings. A player and a table display get the players' lines, but none behind a blackout, as roll and turn lines.
- A player gets a trap only when it is `found`, on the player scene, outside a blackout, and not under full fog by the labels' rule over its cells (a wire's cells, a door's two cells). A door zone is withheld while its door is a secret door not found. Fields: `id`, `sceneId`, `name`, `zone`, and `disarmed: true` when it is, with `rev` 0. So springing, re-arming, uses and rig edits send players nothing. Disarming or re-arming a found trap shows, as the party's own doing.
- **Perceived.** A public springing is perceived when any creature that set it off is seen by players who do not own it at the moment (`seenByNonOwners`), judged over the whole set before anything is cut. A creature seen by all and owned by a player is a party member, which is always shown, so a public springing is perceived by every player or by none, and its line reaches every player. Only a perceived springing marks a trap found (`foundOnSpring`). `trap.act` and `trap.spring` mark the trap found when it has `foundOnSpring`, as the DM's reveal, since every player sees their line and actions. The Alarm preset has it off.
- **Fan-out** (design 7.3): a touched trap's key, the rings by viewer, and traps join `tileDependents` with labels and pins.

### 6.5 Undo

- The DM's trap ops are DM steps: "making the trap Hidden Pit", "arming Hidden Pit", "setting off Hidden Pit", "dismissing Hidden Pit". `trap.settle` undoes by bringing the occurrence back, and `actor.outcome`'s undo brings its occurrence back with the HP.
- A springing is part of the op that set it off. The DM's undo of their own move or Next puts back everything that op wrote, trap, doors, lights, reveals and pit included, and is refused once any of it changed since (design 7.7).
- **A player's Undo move** (the project owner, 2026-10-18: "No", 14). A step records `trapped` when a public springing changed something that player's projection shows (`shared/reducer/trapStep.ts` `blocksUndo`): a move it cut short of where it asked, a players' line, the trap marked found, or an action that did something, a door, a light, a reveal or a pit. A stop where the group was going anyway is no stop, and a teleport, a Get off and a landing land where they asked, so none of them is cut. So a silent trap nobody found that stops a token exactly where it was going leaves Undo move as it is: the token goes back, and the private occurrence and its frozen hits stay with the DM. The ack carries the mark (`ev.trapped`), so the phone bar offers Undo move exactly when the server takes it. Merging the ops of one gesture into a step (`server/rooms/undo.ts:130`) ORs the mark, so one trapped op makes the whole step trapped. Its undo is refused, "Could not undo moving Thorn: something happened on the way. Ask the DM.", and the step is dropped, as a failed guard drops it. Any other step undoes as today, moving the token back and leaving the trap's writes. A private springing never marks a step. The DM's undo takes a stopped move back.
- `trap.act` undoes as a DM step: its doors, lights, reveals and pit go back and `acted` clears, while its line stays in `trapSeen`, as undo leaves log lines. Its redo needs the occurrence still pending and not acted. Replay applies the stored op as it was.
- Previous changes no trap, as it takes back no reminder.

### 6.6 Versions

- Traps take **their own next free op and snapshot versions at build time** (`N` below), after movement's and attach's. The snapshot step adds `traps`, `trapLog` and `trapSeen`, empty, so an older build refuses the room. Op `N` adds the trap ops, `door.set`'s `by` and `actor.outcome`'s `trap`, which an older build's strict schema refuses, so going back is the backup's restore.
- No op stored before `N` can meet a trap, so replay of an older op writes no trap field. The one replay rule traps changes, the teleport sweep of area reminders (13.2 step 6), keys on `opVersion !== undefined && opVersion < N` keeping today's straight sweep, the pattern of `shared/migrate.ts`. A player's open without `by` is a permission rule, which replay does not run.

### 6.7 Limits

- 50 traps per scene (`LIMITS.trapsPerScene`), 9 KiB of a trap's own fields, and the per-field bounds of 6.1.
- **A springing never changes whether an op passes.** Room size is public in one sense only: a room's hidden content, traps included, takes its share of space, as hidden tokens and notes do. What a trap writes when it goes off must not move any measure. So:
  - **Reserved, counted always, from the complete serialized write.** Every measure the size guard keeps (the room's state, its stored bytes, each DM projection's room-level and scene parts) counts a trap's own fields exactly and, in place of what the reducer writes, its reserve: per trap the small fields and `noticedBy` (160 bytes) and its actions' and stop's slack (100 bytes). Per pit trap, a whole new chunk for every chunk its squares touch, envelope and map key included, whether or not it exists yet: `2K + 780` bytes, `K` being the scene id's serialized length, which never changes. Per scene with a pit trap, 4 KiB for the tokens a pit can move (500 at 8 bytes). Per room, once it has a trap, 10 occurrences (42 KiB) and both rings at their bounds (45 KiB and 30 KiB). Appendix B shows the arithmetic. So the measure is the same whether or not, and however often, a trap went off.
  - **Counted ahead.** A pit's walls count from the moment the trap exists, as doors count whatever their state: the potential sight pieces and the split's counting pass (design 9.7, 10.5) treat every edge on a pit's border, and between two pits' squares, as raised. Any set of opened pits is then within what was counted. `trap.create`, `trap.update` and the DM's build ops refuse the DM when that count passes a cap, the room import refuses a scene whose count does, and opening a pit never raises it.
  - The guard measures the op's own writes exactly and the trap step's against those reserves, so the op passes or fails as it would without its trap step, and the room's real state stays within every limit. The action-skip of 5.7 stays as the bound for anything left over.
  - A trap's reveal of a lit token counts as a reveal on a turn does for the lit token light cap: never refused.
- **The cost accepted.** The reserves take about 117 KiB of a DM projection's 3 MiB once a room has a trap, and about 13 KiB per scene at 50 traps without pits, plus under 1 KiB for each chunk a pit touches and 4 KiB for a scene with pits, rather than the 600 KiB a fixed 12 KiB a trap would cost.

### 6.8 Scenes, deletion, import

- Deleting a scene deletes its traps. A deleted token, light or stamp leaves the actions that name it, which then skip. A door trap whose door is removed never goes off by itself.
- `scene.duplicate` copies traps with the map, as it copies pins (`shared/reducer/duplicate.ts:64`), each id by `derivedId` (`:173`) through `fresh`: lights and stamps map to their copies' ids, tokens to theirs when creatures are copied and are dropped otherwise, doors stay, since free walls keep their ids. Occurrences and `noticedBy` are dropped.
- Export and import carry `traps` and both rings and remap their ids as for pins, lights, stamps and tokens (design 16.4). Old line and occurrence ids are numbered in the old room's order, so the newest occurrence stays the newest. A room with more than 10 occurrences waiting is refused, as other caps are.

## 7. Hidden stays hidden: public determinism

The three Later designs share one rule (the shared contract's section 5): for every viewer, what they can observe of an op is a function of the op and their own projection, apart from the listed reveals, and two rooms that look the same to a viewer give them the same bytes. Traps meets it like this:

- **Its reveals.** A trap going off that players perceive (the first listed reveal). In the DM's own ops, a hidden creature's springing showing through the trap's actions (the third). The second, a visible token following a holder players cannot see, is attach's: a creature seen by all whose holder is not is judged as walking by itself, since its link is not seen by all. A trap's existence, state and rig may change what players observe only through these.
- **One definition** (5.3): whatever another viewer can observe of a move (the sampling step, the walkers, stops, perceived springings, found marks, players' lines, the actions in a player's op) reads only creatures and links seen by all. The rest walk in the private pass (5.5). Refusals and limits are permissions', movement's and attach's, on the public members plus the tokens the op names (contract 5), and traps adds none to a move.
- **Inputs** (5.2): `kind`, `life`, the projected `party` flag, sizes, elevations and the ground. Never `partyVision`, hidden conditions or effects.
- **Limits** (6.7): reserves from complete serialized writes make every measure independent of springings, and geometry is counted with every pit open, so no springing shows through a refusal.
- **Retention and delivery** (6.3, 6.4): each ring has one audience, and delivery reads `perceived`, never display lists.
- **Undo** (6.5): only public results mark a step.
- No player device holds a rig, so no prediction shows a trap before the server does, and an unfound trap is in no player's snapshot, `ev`, count, Outliner or drag label. Players' strings name an unfound trap "Trap" (4.4). Search and disarm requests read "Search" and "Disarm".
- **The differential test's generators for traps**, on paired rooms that differ only in hidden state: a hidden `on` or `drag` member in a player's group crossing a trap, the mover's own familiar hidden from the other players, a hidden creature on a trap a public one also enters, a hidden creature whose turn a player's End Turn starts on a plate, a hidden first trigger beside a public one, `partyVision` and hidden conditions on members, and different DM-only trap fields (occurrences, `noticedBy`, ring contents, hidden springings before the op). Every pair asserts identical answers, per-viewer `ev` streams and drag frames. For the DM's own ops, pairs may differ only by the third reveal: a hidden springing's actions, never a stop, found mark, players' line, refusal or name. Pairs never differ in a trap's own fields, which are the reveal, nor only in a link that carries a visible token.

## 8. Edge cases

- A creature on a plate when it is made or armed sets nothing off until it steps off and back on, or starts its turn there. Two traps on one square go off in event order, then trap id, and of two stopping traps on a route the earlier stops the group. A rider on a mount over a plate: the mount sets it off and the rider does not, though both can be hit, and a magic glyph without `floor` catches both.
- A player's door: the door opens and the trap goes off in one op. A trap that also closes that door leaves it closed. When the players' scene changes, the new scene's traps become live and the old one's quiet.

## 9. Performance

- **The server.** Traps build no room copy per spot. A walk takes `routeSpots` piece by piece, lazily, and tests each member's spots, public and private, against its scene's trap index, cached by the identity of its trap objects as wall sets are (design 9.7): a count table of armed squares that says in 4 reads whether a footprint covers any, and per square a mask of its traps. Only a spot over an armed square reads its cells, at most 16, and its ground. Wires are tested only against pieces whose box meets theirs, and a scene with no armed trap costs one lookup per op.
- **Moments**, the room copies, are built only for springings. A move springs each trap at most once, so at most 50 a move. `encounter.next` walks nothing, but it can spring a trap twice, at the turn that ends and, after a `nextTurn` reset, at the turn that starts, so at most 100, about 8 ms at 500 tokens by the sweep's copy cost below.
- **The worst move.** A route is at most 300 squares of reach in all, as `alongLeg` measures it with elevation (movement 6 and 10), so a walker has at most 664 spots at half steps. A player's check set is at most 20 tokens, but a whole group can hold the scene's 500, one public holder with 499 private passengers each walking its own offset route: about 332,000 spots, the worst move. A `token.moveMany` names at most 100 tokens, which what they carry can also grow to 500, each on a straight leg of at most 199 squares: about 199,000 spots. Probes with Gargantuan walkers on a development laptop: the routed 500 (300,000 spots) took about 4 ms over no armed square and 25 ms with every spot over one, and the `token.moveMany` about 4 and 15 ms. A stress probe of 494,000 spots, more than any valid op, took 27 ms. Today's worst area sweep, 600 room copies of 500 tokens, took about 50 ms there. These figures leave out `routeSpots` itself, which movement 10 counts, and the area sweep stays movement's: three sweeps, public, reveal-carried tokens and private, of at most 664 samples each, so 1,992 an op.
- `scripts/bench-traps.ts` runs each worst case at 50 traps, alone, over armed squares throughout, and gates it: a 500-token group on a 300-square route at 40 ms, the 500-walker `token.moveMany` at 25 ms, the same moveMany with all 50 traps going off, with one trap stopping all 100 walkers, and with 48 going off before one stops them all, each at 25 ms, and an `encounter.next` springing 50 traps twice at 15 ms.
- **What keeps them inside.** Only a walk's first event for a trap can set it off, so a walk keeps no other. The next trap to go off is the one whose earliest event still counts, kept per trap until a stop is added, with no sort of every event. A stop where the group was going anyway is no stop (6.5), so the op is cut and applied again without its traps only when a walk is cut short. A stop's search asks whether a spot stands only for the spots it reaches, back from the event (`routeStands`). A move with no walk players cannot see has no private pass. A springing's moment places only the creatures it reads, and builds the whole room only for the party's sight on a vision scene and an area's hits. A footprint of more than a square keeps what it read by its cells, which walkers on one lane share.
- **A phone.** Players' devices hold no rig and run no detection. The DM's device runs it when predicting its own ops. The layer draws at most 50 zones as cached shapes, redrawn on change.

## 10. Out of scope, and why

- **Saves without the DM** (question 1) and **players searching or disarming alone** (question 4). **Moving traps** (Rolling Stone's stone) and **traps that start a fight**: the preset shows the stone and its note says to roll Initiative.
- **Attack-roll traps**: none in the SRD. **Traps on chests and levers**: a one-square zone, or Set it off. **Rubble as difficult terrain** (Collapsing Roof): a later action once movement's terrain marks ship. **Chained and timed traps**, and **found per player**.

## 11. Tests

- **Rules** (`shared/rules/traps.test.ts`): spots for mixed-size groups on the step of members seen by all, a mover's own Tiny familiar hidden from the others leaving the step at whole squares, a visible rider on a hidden mount judged as walking alone, nested named moves (a horse and its rider named with different places, the rider's torch walking once with the rider) in both input orders and through a permitted loop, steps onto and off, wire crossings on a corner and along the wire's line, `who` with the projected `party` flag, `floor` with fliers, burrowers, riders and lifted `drag` tokens, `sizeCategory` for custom sizes, event order across `token.moveMany` legs of different lengths, stops whose snapped spot clips a wall on diagonal and taut routes, a start touching a wall, hits frozen at the moment for a crossing that ends past the statue's cone, resets and uses.
- **Reducer**: each op and refusal, springing on walks, landings, Get off, `encounter.next` (both turns, arming first, a trap with both turn triggers and `nextTurn` going off twice in one Next, a Next that changes nothing), `door.set` with and without `by`, `trap.spring`, `trap.act` once and a second refused, `trap.act` refused after an automatic springing that ran its actions and left damage pending, `trap.settle` with `sprung`, `encounter.end`, actions with missing targets, a pit under a rider and its holder and beside a dragged creature, `actor.outcome` settling, the per-trap cap evicting that trap's own oldest before the room cap (trap B holding the room's oldest while A takes a fourth), plain-id storage and a non-plain trap id refused, a lone surrogate in trap text refused, a hidden goblin the DM walks onto a plate slamming its door with no line or stop, undo of a DM move, a player's refused undo after a stop or a line and in a merged gesture, and an allowed one after a silent or private springing, duplicate and scene delete.
- **Projection**: unfound absent, found cut with rev 0, the fog rule, a secret door zone, perception over the whole set (eleven creatures, the ten first hidden, the line still reaching every player), `trapSeen` holding only lines every player receives, `trapLog` for DMs only, a table display.
- **The differential test** (section 7): traps' generators in the shared harness.
- **Limits**: a trap's own fields at 9 KiB with 386-byte refs refused and plain ones taken, the reserves at least the largest serialized writes (Appendix B) on generated worst cases, the review's probes as cases (eight 2 x 2 pits across 32 new chunks writing 24.5 KB, inside their reserve, and a line with an escaped trap id, 1.7 KB, now refused at `trap.create`), every written line cut to its bound, every pit-open combination within the counted geometry, an over-cap imported scene skipping its pit with a DM line, and paired rooms just under each limit where a silent trap goes off or does not, with identical answers.
- **The occurrence state machine, randomized** (the project owner's rule of 2026-10-17): springings public and private, Apply from two DM devices, Dismiss, Mark sprung, Do its effects, lost answers settled by receipt, resends under one tag, undo and redo. Invariants: an occurrence is applied at most once and its actions run at most once, never both applied and dismissed, at most 3 a trap and 10 a room, a dropped one never applies, an undone Apply brings its occurrence back exactly once.
- **planMove equals describeMove** on random group moves the stop step did not rewrite (13.1). **Replay**: an op log with traps replays to the same traps, tokens and lines. **Presets**: `scripts/srd-import.ts` checks each preset's DCs, damage and trigger words against the SRD text.
- **e2e** `e2e/traps.e2e.ts`, steps labelled `tr-1` on: the DM builds a Hidden Pit from its preset, a player drags across it and stops in it with the line and a toast, Undo move is refused, the DM's card applies the group save with the request reading "Trap", the trap shows found, and a shot of the pane at 375 x 667 at 130%. Run with `reach`.

## 12. Build plan

After movement's and attach's builds, on their tip:

1. `feat(rules): trap zones, progress and what sets a trap off`: `shared/rules/traps.ts`, pure, on movement's `routeSpots` and `sizeCategory` and attach's `carriedGroup`.
2. `feat(model): traps in the room state, with their ops, limits and projection`: model, protocol (with `door.set`'s `by`), the next versions, permissions, create, update, delete, act and settle, projection, fan-out, the guard's reserves, the pit border count, duplicate, scene delete, export and import.
3. `feat(reducer): traps go off on walks, landings, turns and doors`: the two passes, stops, events, frozen hits, actions, lines, occurrences, arming, `trap.spring`, `actor.outcome`'s `trap`, the refused player undo. With the randomized and differential tests.
4. `fix(reducer): a teleport enters an area only where it lands`, under `N` (6.6).
5. `feat(srd): the SRD's example traps as presets`.
6. `feat(traps): the trap tool and its pane`.
7. `feat(traps): traps on the map, in the outliner and on the drag label`.
8. `feat(traps): what a trap going off shows`: the DM's toast and card, the players' line, toast and sound, the Log panel's merge, the bar's undo offers.
9. `feat(dice): the group save from a trap`, with `publicName`.
10. `feat(traps): the Passive Perception hint`.
11. `feat(traps): pits open the ground`, with attach's group rules and second link pass.
12. `perf(traps): bench the worst group move`.
13. `test(e2e): traps`.
14. `docs: traps in docs/design.md, FEATURES.md and the DM guide`: design.md sections 6 (model), 7.3 (projection), 7.7 (the refused player undo), 8.1 (ops), 9.3 (the teleport sweep), a new 9.12 (traps), 10.5 (limits, reserves and the pit count), 16.2 (versioning) and 16.4 (export). The shortcut sheet holds keys and key-plus-pointer combinations only (the project owner's rule of 2026-10-16), and the Trap tool has neither, so the sheet gains no row: its taps and drags are told in FEATURES.md's Traps section and the guide's prose.

## 13. The shared move description

The three designers agreed this, each signing their part in the shared contract. Movement and attach state their sides in their own notes.

### 13.1 One description of a move

```ts
type Pose = { sceneId: SceneId, x: number, y: number, elevation: number }
type RoutePoint = { x: number, y: number, elevation: number }   // the footprint's top-left corner
type MovedToken = { tokenId: TokenId, from: Pose, to: Pose,
  route: RoutePoint[]                     // from `from` to `to`: two points for a straight leg
  how: 'walk' | 'teleport' | 'scene' | 'reshape'
  carriedBy?: TokenId }                   // attach: moved only because its holder moved
type MovedEntry = MovedToken & { pass: 'public' | 'private' }   // public: seen by all, with links seen by all (5.3)
function planMove(op: Op, before: RoomState, actor: Viewer): MovedEntry[]   // before dispatch, sorted by token id
function describeMove(op: Op, before: RoomState, after: RoomState, actor: Viewer): MovedEntry[]   // the same, after it
```

- The route comes from the op (movement's optional `route` on `token.move`: straight pieces on the half-cell lattice, at most 64 and 300 squares in all, `token.moveMany` staying straight legs) or from stored state by a fixed rule, never from a search a later build could answer differently. Elevations follow movement 4.2 and attach's rule for what it carries.
- Attach's Get off is a `walk`. An elevation-only `token.update` is a `walk` of two points. Setup placements are `reshape` or `scene`.
- **The acting context.** Both take the actor. Public entries are the members seen by all, sampled on their step. Private entries follow their public group's landing by their offset, each walked on its own step, a `drag` entry only up to its own wall stop and what it carries along that stopped route, and never change a public entry. Limits and refusals read attach's `checkSet`, the public members plus the tokens the op names (contract 5), since every viewer misses an op a refusal stops. A group with no public member is all private.
- `planMove` must equal `describeMove` for every op the stop step did not rewrite, which a randomized test checks. Traps detect everything once, from `planMove`.

### 13.2 The order inside `applyOp`

A move op:

1. The trap step's plan, both passes: events, stops and frozen hits, which may rewrite the op's landing and route (5.5).
2. Dispatch: path legs, squeeze, attach's carried tokens, and last attach's link pass.
3. `endSaves`, where it runs today (`shared/reducer.ts:126`).
4. `describeMove`.
5. The trap step's writes (5.7), then attach's link pass again when a pit moved tokens.
6. Area reminders (`remindAfter`), along each route, a teleport only where it lands.
7. `tx.finish`.

`encounter.next`: when `pressChangesNothing`, nothing below runs. Else `remindTurnEnd` and the trap step's turn-end events on the room before, then dispatch (with attach's mount rows), then the trap step arming `nextTurn` traps and its turn-start events, `endSaves`, the trap step's writes and the link pass when a pit moved tokens, `remindAfter`'s turn-start reminders, and `tx.finish`.

### 13.3 Spots and progress

Movement's `routeSpots(build, route, token, step?)` gives `{ x, y, elevation, squeezed, stand, progress }` spots, `progress` being `[piece, k, n]`, `build` the scene's wall and heights context. For a group the caller passes one step, from the members seen by all (contract 5's public members), and each public member's spots are the holder's on that step plus its offset. `stand` includes the cut route's leg test for any spot off its piece's segment (M15). No fallback sampler: traps build after movement.

### 13.4 From movement and from attach

- **Movement**: the route, `routeSpots(build, route, token, step?)` with `progress`, `stand` and the public members' step, the cost from the rewritten route (4.4), `sizeCategory`, and the area sweep, which keeps `alongLeg`'s half-cell interpolation on every piece and below movement's version keeps today's sampler exactly.
- **Attach**: `moveGroups` by nearest named ancestor, `publicMembers` for what others observe and `checkSet` for limits and refusals, the second listed reveal, `carriedBy`, `on` tokens never on the floor, `drag` tokens on their own elevation, a group stopping together, hidden members left to the private pass, Get off as a walk, the seat leg ignored, the group rules a pit's height change moves tokens by, and the link pass at the end of dispatch and after a pit.

## 14. Questions for the project owner, and the answers

Answered on 2026-10-18, before the review, each as recommended:

1. **Should a trap roll and apply its own save, with no tap from the DM?** No. It shows the card, and one tap opens the group save filled.
2. **Should the DM's own drags set off traps?** Yes, on the players' scene outside a blackout.
3. **Should a trap that goes off stop the creature's move?** Yes by default. A silent alarm turns it off.
4. **May players search or disarm a found trap themselves?** No. The DM asks for the roll and flips the switch.
5. **Should Passive Perception hint to the DM?** Yes, DM only, never marking a trap found by itself.
6. **Should an opened pit lower the ground under its lid?** Yes, as its own build step (5.7, step 11).
7. **Should traps make sounds?** Yes: five synthesized sounds with the players' line, behind This device's sound switch.

Answered after round 1 of the review:

8. **May a player's Undo move take back a move a trap stopped?** "No." Refused when a trap stopped the move or showed its player a line. A silent trap leaves Undo as it is (6.5).
9. **DM routes** (movement's question): "Party's knowledge." It changes only which route an op carries, and traps sweep whatever route that is.

After round 2 the owner answered movement's Plant Growth question (the larger cost only), which traps does not read, and handed new product questions to the coordinator. The coordinator settled within the answers: getting off a mount and landing from the height controls set traps off, setup placements do not, and each feature has its own versions. After round 3 the coordinator added two listed reveals to the contract: a visible token follows a holder players cannot see (attach's), and in the DM's own ops a hidden creature's springing shows through the trap's actions (5.5). This revision raises no new question.

## Appendix A. Presets (SRD 5.2.1, levels 1–4, then the "At Higher Levels" rows)

| Trap | Zone | Goes off | Afterwards | Stops | Hits | Save and damage | Find, and more |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Collapsing Roof | wire | crossed | once | yes | squares to draw ("the unstable section of ceiling") | Dex DC 13, 2d10 bludgeoning, half. 4d10 DC 15, 10d10 DC 17, 18d10 DC 19 | Wis (Perception) DC 11 |
| Falling Net | wire | crossed | once | yes | the creature | Dex DC 10, Restrained on a fail. DC 12, 14, 16 | Wis (Perception) DC 11. Huge or larger succeed. Escape: Str (Athletics) DC 10 |
| Fire-Casting Statue | 1 square | steps onto, starts its turn | next turn | yes | a 15 ft cone to place. 30, 60, 120 ft | Dex DC 15, 2d10 fire, half. 4d10, 10d10, 18d10 | Wis (Perception) DC 15 the plate, DC 10 the glyph |
| Hidden Pit | 2 x 2 squares | steps onto | once | yes | the creature | no save, 1d6 bludgeoning. 3d6, 6d6, 12d6 | Int (Investigation) DC 15. Pit 10, 30, 60, 120 ft |
| Poisoned Darts | 1 square | steps onto | next turn, 3 uses | yes | squares to draw ("the darts' path") | Dex DC 13, 2d6 poison, none on a pass | Wis (Perception) DC 15 the plate and the holes |
| Poisoned Needle | door | opened | once | no move | the creature | Con DC 11, 1d10 poison, half, Poisoned on a fail. 2d10 DC 13, 4d10 DC 15, 10d10 DC 17 | Wis (Perception) DC 15. Disarm: Dex (Sleight of Hand) DC 15, a fail sets it off |
| Rolling Stone | 1 square | steps onto | once | yes | none | none: the stone hits on its turns | shows the stone's token. Note: Initiative +8, 60 ft a turn, Dex DC 15 or 10d10 bludgeoning and Prone |
| Spiked Pit | 2 x 2 squares | steps onto | once | yes | the creature | no save, 1d6 bludgeoning + 2d8 piercing. 3d6 + 3d8, 6d6 + 8d8, 12d6 + 13d8 | Int (Investigation) DC 15. Pit as Hidden Pit |

Every preset sets Party creatures, `floor` on and the hint where it has a Perception check. The darts' "1d3 darts, taking 3 (1d6) Poison damage per dart" fits no formula, so the preset deals two darts and its note says how to roll it (2d6, 4d6 and 7d6 a dart at higher levels). Poisoned Needle's Poisoned lasts "1 hour", which a fight's rounds cannot count, so it lasts until removed. A pit's floor is the lid's ground less its depth, stopping at the height rules' −100 ft.

## Appendix B. Reservation arithmetic

Worst cases in JSON bytes, from the complete serialized write. A plain id is at most 66 with its quotes (6.1), a trap's id included. Trap text refuses lone surrogates, which JSON would escape to 6 bytes, so it counts 3 bytes a UTF-16 unit, the most UTF-8 takes, and 2 for an escaped quote, backslash, tab or line break. A line's own `id` (`seq:index`, at most 25 characters) is 27 bytes with quotes and its `at` 26. `K` is the scene id's serialized length with quotes, 66 for a plain id and at most 386.

| Part | Worst case | Bytes |
| --- | --- | --- |
| A trap's own fields (9 KiB cap) | name 242, message 602, note 3,002, disarm text 602, three `what` 726, 8 actions at most 130 each 1,040, damage 4 x 150 600, the zone and hits 8 rects each 560, the rest about 1,300 | about 8,700 |
| Small fields the reducer writes | `"state":"disarmed"` 18, `"found":false` 13, `"usesLeft":99` 13, `"rev":` with 16 digits 22, `"noticedBy":` and an id 78, separators | 160 |
| Action and stop slack | 8 actions: a door's state word and a chunk's rev digit 8 each, a light's `on` and rev 4, a reveal's rev 2. A stop's landing and path digits 32 | 100 |
| A pit, per chunk its squares touch | a whole new chunk as `emptyChunk` makes it and `buildHeight` fills it: the map key `K + 6` and colon, `{"sceneId":K,"cx":12,"cy":12,"rev":` 16 digits `,"cells":{},"edges":{},"heights":"` 684 `"}` `770 + K`, a comma, the scene's walls version digit | `2K + 780` |
| Tokens a pit moves, per scene with a pit trap | 500 tokens, each an elevation up to 4 characters longer and a rev digit, with attach's riders among them | 4 KiB |
| One occurrence | `{"id":27,"at":26,"how":18,"by":[10 x 66 + 9],"more":999,"hits":[50 x 66 + 49],"hitsMore":999,"perceived":true,"hidden":true,"acted":true}` with keys | 4,191 |
| The room's 10 occurrences | 10 x 4,191 plus each trap's `"due":[]` | 42 KiB |
| A DM line | envelope (id, at, `kind`, `data`) 90, type 14, trapId 76, name 250, how 18, `by` 677, `more` 11, `hits` count 11, `did` 200, `seen` 29, `hidden` 14 | 1,391, cut to 1,536 |
| `trapLog` | 30 x 1,536 | 45 KiB |
| A players' line | envelope 90, type 18, `by` 677, `more` 11, message 613, sound 17 | 1,427, cut to 1,536 |
| `trapSeen` | 20 x 1,536 | 30 KiB |

So a room with traps reserves 117 KiB at room level, and each scene 260 bytes a trap, `2K + 780` for each chunk a pit touches and 4 KiB once it has a pit trap: 13 KiB at 50 traps without pits. The review's probe of eight 2 x 2 pits across 32 new chunks grew a scene by 24.5 KB, inside its reserve of 32 x 856 = 27.4 KB for a 36-character scene id. Its 1.7 KB line held an escaped trap id, which `trap.create` now refuses.
