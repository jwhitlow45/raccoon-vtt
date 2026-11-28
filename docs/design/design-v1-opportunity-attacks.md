# raccoon-vtt v1: Opportunity Attack notices

Status: built. Round 3 of the design, revised after design review rounds 1 to 4 (decisions D-261128-050 to 069), and As built says where the build went its own way.

Read at main qknrsupo 78f62b4c (OP_VERSION 69, SNAPSHOT_VERSION 52). Decisions D-261128-050 to 069. The starting point is D-261127-051: "opportunity attack notices are advisory to the DM and mover and never block or roll", and the Next list's item 5. FEATURES.md today ends its path bullet with "Nothing detects them for you."

## 1. What the table sees

A notice says that a move on a creature's own turn leaves an enemy's reach, so the table knows an Opportunity Attack is possible. It never stops a move, never rolls, and never asks anything. The DM decides, as now.

### During a drag

- The dragging device adds one line to the drag's label, under the cost lines, when it is a DM device or one that answers for the mover (combat/logic.ts `answersFor`). A player who may drag someone else's creature under "Who can move any token" gets no line (D-261128-051).
- Words: **"Leaves Goblin 2's reach"**. Two creatures: "Leaves the reach of Goblin 2 and Goblin 3". Three: all three names. Four or more: "Leaves the reach of Goblin 2, Goblin 3 and 2 more". On a player's device, when every creature named was counted at 5 ft because the device lacks its stat block, the line reads "Leaves 5 ft of Goblin 2" (D-261128-055).
- Each creature the walk leaves gets a dashed ring in the board's warning amber for the drag's length, sized as the hold mark's ring is (movement/MoveLayer.tsx `holdMarkSizes`), at least 3 px, dashed so it never reads as the solid red hold ring or the Dash band's yellow. In Isometric it lies on the ground under the creature (`Lift`, as `HoldMark`).
- The line counts only creatures not already left this turn, since each has one Reaction.
- It reads the walk the drop would take: the route's corners, or the straight leg. While "Finding the way…" shows, it keeps the last reading, as the label does.
- A rider's drag that walks her controlled mount reads the mount's walk, since the mount is the mover. Group drags and arrow keys show no line. Their stored legs reach the card and the toast.
- A drag answer whose scan passes its work cap (section 5), or that comes before the data the scan needs has loaded (section 4, Data), adds "Opportunity Attacks are checked after the drop." instead of names.
- Devices that draw someone else's drag live add nothing (D-261128-067).

### After a move: the turn card

Whoever answers for the turn (the player for a creature a player plays, every DM device for the rest) gets the notice at the top of the creature's block on its turn card, above its attacks:

- Heading **Opportunity Attacks**, then one row per creature whose reach the turn's walk left, in the order it left them, named as this viewer reads it ("Goblin 2", "Unknown creature 1"). A player's row for a creature counted at 5 ft reads "Goblin 2 (5 ft counted)".
- **Rows come from the state at the leg** (D-261128-057). Each leg is scanned once, by a job that snapshots the room as the leg first appears on the device and waits, behind "Checking the walk…", until every chunk its creatures need has loaded or failed (section 4, Leg jobs). Later changes only remove rows: the creature's Reaction is used, it dies or becomes Incapacitated, it leaves this viewer's copy, the leg is marked "Doesn't count" or undone. A later push of the goblin or a door closed after the walk never adds or drops a row. A reload or a late join scans the stored legs against the state then, and FEATURES.md says so.
- A row offers a **Reaction used** button, 44 px tall, where this viewer may set that creature's Reaction (encounter/ReactionSection.tsx `reactionFor`): the DM always, a player only for their own creature. A press sends the existing op (`encounter.update` with `reactionUsed`, or `token.update` with `companionReaction`) and shows busy until the server answers, refusing a second tap. Then the row leaves, since a creature whose Reaction is used can take no Opportunity Attack (D-261128-061). Undo brings it back.
- A creature whose block grants extra Reactions (its text says "extra Reaction" or "Reaction on every turn", as the Hydra's Reactive Heads and the Marilith's Reactive do) keeps its row with its Reaction used, on a device that holds the block, and the row names the trait: "Hydra: Reactive Heads".
- Under the rows, muted: **"Unless Bree took the Disengage action."**
- On any device that holds the mover's block (the DM, or a player whose owl it is), when any section of it says the creature avoids Opportunity Attacks (`/provok\w* (an )?Opportunity Attacks?/i`, as Flyby, Engulf, Charging Horn, Swoop and Trampling Charge do), one more muted line names the first: **"Owl has Flyby, which may avoid them."**
- When the mover is Invisible or has the Hidden status: **"Bree is Invisible. Creatures that can't see Bree get no Opportunity Attack."**
- Rows past 8 end in "and 3 more".
- The card now shows for a creature with rows even when it has no attacks or uses. Folded, it leads with the notice: "Bree's turn: left Goblin 2's reach, 2 attacks", or "left 3 creatures' reach". A new row brings a dismissed card back on this device, folded where it folds, since the row is news (D-261128-060). A row is new only against this device's shown set for the turn (section 4, Leg jobs), so a reload announces no old row. A reload shows a dismissed card again, as it shows every dismissed card today, since combat/state.ts keeps dismissals in memory (D-261128-060). Collapse works as today.
- A scan still running after 200 ms shows "Checking the walk…" in the block, through the shared delayed indicator. A leg past the hard cap reads "Too many creatures here to check this walk."

### The DM's toast

When a player answers for the mover, the DM has no turn card, so each DM device shows a toast as a new leg lands: **"Bree left Goblin 2's reach."** ("Bree left the reach of Goblin 2 and Goblin 3.", four or more as the drag line). Rules (D-261128-060):

- It waits for the SRD rolls table before it reads a leg, so reach is never read at 5 ft for a monster the table knows. Only a failed load reads 5 ft.
- It names only creatures not toasted this turn on this device. It skips a leg only where this device's own drag line showed those names. So a DM's arrow keys, group drag or a drag past its cap still toast. A leg first seen pending toasts once, when it is confirmed.
- On mount and on every change of the turn's seq, Previous included, it seeds its set from the legs already stored, without toasting. A leg joined by the 50-stop cap is never toasted as new.
- During View as a player it toasts nothing, and legs that land then are seeded. A table display never mounts it.

### When it shows, and when not

- Only on the active creature's own turn in a started fight, for that creature and a controlled mount sharing the turn, where the path is tracked today. Moves on other turns (a Reaction, a readied move, a Legendary Action) can provoke too, but no path is tracked for them, so FEATURES.md says the notices cover the creature's own turn only (D-261128-052).
- Players who do not answer for the mover never get it, and nor does a table display.
- **Room settings, Combat**, last row: **Opportunity Attack notices**, on by default. Help: "Tell the DM and the mover when a creature's move in a fight leaves an enemy's reach. Nothing rolls, and no move is stopped." Off, no device shows anything.
- **This device, Features**: a part **Opportunity Attacks** in Tools, after Traps, for both roles, kept by Simple. Help: "A note when your move leaves an enemy's reach." for players, "A note when a move leaves an enemy's reach." for the DM. Hidden, this device shows no drag line, rings, card block or toast. The room switch stays in Room settings, since it is the room's rule (D-261128-063).

### Phones, tablets, computers

- **Phone upright**: the label line stays with the drag's other lines above the finger and keeps to the screen's edge as they do. The card is folded under 600 px wide, so its folded words carry the notice.
- **Phone sideways**: the card stands in the alerts column above a docked bar, as today.
- **Tablet and computer**: the card is open. Rows wrap a long name beside the button, and the button goes under the name where both do not fit.

## 2. Rules (SRD 5.2.1) and other tools

- **Making one** (Playing the Game, Opportunity Attacks): "You can make an Opportunity Attack when a creature that you can see leaves your reach." It takes the Reaction and "occurs right before it leaves your reach". So a leave is a crossing of a reach boundary, and cover and sight are judged where it starts.
- **Avoiding them**: "You can avoid provoking an Opportunity Attack by taking the Disengage action." You also don't provoke one "when you teleport or when you are moved without using your movement, action, Bonus Action, or Reaction", as when you fall past an enemy. The app's uncounted legs ("Doesn't count", Teleport here) and carried legs (dragged, carried, a rider moved by her mount) are those moves. A trapdoor or opening fall changes floor, so its leg is folded away and gives no row. A fall on the same floor is a counted leg until the DM presses "Doesn't count".
- **Reach**: "A creature has a 5-foot reach", longer where its description says so, and a Reach weapon adds 5 ft for attacks with that weapon, Opportunity Attacks included (Equipment, weapon properties). Reach belongs to the weapon used, so a creature with a 5 ft Claw and a 10 ft Tail (the Barbed Devil) can attack at either boundary. A probe of monsters.json finds 91 of 330 SRD creatures with a longer melee reach in Actions (73 at 10 ft, 14 at 15, 3 at 30, 1 at 60), none only outside Actions, and the reviewers' query 13 with two distinct melee reaches. The Weapons table gives Reach to the Glaive, Halberd, Lance, Pike and Whip.
- **Reactions** (Rules Glossary): one until the start of the creature's next turn, which the tracker's Reaction used models. The Hydra and the Marilith get more.
- **Incapacitated**: "You can't take any action, Bonus Action, or Reaction." Paralyzed, Petrified, Stunned and Unconscious include it. Dying and stable creatures are Unconscious.
- **Blinded**: "You can't see". The glossary's exception is Blindsight, and the app's vision already zeroes Truesight while Blinded (shared/rules/vision.ts:1795). So a Blinded creature counts only with enough Blindsight.
- **Invisible**: "You aren't affected by any effect that requires its target to be seen unless the effect's creator can somehow see you." The Hide action gives "the Invisible condition while hidden", so the Hidden status reads the same. Blindsight or Truesight sees such a mover.
- **Mounted Combat**: a controlled mount can take only the Dash, Disengage and Dodge actions and moves with its own Speed, so the mount provokes. The rider is moved without her movement, so she does not. Whom the attacker hits is the table's call.
- **Prone** changes nothing. A Prone creature can still make one, and a crawling one still provokes.
- **Left to the table**, each named in FEATURES.md and the guide: Disengage (the action, a Rogue's Cunning Action, a goblin's Nimble Escape), Sentinel, Mobile, Polearm Master's entering reach, War Caster, Charmed (can't attack its charmer), and light, darkness and obscurement. A Cunning Action rogue who disengages every turn still gives the DM a toast every turn. The Disengage line and the trait line keep the notice honest: it states the geometry and the tracked Reaction, never a ruling.
- **Other tools**: the cores of Foundry VTT and Roll20 leave Opportunity Attacks to the table. Community add-ons for both warn during a drag or prompt the reactor's player. Ideas taken: a warning on the drag and a note after it, with no prompt and no roll.

## 3. Privacy

Nothing new goes on the wire for notices (D-261128-050). Each device scans its own copy:

- **DM devices** read everything: every creature, hidden conditions, stat blocks, senses and walls.
- **The mover's owners** read their own creature's whole path (rules/path.ts `stopsForOwners`) and only the creatures their projection holds, the ones they can see now: no hidden token, nothing under the fog, nothing only another player's character sees on a per-player scene. A creature they do not own reaches them as a public actor (life and shown effects), with no stat block, Speed or senses, and its row's Reaction used only where they see its row. Walls are those of the build they hold. The SRD rolls table is public data, but a player's copy holds no `srdId` for creatures they do not own, so it reads nothing there for them.
- So a player's notice names only creatures their screen draws, counts and words 5 ft for every creature whose block they lack, ignores a condition the DM hid, and never drops a creature for a reason they cannot see. It tells them nothing a ruler would not.
- The DM's toast is drawn on DM devices only. View as a player scans the player view it shows.
- Test (section 9): a player's result is a function of their projection alone.

## 4. Model and code

### Nothing stored for notices

Notices derive from the turn's path (`Token.path`), tokens, effects, rows, stat blocks and walls. No new op, token field or log event. The one stored addition is the room switch.

### The room switch and versions (D-261128-062)

- shared/model.ts `RoomSettings` gains `opportunityNotices?: boolean`, absent reading on. shared/protocol.ts `room.update` settings gains `opportunityNotices: z.boolean().optional()`. shared/reducer/room.ts stores `false` and removes the field on `true`. The DM's only, as every `room.update` is. server/rooms/stateSchema.ts settings gains `opportunityNotices: z.literal(false).optional()`. client/features/settings/form.ts `toggleOn` reads it through `opportunityNoticesOn`, so an old room's switch shows on.
- server/rooms/undoLabels.ts: Setup, "turning off Opportunity Attack notices" and "turning on Opportunity Attack notices".
- **One shared identity step, its own lane STEP70 on main: OP_VERSION 70 and SNAPSHOT_VERSION 53** (D-261128-062). DEDGE's design steps OP_VERSION to 70 with one predicate, `squeezeWalksWhole` (`WHOLE_SQUARES_OP_VERSION = 70`), and needs no room format step. This switch needs one: `room.update` carries a field older strict schemas refuse, and an older build's strict state schema would fail on a room holding it, so the step makes that build refuse the room by version. STEP70 holds shared/migrate.ts's constants, the op step 69 to 70 with DEDGE's predicate and constant as DEDGE names them, the snapshot step 52 to 53, shared/migrate.test.ts, and docs/self-hosting.md's one rule 15 bullet under **Since v0.5.0**: "Squeezing walks and traps, and Opportunity Attack notices: change format 70, room format 53." It carries DEDGE's sentence on squeezing walks, then: back up the database just before the update, reload DM pages first, then every other open page, and after a clean stop an older build refuses any room this version saved a snapshot of, and after a crash or a forced stop any room with changes at format 70 after its last snapshot, so going back needs the backup taken just before the update. DOA and DEDGE both base on STEP70, and neither touches migrate.ts again. STEP70 never deploys without DOA or DEDGE on top, and whichever stack deploys it writes the bullet's final wording, naming only what ships. If DOA ships alone, STEP70 leaves DEDGE's predicate out. If the stacks deploy apart, the later one takes its own step (DOA: OP_VERSION 71 and SNAPSHOT_VERSION 54), since a build between them would load a room holding the switch with a schema that refuses it.
- Replay: no stored op below 70 carries the field. Export and import carry settings whole. Players' projection carries settings as today, which the switch needs.

### The scan (shared/rules/opportunity.ts, new)

Pure, shared by the drag, the card and the toast, so they agree:

```ts
export type ReachLeg = { id: number; from: PathStop; to: PathStop; provokes: boolean }; // id: the occurrence's, from reconcileLegs; provokes: counted and not carried, read as a filter
export type Reactor = { id: string; token: FootprintToken; reaches: readonly number[]; blinded: boolean; blindsight: number; truesight: number; known: boolean };
export type ReachLeave = { id: string; spot: number; reach: number };
export type Chunks = { rolls: SrdRolls | "failed"; monsters: SrdBlocks | "failed" }; // passed in loaded or failed, never pending
export type ScanInput = { grid: Grid; rules: DistanceSettings; walls: ReachWalls; mover: PlacedToken; moverUnseen: boolean; reactors: readonly Reactor[] };
export type LegRecord = { id: number; from: Spot; to: Spot; parts?: readonly LegRecord[] }; // parts: the two records a join holds
export function reconcileLegs(prev: readonly LegRecord[], next: readonly Pick<ReachLeg, "from" | "to">[], newId: () => number): { legs: LegRecord[]; added: LegRecord[]; removed: LegRecord[] };
export function* reachScan(input: ScanInput, leg: ReachLeg, skip: ReadonlySet<string>, slice?: number): Generator<number, ReachLeave[] | "over">; // yields work done
export function chunksNeeded(view: ReachView, moverId: string): { rolls: boolean; monsters: boolean };
export function reachInput(view: ReachView, moverId: string, path: TokenPath | null, chunks: Chunks, viewer: Viewer): { input: ScanInput; legs: ReachLeg[] } | null;
export function rowStands(view: ReachView, leave: ReachLeave, viewer: Viewer): boolean; // the later filter
export function reachOf(view: ReachView, token: Token, chunks: Chunks): { reaches: number[]; known: boolean };
export function avoidTrait(block: StatBlockMonster): string | null;
export function extraReactions(block: StatBlockMonster): string | null;
export function reachWords(names: readonly string[], verb: "Leaves" | "left", fiveFt: boolean, max: number): string;
export function opportunityNoticesOn(settings: { opportunityNotices?: boolean }): boolean; // typed locally, so lane A builds before lane B
```

- **Feed.** Callers pass `path` from client/features/measure/movement.ts `pathNow`, which knows players' copies without a turn start or with no acting row (review AT-HIDDENPATH), and the mount's path the same way.
- **Spots.** Each leg is walked as rules/path.ts `legOnGround` walks it: its straight parts from `legParts`, sampled by `legSteps` on the leg's lattice on squares and by `hexPiece`/`hexPieceSpots` on hexes, each spot at the size its stop holds (`standingAt`), a squeeze inside the route read at the stop's size on drag and card alike. A small refactor lifts that walk into path.ts `legSpots(g, token, from, to)`, which `legOnGround` then calls unchanged. Heights follow `legParts` (D-261128-066). A leg's first spot is the stop the previous leg ended on, so each leg scans on its own and the turn dedupes by creature, first leg first.
- **Distance first** (D-261128-056). A creature is within reach `r` of the mover at a spot when its distance is at most `r`. The distance of a neighbor, at most 1 step apart on every axis, is one cell's feet (`feetPerCell`) under every diagonal rule, since true distance would round a default-grid diagonal to 7 ft (distance.ts:118 and :129). So a neighbor is 5 ft away on the default grid and 10 ft on a 10 ft grid, where a 5 ft reach does not reach it, as `distanceFt` reads. Any other distance is `distanceFt` (edge to edge, sizes, height, the room's diagonal rule). A leave is a step from one spot within `r` to the next spot beyond `r`, for any `r` in the creature's reaches. Walls and sight never make a leave.
- **Gates at the departure spot** (the last spot within `r`). Cover: some pair of cells, one under each creature, within `r` of each other by the same measure, has a line between their centers that no blocking piece stops (walls.ts `blocksAreas`: walls, windows, closed doors). A line crossing a piece is stopped. A touch at a point is stopped only when the blocking pieces meeting there lie on both sides of the line, by the sign of the cross product of the line's direction with each piece's direction from the point, or when one piece continues straight through it. So a straight drawn-wall joint, a room corner crossed from inside to outside and a wall beside a closed door stop it, and a bend's inner corner, an outer corner and a free end pass, on squares and at hex vertices alike. The DM's stored walls, drawn and free, are read exactly. A player's held free pieces (walls.ts `isPiece`) are read by `pieceTouches`, as client-only checks read them. Sight: a Blinded creature needs Blindsight of at least the distance, and an Invisible or Hidden mover needs Blindsight or Truesight of at least the distance. A crossing whose gates fail is no leave, and a later crossing of the same creature may still be one.
- **Reactors** (`reachInput`, D-261128-053): creatures other than the mover, not objects, on its scene and floor, with the opposite ring (Ally against Hostile, Neutral against neither), alive, with no Incapacitated, Paralyzed, Petrified, Stunned or Unconscious in the view's effects, Reaction free by the view's row or shared companion's mark (unless `extraReactions` names a trait in a block the view holds), and not linked to the mover (attach.ts `carriedGroup` both ways). Senses come from the actor's senses line (vision.ts `parseSenses`), which DM and owner copies hold. `extraReactions` reads the block from `chunks`, so a used-Reaction Hydra is judged only once its block has loaded.
- **Reaches** (`reachOf`, D-261128-054): a monster's or companion's block gives `RollNumbers.reaches`, an SRD one from the rolls table, a room monster or companion block from `blockRollNumbers` live. A character has 5 ft (an Unarmed Strike) plus 10 ft when a weapon roll is named for a Reach weapon. Absent reads [5] with `known` false, and so does a chunk that failed. A chunk never reads as absent while it loads, since `Chunks` holds only loaded or failed ones. Each value is capped at 120 ft.
- **Rows** (`rowStands`): the cached leaves of every stored leg that still provokes, kept while the creature is in this viewer's copy, alive, not Incapacitated and its Reaction free (or `extraReactions`). The drag's `skip` is the set of creatures with cached leaves this turn.

### Leg jobs (client/features/combat/opportunity.ts, D-261128-057)

- **One job per leg.** When a leg first appears on the device (a drop, a reload, a late join, Previous), a job takes the room view as it stands then, asks `chunksNeeded`, requests those chunks through dice/creature.ts `srdNeeds` as `creatureRolls` does (creature.ts:190), and waits until each has loaded or failed. Then it builds its `ScanInput` once from that snapshot and the chunks, and its slices finish on it. A later push, door or sight change never reaches a running job.
- **Queue.** New legs queue behind running jobs and never cancel them. A job is cancelled only when `reconcileLegs` removes its leg (Undo, or a rewrite it cannot match) or the room, the view (role, View as a player) or the turn becomes invalid. "Doesn't count" keeps the job and its result, which `provokes` then filters, so pressing it back brings the rows back.
- **Occurrences, not content** (D-261128-057). A leg is a movement occurrence, not a shape: A to B to A to B holds two A to B legs scanned against two rooms, and the reducer rewrites legs that did not move (reducer/tokens.ts:620 fills every earlier stop without a footprint with the old one on a reshape, path.ts `capCorners` drops corners past 100). So each leg gets a device-local occurrence id when it first appears, and every path update is reconciled against the previous one by `reconcileLegs` (shared/rules/opportunity.ts, pure). It matches legs in order by their from and to spots (x, y, elevation), ignoring footprints, corners and marks, and knows the reducer's rewrites:
  - a stop appended: one new leg, one new id
  - the last leg undone: that record removed
  - the oldest pair at one size joined by `withStop` past 50 stops: one record holding both as `parts`
  - footprints filled on a reshape, corners removed by `capCorners`, a mark changed: every id kept
  - an Undo that reverses a join: its `parts` come back with their ids, jobs and results
  - anything else it cannot match: removed records and new legs, scanned afresh, never a rescan of a known leg
- **Representation only.** A rewrite that only changes representation keeps every leg's id, job and result and is never toasted. A change of floor removes the floor's records (D-261128-068), and a new turn seq starts afresh.
- **Joins.** A joined record keeps its parts' jobs and snapshots until they finish: compaction transfers jobs and never cancels them. Its result is the union of its parts' results, published as they finish. The join itself is never toasted, and a part that finishes after it toasts only its own rows not yet toasted, as it would have unjoined.
- **Shown set.** Rows count as new against a device-local set of shown row ids, keyed by room and turn seq and kept in sessionStorage (in try and catch, empty where storage fails), so a reload in the tab keeps it. Only the current turn's set is kept.
- **The drag** adds no names while any earlier job of the turn is unfinished, waiting for chunks or scanning, and shows "Opportunity Attacks are checked after the drop." instead, so its `skip` is always complete.

### Reach data

- shared/dice/bonus.ts `RollNumbers` gains `reaches?: number[]`: the distinct reaches, ascending, of the melee attack entries in the block's Actions (2024 "Melee Attack Roll" and 2014 "Melee Weapon Attack", "Melee or Ranged" included), written only when one is above 5. `blockRollNumbers` reads it. Not stored in rooms.
- shared/srd/rolls.json regenerated with `node scripts/srd-import.ts --rolls`. Its test still checks the file against the blocks.
- shared/dice/named.ts: `REACH_WEAPONS` (Glaive, Halberd, Lance, Pike, Whip), hand-written with a comment naming the SRD's Weapons table, and `weaponReach(name)`, by a name's last words as `weaponNamed` matches. scripts/srd-import.ts checks the list against the table when it runs from the SRD text, as it checks the trap presets.

### Client by file

- client/features/measure/movement.ts: `DragRead.leaves?: { names: string[]; fiveFt: boolean } | "over"`, and `dragLabel` adds the line by `reachWords`.
- client/features/movement/preview.ts: `walkPreview` builds the new leg, runs `reachScan` to its drag cap with the turn's `skip`, names the creatures, and puts the ids in the movement store. Only for a DM device or the mover's answerer, while the room switch and the part are on.
- client/features/movement/store.ts: `reachSlot` (the ids for the rings, cleared at the drop, cancel or drag end) and `shownLeaves` (the names a drop's line showed, by token and target, which the toast reads to skip that leg).
- client/features/movement/MoveLayer.tsx: `ReachMarks`, the dashed amber rings, beside `HoldMark`.
- client/features/modules/registry.ts: the `opportunity` part (group tools, both roles, Simple for both, home `menu`, so the DM menu and the You menu end with **Show Opportunity Attacks**), names "opportunity attack notices", "attacks of opportunity", "OA", "reach", "disengage". 24 parts for a DM, 16 for a player. Its ownership golden and registry tests follow. Lane C1 owns it, so its own gate call has the id.
- client/features/combat/opportunity.ts (new): `useTurnReach()`: the leg jobs and their cache, the shown set, and `rowStands` over the view.
- client/features/combat/alerts.ts: each block of `TurnCardModel` gains `reach: { id; name; fiveFt; trait: string | null; mark: ReactionTarget | null }[]`, `checking`, `over`, `unseen` and `avoid`. A block with rows makes the card show, and a new row clears this turn's dismissal on this device.
- client/features/combat/TurnCard.tsx: the block, and `turnUsesText` leads with the notice words when folded.
- client/features/combat/opportunityToasts.ts (new): the DM toast controller, mounted in features/layers.ts CONTROLLERS as `TeleportToasts` is, by section 1's rules.
- client/features/modules/surfaces.ts (TurnCard.tsx's control sites, 5 today, grow by the block's group and button), surfaces.scan.test.ts (`RUNTIME_GATES` gains opportunityToasts.ts), parts.markup.test.ts and controls.golden.json: the gate's own checks, in lane C2.
- client/features/settings/form.ts and search.ts: the Combat row, its `toggleOn` reading and its search entry ("opportunity attacks", "attacks of opportunity", "OA", "reach").
- Server: nothing beyond the switch's undo labels and schema.

## 5. Performance and caps (D-261128-065)

- **Work units**: one distance test between two precomputed boxes is 1 unit on squares, and on hexes one unit per hex pair compared (up to 144 for two Gargantuan creatures). Each blocking piece a gate line is tested against is 1 unit. `work` counts them, as `visionWork` counts sight.
- **Precomputed**: each reactor's cell box and hex set once per scan, the mover's box per spot by moving its base box, never two new `CellBox` per test.
- **Buckets**: reactors go into a grid of 4-cell squares by their box grown by their largest reach plus one cell. A spot asks only the buckets under its own box, so a creature that could not be within reach is never tested. A creature is dropped from the rest of the leg once it leaves, since rows dedupe by creature. Gate lines ask the scene's segment index for pieces near the line only.
- **Bounds**: a path holds at most 50 stops and 100 corners (protocol.ts), so its parts are at most 150, each at most 400 lattice steps on a 200-cell side. A scene holds at most 500 tokens. The legal worst case, every token a long-reach enemy within reach of a winding walk, is about 3 × 10^7 units for a whole turn on squares and more on hexes. Real fights are far smaller: 30 goblins around a 120 ft walk of 4 legs is under 3,000 units.
- **Finishing without blocking**: a drag answer scans at most 20,000 units synchronously, then shows "Opportunity Attacks are checked after the drop." A stored leg's job scans in slices of 20,000 units between frames (`reachScan` yields and a timer resumes it, on its own snapshot), so a drag, a pan or a tap never waits on it. The block shows "Checking the walk…" past 200 ms. Past 2,000,000 units for one leg it stops with "Too many creatures here to check this walk.", and the toast says nothing for that leg.
- **Caching**: each leg's leaves are cached on its occurrence id and the turn's seq, so a new drop scans only its own leg, and the drag's scan is keyed on its route and `skip`.
- **Phone benchmark, required in the build**: e2e/opportunity-bench.e2e.ts, run by the lane and not in CI, in Chromium at 390x844 with CPU throttling at 6x (Emulation.setCPUThrottlingRate, a mid-range phone's stand-in), on the 30-goblin fight and on a dense fixture (200 hostile creatures with 10 ft reach around a 50-stop walk, on squares and on hexes). Targets: a drag answer's scan at most 4 ms median of 20, and every slice at most 8 ms. The lane reports the numbers, and a miss blocks the lane until the caps or slices are tuned.
- Words cap the lists: three names in the label and toast, eight rows on the card.

## 6. Keyboard, touch and accessibility

- No new key, gesture or shortcut sheet row. Tab reaches the card's Reaction used buttons in row order. Each is 44 px tall, shows busy while it waits and refuses a second tap. After its row leaves, focus moves to the next row's button, else the previous row's, else the card's Collapse button where it shows, else the card itself (`tabIndex` -1).
- The block is a group named "Opportunity Attacks". A polite live region in it says each new row once ("Left Goblin 2's reach."), so a keyboard mover hears it. The toast is announced as toasts are. Canvas rings and the drag line are not read, and nothing depends on them alone.
- Contrast: rows use body text, led by Icon.tsx's `combat` icon. The rings are dashed and 3 px or more on the board's dark ground. No animation, so reduced motion needs nothing.
- 130% interface size: rows wrap, the folded words end in an ellipsis as today.

## 7. Assets

None new. The rows' icon is Icon.tsx's `combat`.

## 8. UI checklist and cases

- Loading: a leg's job shows "Checking the walk…" past 200 ms while it waits for its chunks or runs its slices. The toast waits with it.
- Keys and focus, screen readers, large sizes: section 6. Exact words: section 1.
- Alignment: the card with the block, DM with buttons and player without, joins the sweep's roots (e2e/alignmentRoom.ts) at 1440x900, 390x844 and 320x568, 100% and 130%. The drag label is canvas, checked by the drag e2e's screenshot.

| Case | Expected | Test |
| --- | --- | --- |
| Bree walks from beside Goblin 2 to 15 ft away | Drag line, ring, card row, DM toast | opportunity.test, combat.e2e |
| Walks past Goblin 2 without stopping beside it | One row, the leave mid-leg | opportunity.test |
| Leaves, comes back, leaves again | One row | opportunity.property |
| Teleport, or a leg marked Doesn't count | No row, or its rows go | opportunity.test |
| Falls past a goblin on the same floor, then Doesn't count | Row, then none | opportunity.test |
| Trapdoor fall beside a goblin | No row (the leg folds to the floor below) | opportunity.test |
| Dragged goblin follows Bree | Never listed | opportunity.test |
| Rider on a controlled Warhorse | Rows under the Warhorse, none under the rider | opportunity.test |
| 10 ft reactor at (0,0), mover (2,0) to (2,1), every square 5 ft, wall on y=1 from x=0 to 2 | No row (no distance crossing) | opportunity.test (SOL-01) |
| Bree at (0,0) leaves a goblin at (1,1), drawn wall along y=1 | No row (the line meets the joint at (1,1)) | opportunity.test (OPUS-02) |
| Diagonal across a drawn wall, a room corner from inside to outside, a wall beside a closed door | No row | opportunity.test |
| Diagonal past a free wall end | Row | opportunity.test |
| L corridor, wall mass in cell (0,1), cells (0,0) and (1,1) | Row (a bend's inner corner passes) | opportunity.test (R2-01) |
| Room's outer corner seen from outside | Row | opportunity.test |
| Hex vertex where three walls meet on both sides, and one where two meet on one side | No row, and row | opportunity.hex.test |
| DM's stored free walls, and a player's held pieces | Exact, and `pieceTouches` | opportunity.test (R2-07) |
| Open door between | Row | opportunity.test |
| Free wall pieces on a player's copy | Read by `pieceTouches` | opportunity.test |
| Diagonal neighbor under true distance, default grid | 5 ft, within a 5 ft reach | opportunity.test (SOL-08) |
| Neighbor on 10 ft squares and 10 ft hexes, 5 ft reach | 10 ft, beyond reach, no row on stepping away | opportunity.test, opportunity.hex.test |
| Ogre, 10 ft, 5-10-5 rule, two diagonals away | Beyond reach (15 ft) | opportunity.test |
| Same under every square 5 ft | Within reach | opportunity.test |
| Character with a Dagger and a Whip steps from 5 ft to 10 ft | Row (the 5 ft boundary) | opportunity.test (SOL-03) |
| Barbed Devil, 5 ft Claw and 10 ft Tail, one row however many boundaries | One row | opportunity.test |
| Flier rises 10 ft straight up from beside a goblin | Row | opportunity.test |
| Goblin Unconscious, Stunned or dead | No row | opportunity.test |
| Goblin's Reaction used, then marked on the card | No row, the row leaves on the press | opportunity.test, combat.e2e |
| Hydra with its Reaction used | Row "Hydra: Reactive Heads" on the DM's card | opportunity.test |
| Blinded goblin, Truesight only | No row (SOL-02) | opportunity.test |
| Blinded creature, Blindsight 10 ft, beside the walk | Row on the DM's card | opportunity.test |
| Invisible Bree past Truesight 30 ft, and past no special sense | Row, and none | opportunity.test |
| Neutral creature, or an ally beside an ally | No row | opportunity.test |
| Large and Huge movers and reactors, squeezed in a route | By the stop's size, drag and card alike | opportunity.test |
| Hex rows and columns, Large on 3 hexes, 10 ft | Steps by hexes, height counted | opportunity.hex.test, hex.e2e |
| Isometric drag | Rings on the ground | iso.e2e |
| Goblin pushed or a door closed after the leg | Rows unchanged | opportunity.property, combat.e2e |
| Reload after that | Rows from the state then, a dismissed card shows again, no old row announced | combat.e2e |
| Cold-load card: a creature steps from 10 ft to 15 ft of an Ogre before the rolls table loads, or a reload mid-turn | "Checking the walk…", then a row | leg jobs test (SOL-06) |
| Cold load beside a Hydra whose Reaction is used | Row "Hydra: Reactive Heads" once its block loads | leg jobs test |
| A chunk fails | 5 ft for that data, then rows | leg jobs test |
| Second drop while the first leg's job runs | Both finish, the first on its own snapshot | leg jobs test (SOL-07) |
| Reactor repositioned between a job's slices | First result unchanged | leg jobs test |
| Undo during a job, Doesn't count during a job | Job cancelled, and job kept with rows filtered | leg jobs test |
| 51 stops: withStop joins two legs | Union of their rows, no rescan, no toast | leg jobs test, toasts test |
| Join while chunks load, and between slices | Both jobs finish on their snapshots, the union shows, no toast for the join | leg jobs test (SOL-10) |
| Undo after a join | Both legs back with their ids and rows | leg jobs test |
| Large creature squeezes after two legs with rows | Rows and toasts unchanged | reconcile test (R3-01) |
| Path past 100 corners | No rescan, rows unchanged | reconcile test |
| A to B to A to B, a goblin moved beside the route between the walks | The second A to B is scanned against the moved goblin and gives a row | reconcile test (SOL-09) |
| Drag while an earlier job waits or scans | "Opportunity Attacks are checked after the drop." | movement test (R3-02) |
| Hidden goblin beside Bree's path | Player nothing, DM toast names it | priv test, playerphone.e2e |
| Hidden Incapacitated on a seen goblin | Player row, DM none | priv test |
| Player walks from 5 ft to 10 ft of an Ogre (10 ft) | Player row "Ogre (5 ft counted)", DM no row | priv test |
| Co-owners of Bree on a per-player scene | Each reads their own copy, no leak between them | priv test |
| Player drags a monster under "Who can move any token" | No line | movement test |
| DM toast before the rolls table loads | Waits, then the right reach | toasts test |
| DM arrow keys or group drag of a player's creature | Toast | toasts test (SOL-04) |
| Pending leg, then confirmed | One toast | toasts test |
| Previous, reload, second DM device | Same rows, no repeat toasts | combat.e2e, toasts test |
| View as a player, table display | No toast, never mounted | toasts test |
| Dismissed card, then a new row | Card shows again | alerts test |
| Takes the stairs mid-turn | Rows for this floor's legs only | opportunity.test |
| Room switch off, or part hidden here | Nothing anywhere, or nothing here | features.e2e |
| Owl with Flyby, on the DM's and its player's cards | Trait line on both | opportunity.test |
| Dense fixture | Slices, "Checking the walk…", targets met | opportunity-bench.e2e |

## 9. Tests by file

- shared/rules/opportunity.test.ts and opportunity.hex.test.ts: the cases above.
- shared/rules/opportunity.property.test.ts (fast-check over squares and hexes, walls, sizes, heights, reaches, legs), with named invariants:
  - LEAVE: each reported leave was within its reach at the spot before and beyond it at the reported spot.
  - GATED: the departure spot passed cover and sight.
  - ONCE: no creature is reported twice in a turn.
  - NO-PROVOKE: a leg that does not provoke reports nothing.
  - DRAG-EQUALS-CARD: scanning a leg with `skip` from the earlier legs gives what the turn's scan adds for it.
  - ONLY-GIVEN: a creature not passed in is never reported.
  - WALLS-ONLY-REMOVE: adding a wall never adds a report.
  - LATER-ONLY-REMOVES: after a leg's rows are cached, no later state adds a row.
  - JOIN-UNION: a join's leaves equal the union of its two legs' leaves.
- shared/rules/opportunity.reconcile.random.test.ts (fast-check, random moves, undos, resizes and squeezes, more than 50 stops and 100 corners, driven through the real reducer, reducer/tokens.ts and rules/path.ts), with named invariants KEEP (a leg not undone keeps its id through every rewrite), NEW-ONLY-MOVES (only an appended leg gets a new id), UNDO-REMOVES (an Undo removes exactly its leg's record, or splits the join it reverses) and PARTS (a join holds exactly the two records it joined).
  - BOUND: `work` stays within the bucket bound for the case.
- client/features/combat/opportunity.priv.test.ts (property over privTestutil rooms): `reachInput` and the scan over `projectState(state, player)` (shared/project.ts) name only projected tokens, and are unchanged when a hidden token moves, a condition is hidden or a monster's block changes.
- shared/dice/bonus.test.ts (reaches from 2024, 2014 and mixed wording, two reaches, none for ranged only), named.test.ts (`weaponReach`), shared/srd/rolls.test.ts.
- shared/rules/path.test.ts: `legOnGround` keeps its answers through `legSpots`.
- STEP70: shared/migrate.test.ts (the one OP step with DEDGE's predicate, the SNAPSHOT step). Lane B: shared/permissions.test.ts (the DM sets and clears it, a player is refused), shared/reducer/room.settings.test.ts (new: false stored, true removes, as shared/reducer/sound.test.ts tests the sound switch), server/rooms/stateSchema.test.ts, server/rooms/undoLabels.test.ts.
- client/features/combat/opportunity.test.ts (leg jobs, randomized event sequences of drops, slices, chunk loads and failures, Undo, Doesn't count, joins and turn changes, with named invariants SNAPSHOT (a job's result never reads state after its arrival), NO-STARVE (every leg's job finishes or is cancelled by its own leg or turn), ONE-TOAST (no row toasts twice) and NO-FALSE-FIVE (no result reads 5 ft for a chunk that later loads)).
- Client: movement words and `dragLabel` (player wording, the answerer gate), `turnUsesText`, alerts (dismissal cleared by a new row), the toast controller (section 1's rules), registry, Features page, surfaces scan and markup tests.
- e2e: combat.e2e.ts (DM drags a goblin past Bree, card rows, Reaction used, a push after the leg, reload, Previous), playerphone.e2e.ts (player drag line at 390x844, folded words, no hidden creature named), features.e2e.ts (part hidden, room switch), hex.e2e.ts and iso.e2e.ts (drag line and rings), opportunity-bench.e2e.ts (section 5, on demand), the alignment roots, and reach.

Mutation checks: drop the `provokes` gate, the distance-first rule (judge cover inside "in reach"), the two-sided point rule, the `feetPerCell` neighbor rule, the Blinded branch, the shorter reach, the Reaction filter, the chunk wait, the snapshot, the join union and the projection input in turn, and each named test must fail.

## 10. Lanes

STEP70 lands on main first. The other four then start at once on the contract in section 4, based on STEP70, and stack A, B, C1, C2.

- **STEP70, the shared step (S)**: shared/migrate.ts (the constants, the op step with DEDGE's predicate, the snapshot step), shared/migrate.test.ts. DEDGE's stack bases on it too. The deploying stack's docs commit writes the one docs/self-hosting.md bullet (for DOA, lane B).

- **A, rules and data (M)**: shared/rules/opportunity.ts and its four tests (the reconcile test among them), shared/rules/path.ts (`legSpots`), shared/dice/bonus.ts, shared/dice/named.ts and their tests, shared/srd/rolls.json, scripts/srd-import.ts.
- **B, room switch (S)**: shared/model.ts, shared/protocol.ts, shared/reducer/room.ts, server/rooms/stateSchema.ts, server/rooms/undoLabels.ts, their tests, and docs/self-hosting.md's bullet when DOA's stack deploys STEP70.
- **C1, the drag and the part (M)**: client/features/measure/movement.ts, client/features/movement/preview.ts, store.ts, MoveLayer.tsx, client/features/modules/registry.ts and its ownership golden, FeaturesPage.tsx (`SWITCH_ANCHORS` is keyed by every module id), FeaturesPage.test.ts (its part counts), search.test.ts, guards.test.ts, store.test.ts, a PENDING entry for the part in parts.markup.test.ts that C2 replaces once it places the part, their tests, e2e/hex.e2e.ts, e2e/iso.e2e.ts, e2e/opportunity-bench.e2e.ts.
- **C2, card, toast and settings (M)**: client/features/combat/opportunity.ts, opportunity.test.ts, opportunity.priv.test.ts, alerts.ts, TurnCard.tsx, opportunityToasts.ts, client/features/layers.ts, client/features/settings/form.ts and search.ts, client/features/modules/surfaces.ts, surfaces.scan.test.ts, parts.markup.test.ts, controls.golden.json, e2e/combat.e2e.ts, playerphone.e2e.ts, features.e2e.ts, e2e/alignmentRoom.ts. Its last commit updates FEATURES.md for the whole feature: the path bullet's "Nothing detects them for you." (about line 1015), the turn card bullets (about 1341), Room settings' Combat rows, the Features page's 23 parts (1983), its Tools list (1985) and Simple's list (1991), and the own-turn-only, state-at-the-leg and 5 ft facts. The DM guide's paragraph and picture go in the run's guide pass. The note lands as docs/design/design-v1-opportunity-attacks.md with its README index line.

## 11. Decisions

- **D-261128-050**: notices derive on each device from its own copy, nothing stored. Rejected: log reminders written by the reducer as area triggers are (a format step and a log line per walk), and server-computed per-player notices (the server would send reach facts).
- **D-261128-051**: the DM and whoever answers for the mover see it, the drag line only on a DM device or the answerer's. Rejected: the reactor's owners too (they decide the attack, but the DM runs it and the brief names the mover), everyone who sees the mover (noise), and any player allowed to drag it (not the mover's player).
- **D-261128-052** (revised): only on the active creature's own turn in a started fight, because only that path is tracked. Moves on other turns can provoke and FEATURES.md says they are not covered. Rejected: out of a fight (no turns or Reactions tracked, noise while exploring), and tracking off-turn moves (a new path kind, stored).
- **D-261128-053** (revised): a reactor is a creature on the mover's floor with the opposite ring, alive, not Incapacitated by any condition that includes it, its Reaction free unless its block grants extra Reactions, not linked to the mover. Rejected: only creatures with a row (players do not see secret rows), Neutral as everyone's enemy (bystanders), and dropping a Hydra whose Reaction is used (Reactive Heads allows more).
- **D-261128-054** (revised): reach is each distinct melee reach a creature has, from its stat block's Actions or its weapons plus an Unarmed Strike, else 5 ft, and any boundary crossed counts. Rejected: the longest reach alone (misses the dagger's 5 ft), a reach field on tokens or rolls (a format step), and D&D Beyond's weapon properties (a stored field).
- **D-261128-055** (revised r2): a player's device counts 5 ft for creatures whose block it lacks and says so: "Leaves 5 ft of Goblin 2" on the drag and "Goblin 2 (5 ft counted)" on the card, so a step from 5 ft to 10 ft of an Ogre reads as true. Rejected: sending monsters' reach to players (a monster stat), leaving monsters out of players' notices (the common case), and "within 5 ft" (reads as where the walk is).
- **D-261128-056** (revised r2): a leave is a distance boundary crossing, a neighbor at most 1 step on every axis counting one cell's feet under every rule and then compared with the reach, with cover and sight as gates at the departure spot. Cover passes where any pair of cells within reach has a clear line. A touch at a point stops it only when the pieces meeting there lie on both sides of the line or one runs straight through, so joints and inside-to-outside corners stop and inner and outer corners and free ends pass. The DM's walls are read exactly, a player's held pieces by `pieceTouches`. Rejected: cover inside "in reach" (walking behind a wall made a leave), one line between the two nearest cells (ambiguous for Large creatures), a touch never counting (reach through joints), every meeting point stopping (a goblin at a corridor's bend never got a row), and a 5 ft neighbor on every grid (false reach on a 10 ft grid).
- **D-261128-057** (revised r3): each leg is a movement occurrence with a device-local id, scanned once by a job that snapshots the room as it first appears, waits for every chunk it needs to load or fail, and finishes on its snapshot. `reconcileLegs` matches each path update to the last by from and to spots, knowing the reducer's rewrites (append, Undo, a join and its reversal, footprints filled, corners removed), and keeps ids, jobs and results through them. A join keeps its parts' jobs and publishes their union, and rows are only removed later, once per creature a turn. Rejected: rescanning against the current state (a push rewrote the past), scanning before data loads (an Ogre's 10 ft frozen as 5 ft), cancelling a job on any change (starves dense scans), content keys (a reshape or `capCorners` changes them, and A to B walked twice shares one), and rescanning a join or cancelling its parts' jobs.
- **D-261128-058** (revised): a Blinded creature counts only with enough Blindsight, and an Invisible or Hidden mover is seen by Blindsight or Truesight. Rejected: Truesight while Blinded (the glossary and vision.ts say no), each reactor's sight through the vision system (heavy, and players lack monster senses), and ignoring sight.
- **D-261128-059** (revised): Disengage, feats and features are the table's, kept honest by the Disengage line and the trait line. Rejected: a Disengaged status (it could ride this step, but it needs a status key's UI everywhere statuses show, for a notice that is only advisory), and a device-local Disengaged switch (devices would disagree).
- **D-261128-060** (revised r3): surfaces are the drag line and amber dashed rings, the turn card block, and the DM toast for player-answered movers, which waits with the leg's job, skips only legs its own drag line showed, seeds on mount and on each turn change, never toasts a join, and stays off in View as a player and on table displays. A row is new only against a shown set per turn kept in sessionStorage, and a new row brings a dismissed card back. A reload shows a dismissed card again, as for every card today. The drag adds no names while an earlier job of the turn is unfinished. Rejected: board marks for the rest of the turn (clutter), a log line (stored), toasts on every device, suppressing every move this device sent (DM keyboard moves would show nothing), every row after a reload counting as new, and persisting this card's dismissal alone (cards would disagree on a reload, and changing every card's dismissal is outside this feature).
- **D-261128-061**: a row's Reaction used button sends the existing op and drops the row. Rejected: words only (the DM would go to the tracker each time, against "controls live where the DM looks"), and greyed used rows (a list that never shrinks).
- **D-261128-062** (revised r3): the room switch `opportunityNotices?: boolean`, on by default, rides one identity step, OP_VERSION 70 and SNAPSHOT_VERSION 53, in its own lane STEP70 on main with DEDGE's predicate, which DOA and DEDGE both base on. STEP70 never deploys alone, and the stack that deploys it writes the one self-hosting bullet naming only what ships. Stacks deploying apart give the later its own step. Lane B holds only the switch. Rejected: no room switch (the brief asks for one), off by default, two steps for one deploy, the step inside either feature's lane (two stacks would need one file first), and a bullet written ahead naming both (wrong when one ships alone).
- **D-261128-063** (revised r2): the Features part sits in Tools, kept by Simple, its way back in the menus, owned by lane C1 with the Features page and its tests, C2 owning the gate's surface files. Rejected: folding it into Ruler (hiding the ruler would hide notices), Visuals (it is not a look), and leaving FeaturesPage.tsx out of C1 (its anchors are keyed by every module id).
- **D-261128-064**: three names in the label and toast, eight rows on the card. Rejected: one name and a count (hides who), and no cap.
- **D-261128-065** (revised): counted work with precomputed boxes, buckets by box grown by reach, a drag cap, sliced card scans, a hard cap with its words, and a required throttled phone benchmark. Rejected: an unbounded density promise, timed budgets in CI (flaky), and a worker (the slices keep the main thread free at less cost).
- **D-261128-066**: heights between stops as `legParts` gives them. Rejected: the ground under every spot from the build (players' builds differ, so devices could disagree on a stair).
- **D-261128-067**: remote drags show no line. Rejected: scanning on every watching device (the toast covers the DM).
- **D-261128-068**: only the mover's floor counts, and legs folded into `prior` are not rescanned. Rejected: storing the earlier floor's leaves (stored state for a rare case), and reach through openings (rare, with their own area rules).
- **D-261128-069**: the walking ruler shows no notice in this run. Rejected: notices on rulers (shared rulers reach other devices, which the audience rule excludes).

## 12. Look hardest at

1. D-261128-057: occurrence ids and `reconcileLegs` against the reducer's rewrites, the jobs' snapshots and joins, and a reload that can differ from what the table saw.
2. D-261128-056: the two-sided point rule against real drawn walls, free pieces and hex vertices.
3. D-261128-065: the caps and slice size until the benchmark runs.
4. D-261128-062: STEP70 landing first, shared with DEDGE.
5. D-261128-051: the reactor's owners left out.

## As built

Rules and data (lanes STEP70 and A):

- **STEP70 carries no DEDGE logic** (D-261128-080). OP_VERSION 70 and SNAPSHOT_VERSION 53 are identity steps, named OPPORTUNITY_OP_VERSION and OPPORTUNITY_SNAPSHOT_VERSION, and the op step's comment says op 70 also carries DEDGE's whole-squares walk when the two ship together.
- **`turnReach`** is exported as the whole turn's scan, each leg skipping the creatures earlier legs left, which DRAG-EQUALS-CARD compares with (D-261128-081).
- **The extra-Reactions trait** is read at the leg's snapshot and rides on `Reactor.extra` and `ReachLeave.extra`, so `rowStands` keeps a Hydra's row with no chunks to read. `chunksNeeded` asks for the SRD blocks whenever a creature the scan could name links one (D-261128-082, 083).
- **`reachInput`'s leg ids** are each leg's end stop index, and the leg jobs map them to occurrences through `reconcileLegs` (D-261128-084).
- **`reconcileLegs`** is an alignment over the last update's leaves that keeps the most leaves less the new joins it needs, not a greedy match of the listed rewrites, which read an Undo of a join as a join on a walk back and forth over the same squares. A join gets a new id and holds its two records as `parts` (D-261128-085).
- **Hex corners**: walls along hex sides end on corners rounded to the 1/64 lattice, so a wall end on a hex corner meets a gate line where the line passes the corner's true vertex, the middle of the three hexes' centers. Every other end is exact (D-261128-086).
- **Which legs provoke** is the stored marks alone: not uncounted, not carried. The reducer stores a resize or a squeeze in place as uncounted (D-261128-087). A line that runs along a wall is stopped, on squares and along a hex side (D-261128-088).
- **The Ogre's cases**: the SRD 5.2.1 Ogre's Greatclub reaches 5 ft, so the tests use a room monster with a 10 ft reach and the SRD Air Elemental.

The work on hexes (D-261128-099, D-261128-090):

- The phone benchmark missed the 8 ms slice on hexes on a fresh page: the first hex walks ran cold at about four times their warm cost, and building every creature's box on hexes (`occupiedHexes`) went uncounted. So a box built on hexes counts `HEX_BOX_UNITS`, 500 units, and SLICE_WORK stays 20,000.
- A creature's box, and a spot's, is built only where the two come near each other, and creatures are bucketed by their drawn square grown by the one cell their hexes reach past it, which costs no hexes to find. So a creature the walk never comes near costs no work, as BOUND asks. The walk on hexes starts a slice of its own, and a spot that first comes near many creatures builds their boxes over several slices.
- Quiet runs at 6x throttle and 390 x 844, five on hexes and three for the others, gave these slowest slices, on a fresh page and again warm:

  | Fixture | Cold | Warm |
  | --- | --- | --- |
  | 200 creatures, hexes | 5.3 to 7.0 ms | 2.1 to 3.2 ms |
  | 200 creatures, squares | 5.8 to 6.6 ms | 1.7 to 2.7 ms |
  | 30 goblins | 3.1 to 4.2 ms | 1.4 to 1.6 ms |

  Drag medians stay under 2 ms. A drag among the 200 creatures on hexes passes DRAG_WORK and says "Opportunity Attacks are checked after the drop."
- The benchmark runs the app's own bundle of the drag's scan and the leg jobs in a bare page, so it times exactly those, and it skips under CI.

Client (lane C):

- **A row leaves by the server's copy** (D-261128-091). The client's view takes a sent op in at once, so a row read from it left before its Reaction used could show busy. The jobs' `rowStands` and the row's mark read the confirmed copy, so the row stays, its button busy, until the server takes the press, on every device.
- **The drag's part gate** rides the jobs' slot (`TurnLeaves.on`, written by `useTurnReach`), whose `noticesOn` is the one gate: the part shown, the room's switch on, and no table display. movement/stageHooks.ts carries the reach context into `walkPreview`, sets and clears the rings, and remembers what a drop's line named.
- **Each job scans its leg with no creature skipped, as if it provokes**, and the turn takes each creature's first leave from a leg that provokes. So "Doesn't count" on a leg hands a creature's row to its next leave, and pressing it back brings the rows back with no rescan.
- A drop that falls through an opening shows no leaves line, since its leg folds away (section 2).
- The toast's turn key is the encounter's turn, not the movers present, so an Undo of a mover's only leg never resets what was toasted.
- Simple's help words stay as they were, the notices counted among "turns". A row names its creature's extra-Reactions trait whenever its block grants one ("Hydra: Reactive Heads"). The block shows for a creature with rows, or with a leg past the hard cap, and "Checking the walk…" shows only in a block that stands anyway.

## Round 1 changes

- DOA-SOL-01, DOA-OPUS-02: section 4 (distance first, gates, joints, `pieceTouches`), section 8 cases, D-056.
- DOA-SOL-02: sections 2 and 4 (Blinded needs Blindsight), cases, D-058.
- DOA-SOL-03: sections 2 and 4 (distinct reaches, `reaches` in the rolls table), cases, D-054.
- DOA-SOL-04, DOA-OPUS-09 (a) to (d): section 1 (the toast's rules), store.ts `shownLeaves`, cases, D-060.
- DOA-SOL-05, DOA-OPUS-15: section 5 rewritten, the benchmark in lane C1, D-065.
- DOA-OPUS-01: sections 1 and 4 (state at the leg, `rowStands`), LATER-ONLY-REMOVES, D-057.
- DOA-OPUS-03: section 4 (adjacency is 5 ft), cases.
- DOA-OPUS-04: sections 1 and 4 (`srdNeeds`, the toast waits).
- DOA-OPUS-05: sections 4 and 10 (the part in C1, the gate files in C2).
- DOA-OPUS-06: section 4 (one step with DEDGE), lane B, D-062.
- DOA-OPUS-07: sections 1 and 2 (own turn only), D-052.
- DOA-OPUS-08: section 2 (the rogue's toasts), D-059.
- DOA-OPUS-10: section 1 (every section, any viewer holding the block).
- DOA-OPUS-11: sections 1 and 4 (`extraReactions`), D-053.
- DOA-OPUS-12: section 1 (player wording "5 ft"), D-055.
- DOA-OPUS-13: section 4 (fed by `pathNow`).
- DOA-OPUS-14: section 1 (answerer gate on the line), D-051.
- DOA-OPUS-16: section 1 (a new row re-shows a dismissed card), D-060.
- DOA-OPUS-17: sections 1 and 6 (44 px, busy, focus).
- DOA-OPUS-18: section 10 (FEATURES.md places).
- DOA-OPUS-19: section 9 (`projectState`, the reducer test's model).
- DOA-OPUS-20: D-261128-050 to 069 appended to the decisions log.
- DOA-OPUS-21: section 8 cases.

## Round 2 changes

- DOA-SOL-06 = DOA-OPUS-R2-02: section 4 (Leg jobs wait for chunks, `Chunks` passed into `reachInput`, `chunksNeeded`), section 1, cases, D-057.
- DOA-SOL-07 = DOA-OPUS-R2-04 with R2-03: section 4 (Leg jobs: snapshot, queue, cancel rules, `legKey` (replaced by occurrence ids in round 3), joins), section 5, cases, JOIN-UNION and the jobs test, D-057.
- DOA-OPUS-R2-01: section 4 (the two-sided point rule), cases with hex vertices, D-056.
- DOA-SOL-08: section 4 (a neighbor is `feetPerCell`), cases on 10 ft squares and hexes, D-056.
- DOA-OPUS-R2-05: section 10 (C1 gains the Features page files and the PENDING entry), D-063.
- DOA-OPUS-R2-06: section 4 and section 10 (lane STEP70 on main, B shrinks), D-062.
- DOA-OPUS-R2-07: section 4 (`pieceTouches` only for a player's held pieces), cases.
- DOA-OPUS-R2-08: sections 1 and 4 (the shown set), cases, D-060.
- Wording: section 1 ("Goblin 2 (5 ft counted)"), D-055.

## Round 3 changes

- DOA-OPUS-R3-01 with DOA-SOL-09: section 4 (occurrence ids, `LegRecord`, `reconcileLegs`, the Occurrences bullet), the reconcile test and its invariants, cases, D-057.
- DOA-SOL-10: section 4 (Joins keep their parts' jobs), cases, D-057.
- DOA-SOL-11: section 1 (a reload shows a dismissed card again, the guarantee dropped), the reload case, D-060.
- DOA-OPUS-R3-02: section 4 (the drag waits for earlier jobs), a case, D-060.
- DOA-OPUS-R3-03: section 4 and section 10 (the deploying stack writes the bullet, STEP70 never alone, apart deploys step again), D-062.
