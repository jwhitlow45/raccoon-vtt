# raccoon-vtt design: movement and walls

Status: draft 3, 2026-10-18, after design review rounds 1 and 2 (items M1 to M20), under the shared public determinism rule (contract section 5). The project owner chose "Movement and walls" (docs/features.md section 4, Later: "Ruler counts difficult terrain from the map builder" and "True walking distance around walls") as one of three "Later" items to design next, with "Attached tokens" (docs/design-v1-attach.md) and "Triggers and traps" (docs/design-v1-traps.md). All three change what a move is, so they share one contract for describing a move: its route, its cost and the tokens it carries. This note owns the route, the cost and the size helper. Section 6 gives the parts the other two notes build on. The owner's answers are in section 14.

## 1. Summary

- **A drop walks.** A token dropped beyond a wall, a closed door or a ledge walks the cheapest way there that its creature could walk, around the wall, through an open door or up the stairs, instead of stopping at the wall. The drag shows that way as it goes, and the drop records it on the turn's trail.
- **Difficult terrain costs double.** Painted Difficult terrain and Rubble, a new "Difficult ground" mark that paints over a map image, areas such as Web and Spike Growth, other creatures' spaces and narrow openings a big creature squeezes through all cost 1 extra foot per foot, as SRD 5.2.1 says. Water costs the same for a creature without a Swim Speed, and so does crawling while Prone. Spirit Guardians halves the creature's Speed while it is inside, which is not a cost.
- **The budget reads the cost.** The movement marker says "Moved 25 ft, used 35 ft" when terrain cost more than the distance, and the speed colors, "15 ft left" and Dash read the cost against the Speed the creature has where it stands.
- **The ruler can walk.** A new "Walking" choice on the ruler measures the walk between its stops for the creature it starts on. "Straight" stays the default for range.
- **The public world.** Every route is chosen from what all players can see: unfound secret doors as walls, creatures, areas and conditions players receive, and no Speeds, and on ground the party has seen, except a DM's drag of a token with no party or player-owned member, which may cross ground under the fog. Private facts, such as a Swim Speed, change only the cost written, which only the DM and owners read. So everything players observe of a move is the same whatever the DM hides.
- **Diagonals stay as the room counts them.** Every diagonal 5 ft, 5-10-5 with its count running across the turn, and true distance all work as today on open ground.
- **Fast enough on a phone.** A prototype on the real leg test finds a Medium creature's every route within a Dash in about 1.5 ms on a development laptop and 6 ms on its efficiency cores, and floods a whole 200 x 200 dungeon in 75 ms and 244 ms. Open ground needs no search at all.

## 2. Today

- A leg is one straight line between two stops (design 9.2, `shared/rules/path.ts`). Its feet are the steps of the snapped top-left corner under the room's rule, with the change of elevation as vertical steps (`client/features/measure/movement.ts` `movedFeet`). A full path of 50 stops joins its oldest corner's two legs into one straight leg (`withStop`).
- On a scene with `blockMovement` a player's straight leg is refused when its core touches a wall, a closed door, a window, a pillar or a ledge (design 9.8, `legStop`). The client lands the token at the last clear spot with "Stopped at a wall. Drop at the corner first, then go on." (design 14.13). The DM is never stopped. A player's redo of a move is tested as one straight leg between its ends (`restorePoseCheck`, shared/permissions.ts).
- The builder paints `difficult`, `rubble` and `water` terrain, and nothing reads them but the textures. A cell holds one terrain, so painting Difficult over a map image covers the art.
- The ruler measures straight, edge to edge, with heights (docs/design-v1-heights-readout.md 3). `dragMove` frames have an optional `path` that nothing draws.

## 3. What the table sees and does

### 3.1 Dragging a token

- **Phone and computer alike.** A drag of one token draws its line from where the drag began. On open ground with nothing that costs extra it is the straight dashed line of today. When a wall, a door or a ledge is in the way, or a straighter way costs more, the line bends along the route the creature would walk, with a small dot at each corner, in the speed band's color. The token preview follows the finger to where it would land, and stops holding at the wall for a player whenever a route exists.
- **The label** at the line's end reads the leg's cost, "35 ft", with a second line naming what cost extra, "+10 ft for difficult terrain", "+15 ft for difficult terrain and swimming". The band words stay ("5 ft left", "10 ft past Dash"), and "Half Speed in Spirit Guardians" joins them while the creature would stand in it. A drag that would end in another creature's space adds "Ends in Goblin 2's space" (amber), since the rules say a creature can't willingly end its move there. Nothing stops the drop.
- **Searching.** A route that takes longer than about 200 ms to find shows "Finding the way…" on the label, with the line grey and straight, through the shared loading indicator. A drop made while it searches waits at the ghost with "Finding the way…" and then lands, so a drop never jumps somewhere unexpected and never looks hung.
- **The drop** lands at the finger's spot and sends one `token.move` with its route. One drop is one leg, so "Undo move" and Ctrl+Z take the whole walk back in one step, redo walks it again (7.4), and "Doesn't count" marks the whole walk.
- **No way there.** For a player on a scene that blocks moves, when no route reaches the spot on ground the party has seen (5.5), the preview holds at the last clear spot as today. The note says "Stopped at a wall. There is no way around it that you have seen.", "Ledge in the way. No stairs you have seen lead there.", or, where they see a door, "A door is in the way. Tap it to open.", and "Teleport here" works as today. The DM's drop with no route goes straight, as today.
- **A different way.** A drop says where, not how. A player who wants to wade through the rubble rather than around it drops in the rubble first, and the next drop goes on from there.
- **Arrow keys** (design 14.17) move one square and are never searched round a wall: a press into a wall stops there as today, and a press into rubble costs 10 ft. This changed in review, the coordinator's call (MV-O-12): the note first had a press as a drop on the square beyond, searched like a drag. No new keys, so the shortcut sheet does not change. **Group drags** stay straight legs (section 11).

### 3.2 The trail and the movement marker

- The active creature's trail draws each leg through its corners, dashed, faint for a leg that does not count, with dots only at stops. A walk around a pillar reads as the bend it was.
- To the DM and the creature's owners the marker reads "Moved 25 ft, used 35 ft" when the turn's cost differs from its distance, and "Moved 25 ft" otherwise, with what is left of each speed. "Moved" is the length of the counted legs and "used" their cost, both as stored when walked (6.2).
- Players who do not own the creature see only "Moved", as today, and see a leg's bends only when they saw every spot of it (7.3). Their feet always come from the stops and corners they received, never from a stored total.

### 3.3 The ruler's walking mode

- The ruler's options gain one chip, "Measure", with "Straight" and "Walking". Straight is the default and measures as today. The choice is remembered on the device (local storage, read and written in try and catch, falling back to Straight).
- Walking measures the walk through every stop for one creature: the token the ruler starts on, or a Medium creature on the ground when it starts on empty ground. Each later stop is where that creature would stand if dragged there. Each leg draws its route and reads its cost, and the total reads "Walking 40 ft", with "+10 ft for difficult terrain" under it when terrain added any. A leg with no route draws in red with "No way through".
- Each leg is the drag to its stop, worked out by the board's own drag code from where the legs before it left the creature: searched in the drag's world, its creatures in tow and their extra foot included, planned by the drop's own planner (a route the drop would not take goes as the straight leg, which counts what it walks over, and a walk held at a wall or cut where a creature it drags is stopped ends there), and read by the drag's own label. Its move is then applied to the device's copy by the room's own reducer, so the next leg starts in the room it leaves: its group moved, its links checked, its areas carried along and who sees it judged where it now stands. So a ruler reads, leg by leg, what the drags it stands for read.
- A walking ruler leaves out other creatures' spaces, since they will move before anyone walks there, and Speed changes, since a ruler has no turn. Having no turn, it pays no dismount's half Speed either (attach note 7.3). It counts walls, doors, ledges, terrain, marks, areas that cost and the extra foot for dragging or carrying a creature.
- Shared and kept walking rulers carry the choice (`walk`). A shared walking ruler uses seen ground and the rest of the public world (5.5) on every device, whatever token it starts on, the DM's device included, and walks as a player's drag does, held at a wall, so all read the same walk. It sees no token players did not see where it starts, wherever its legs would take it, since a player's copy never holds one, and a token one of its legs moves is seen or not where that leg leaves it. Only the DM's own ruler, before the DM shares it, may use everything the DM knows, and it walks as the DM's drop does, through walls.

### 3.4 The builder: difficult ground

- **Terrain that counts.** Difficult and Rubble are difficult terrain. Water costs 1 extra foot per foot for a creature without a Swim Speed. Stairs, pits and floors cost nothing extra. A route never passes through a Pit square for a walker, though a drop into one still lands there. Pillars block, as today.
- **A new mark, "Difficult ground."** A new builder mode paints difficult ground over whatever is under it, floor or map art, without changing the cell's terrain, as the Stairs brush marks stairs. Brush of 1 to 3 squares or a dragged Area, "Mark" or "Clear". The mark draws as a thin diagonal hatch in a muted ochre at 45% opacity, on the board layer above the floor and under stamps. Players see it where they see the map. Erase and Clear take marks as they take heights. The mode's hint reads "Difficult ground costs double to walk through. It paints over the map without hiding it."
- The terrain chip's hint gains "Difficult and Rubble cost double to walk through. Water costs double without a swim speed."
- Undo reads "marking 12 squares as difficult ground on the scene Crypt" and "clearing difficult ground from 12 squares on the scene Crypt".

### 3.5 Areas that slow movement

- An area's pane (the DM's and its owner's) gains "Movement inside": Normal, Difficult terrain, Half Speed, 4 ft per foot, and a switch "Only the caster's enemies", shown when the area has a caster.
- Difficult terrain is one extra foot per foot, as any other source. 4 ft per foot is Plant Growth's "spend 4 feet of movement for every 1 foot". Half Speed is Spirit Guardians' "Speed is halved in the Emanation" (4.2). "Only the caster's enemies" leaves out the caster and creatures of its disposition, standing in for "your enemies" and "you can designate creatures to be unaffected". Where players cannot see the caster, their copy of the area has none (`projectTemplateCtx`), so a route reads it as slowing everyone, on every device.
- **The SRD presets**, checked both ways: Difficult terrain for Black Tentacles, Earthquake, Entangle, Grease, Ice Storm, Insect Plague, Sleet Storm, Spike Growth and Web, Difficult terrain for the caster's enemies for Conjure Minor Elementals, 4 ft per foot for Plant Growth, Half Speed for the caster's enemies for Spirit Guardians. The SRD import's hand-read table (`AREA_REVIEW`) carries `slows` for each, and its test checks both ways: every area spell whose text says "Difficult Terrain", "Speed is halved" or "feet of movement for every 1 foot" has `slows` or a reason it does not. The reasons: Gust of Wind (only moving closer to the caster), Slow (a condition on chosen targets, not the area), Speak with Plants (the caster's choice to make or clear it).

## 4. The rules

### 4.1 What costs extra

SRD 5.2.1, Rules Glossary, "Difficult Terrain": "If a space is Difficult Terrain, every foot of movement in that space costs 1 extra foot... Difficult Terrain isn't cumulative; either a space is Difficult Terrain or it isn't. A space is Difficult Terrain if the space contains any of the following or something similar:"

> - A creature that isn't Tiny or your ally
> - Furniture that is sized for creatures of your size or larger
> - Heavy snow, ice, rubble, or undergrowth
> - Liquid that's between shin- and waist-deep
> - A narrow opening sized for a creature one size smaller than you
> - A slope of 20 degrees or more

"Playing on a Grid": "A square of Difficult Terrain costs 2 squares to enter." "Swimming" and "Crawling": "each foot of movement costs 1 extra foot (2 extra feet in Difficult Terrain)", swimming's ignored "if you have a Swim Speed and use it to swim". Prone: "Your only movement options are to crawl". Grappled (attach's note): the grappler's "every foot of movement costs it 1 extra foot unless you are Tiny or two or more sizes smaller than it." Plant Growth: "A creature moving through that area must spend 4 feet of movement for every 1 foot it moves."

A step's extra feet per foot is the sum below. Plant Growth over difficult terrain costs the larger only, 4 ft per foot: the SRD does not settle it, and that is the project owner's chosen reading (section 14).

| Source | Extra |
| --- | --- |
| Ground: difficult terrain from any source (Difficult or Rubble, the mark, an area marked Difficult terrain, another creature's space, a narrow opening), or 4 ft per foot inside Plant Growth | 1 for difficult terrain, 3 inside Plant Growth, the larger only, never summed |
| Swimming (water, on the ground) or crawling (Prone, not hidden from players) | 1, the swimming foot taken off again by the reducer for a creature with a Swim Speed (6.2) |
| Dragging (attach's `dragExtra`) | 1 |

- **Entry accounting on a continuous footprint** (M3). The footprint at a lattice spot is the rectangle at its stored position, `[x, x + w)` by `[y, y + h)`, never the snapped `footprintRect`, and the squeezed footprint while squeezed. A step's newly covered region is its end rectangle minus its start rectangle. The step pays a ground source's extra when that region overlaps the source's inside: a difficult or water square, a marked square, a square an area covers on the ground, or another creature's rectangle where their heights overlap. So a Large creature's two half steps across one square of rubble pay half each, as one whole step pays once, and leaving rubble pays nothing.
- **Per step, not by entry:** squeezing pays on every step that ends squeezed (4.5), and crawling and dragging on every step.
- **Furniture** has no data: the DM marks difficult ground under it. **Steep stairs** the same way: a cell can carry a stair mark and the mark together. **Shallow water** is Water, and a table that wants wading for everyone marks it difficult too.
- **Climbing** stays the table's: a walker cannot cross a ledge on a scene that blocks moves, so a route takes the stairs. **Teleporting** costs nothing and walks no route.

### 4.2 Speed changes (M2)

SRD 5.2.1, "Speed": "Whenever you switch [speeds], subtract the distance already moved from the new speed. The result determines how much farther you can move." "Changes to Your Speeds. ... if your Speed is halved and you have a Fly Speed, your Fly Speed is also halved." Spirit Guardians: "Any other creature's Speed is halved in the Emanation". "Round Down": "Whenever you divide or multiply a number in the game, round down if you end up with a fraction, even if the fraction is one-half or greater."

- A Speed change is a change of the creature's Speed, not of what its steps cost. So the turn keeps one total of movement used (the costs of 4.1), and what is left is always the Speed the creature has where it stands now, less that total, as the switching rule reads a new Speed.
- Inside a Half Speed area that affects it, by the area rules' creature test (`creaturesInArea`, design 9.3, in three dimensions), every speed of the creature is halved, once however many such areas overlap. Leaving it gives the full Speed back, less what was used. Dash adds the Speed the creature has where it stands.
- **During a drag** the band is judged at every spot of the leg in turn: green while the movement used so far is within the Speed at each spot, yellow while within twice it, red once either fails. So with a 30 ft Speed, walking 10 ft outside Spirit Guardians and 10 ft inside reads yellow from the second step inside (20 ft used against 15): that walk needs a Dash, and the leg stays yellow after it leaves, as its worst spot did. After the move the marker reads what is left where the creature stands: 10 ft once it is out, 10 ft left with Dash while it is inside.
- Plant Growth stays a cost (4.1). Spirit Guardians and Plant Growth together halve the Speed and charge 4 ft per foot.
- A halved Speed rounds down, so 25 ft halves to 12 ft, in what is left, in Dash and in every band. Speed changes are read on the client, by the DM and owners, who receive speeds, and are never stored.

### 4.3 Creatures in the way

SRD 5.2.1, "Moving around Other Creatures": "you can pass through the space of an ally, a creature that has the Incapacitated condition, a Tiny creature, or a creature that is two sizes larger or smaller than you. Another creature's space is Difficult Terrain for you unless that creature is Tiny or your ally."

- A creature here is a token of kind `pc`, `npc` or `monster` on the scene, not dead, whose vertical extent overlaps the mover's, judged from players' copy of it. The mover's own attached group (attach's `carriedGroup`) is never in its way.
- **Allies** are creatures of the mover's disposition, two `neutral` creatures included. An ally's space and a Tiny creature's cost nothing.
- **Any other creature's space** is difficult terrain. A route never passes through one the mover cannot pass: not Incapacitated by an effect players receive (the condition, or Paralyzed, Petrified, Stunned or Unconscious) and less than two sizes apart by `sizeCategory` (4.5). Dead means dead as players' copy of it shows. A creature's HP and life the DM keeps from players never shape a route.
- Only creatures players can see count (5.5). Ending in a creature's space is a label warning, never a stop.

### 4.4 Walls, doors, ledges and corners

- A route's every step passes today's leg test (design 9.8): walls, closed and locked doors, windows, pillars and secret doors not yet found block, ledges block a walker unless a stair connects them, and a flier below the ledge's top. So no route ever crosses what a straight drop could not.
- **An unfound secret door is a wall to every device's route** (the owner's answer, section 14), the DM's included. A DM walking a monster through a secret passage drops at the door first, and the walk through it goes straight, as the DM's drops do today.
- "Corners. Diagonal movement can't cross the corner of a wall, a large tree, or another terrain feature that fills its space." The leg test refuses a diagonal through a grid point where a wall ends, since touching counts. **A deviation from that rule** (M9): pillar squares are inset 9/64 square, so a diagonal step past a pillar's corner is allowed, as a drag is today. Keeping one inset for drags, routes and sight is worth the small difference.
- **Routes go around walls only on scenes that block moves** (`blockMovement`, on for every scene the client makes). With it off nothing is in the way, as today, and only terrain shapes a route.

### 4.5 Sizes and squeezing

- **`sizeCategory(token)`** (M10, shared/rules/footprint.ts, used by traps and offered to attach): a standard size is itself. A custom size is the smallest standard size whose square holds its footprint: longer side at most 0.5 square Tiny, at most 1 Medium, at most 2 Large, at most 3 Huge, more Gargantuan. Custom never reads as Small, since Small and Medium share a square. The longer side, because a creature's size is the space it controls ("the area that it effectively controls in combat") and a 1 by 3 creature controls a run of 3 squares. `sizeSteps(a, b)` is how many sizes apart two creatures are.
- A route moves the footprint's top-left corner on a lattice from where the token stands: whole squares for Small and Medium, half squares for Tiny, and half squares for any creature that can squeeze (a side of 2 squares or more). On whole squares a Large creature's core always straddles a 5 ft door's frame, and the prototype's Large creature never left its room.
- A step's cost is its length on that lattice, so a half step is half a step. A leg's cost rounds up to the token's own step (5 ft at 5 ft per square, 2.5 ft for Tiny), so lining up with a door never reads as 2.5 ft.
- **Squeezing** (M9). A step that ends where the squeeze rule finds a real narrow space (`pinches`, as `squeezedThere` applies it: a blocker on each side of the core inside the full footprint) pays 1 extra as difficult terrain. A creature beside one wall is not squeezing. A Large creature walking a 5 ft corridor pays double the whole way. A drop that ends in the corridor squeezes there as today (`landing`).

### 4.6 Flying, heights and the ground

- A token on the ground at the leg's start walks: its elevation along the route is the ground under its footprint at each spot (`footprintGround`), so a route up a stair climbs it, and each piece's change of height counts as vertical steps under the room's rule, as a straight leg's does today.
- A flier keeps its elevation along the route and lands as a drop does. Ground sources cost it nothing. Creature spaces still count where heights overlap, and Speed changes by the area's three-dimensional test. Ledges stop it as today.
- A token inside the ground is stopped only by walls, and nothing costs it extra. A change of elevation alone stays its own straight leg, with no route.

### 4.7 Diagonals (M4)

- **Every diagonal 5 ft:** each step costs one step, diagonal or not.
- **5-10-5:** the counts of diagonals run on from the turn's earlier counted legs into the route (the search starting from the public counters of 5.5, the written cost from the true ones), horizontal and vertical as `legFeet` keeps them, every second diagonal costing double, and a difficult diagonal costing double of whatever it costs, so a 10 ft diagonal into rubble costs 20 ft. The search and `routeFeet` keep both counters in exact whole units of half a foot, so no float drift moves a floor. The horizontal counter grows by half squares on the half lattice, so its residue mod 2 squares takes four values. The vertical one grows by `min(horizontal, rise)` where the ground changes, and heights are whole feet, so its residue takes up to `4 * feetPerCell` values (a 1 ft rise on 5 ft squares adds 0.2 square). The search carries every residue it reaches, the vertical one only where heights change, so it finds the cheapest route exactly.
- **True distance:** the search uses diagonals of √2 steps, then pulls the route taut (5.4), each piece costing its straight length, the leg rounded to the nearest foot, as today.
- On open ground with nothing extra the straight leg is the cheapest under every rule, so its feet are exactly today's.

### 4.8 The cheapest route

A leg takes the cheapest route to where it was dropped, ties broken by fewer corners, then by the shorter straight-line length. So a drop past a patch of rubble walks around it when around is cheaper (the owner's answer).

## 5. Finding a route

`shared/rules/walk.ts`, pure and shared, called by the client only. The server never searches: it checks the route the op carries.

### 5.1 The lattice and the step test

- Nodes are lattice spots whose footprint lies inside the scene, plus the counter residues of 4.7 under 5-10-5. A step goes to one of the 8 neighbors.
- A step is allowed when today's straight leg test passes between the two spots (`legClear`'s straight part: the half lattice holds the shifted spots itself), and the end spot is neither a pit for a walker nor in a creature's space the mover cannot pass.
- Step answers are cached in typed arrays by node and direction, kept across drags while the wall set (by identity, design 9.7), the core size and the ledge floor class stay the same.
- Each step's extra comes from per-drag grids built once (difficult and water squares, marks, pits, and creature rectangles from the up to 500 tokens), plus the few costing areas whose box reaches the step.

### 5.2 The search

- **Open ground first.** When the straight leg is allowed, nothing along it costs extra and the ground under it is level or rises evenly (4.6), it is the route and nothing is searched. That is most drags.
- **Otherwise a uniform-cost search from the drag's start** (Dijkstra, a binary heap), grown on demand: when the finger enters a new spot the search runs until that spot is settled, then traces it back. The start is fixed for the drag, so one search serves every spot the finger visits.
- **Time slices.** One scheduler owns all the route work on the board: the drag's aims, every walking ruler's legs, the open-ground checks and the arrow keys' presses. It gives a frame 4 ms of work, one budget that all of them share, and once it is spent nothing else runs until the next frame. A frame is what the browser paints at once: the events since the last animation callback, then the next callback's own work. The frame's first work opens its budget, the callback goes on with it, and the callback's end closes it. So a frame's events and its callback share one budget however the events fall, and a budget one callback left over never passes to the next frame (review ASTRA-14). Work that sets off more work inside it counts as one run, timed from its start to its end (review ASTRA-17). The drag and the presses go first, then the rulers, each in turn, starting each frame with the one after the last that ran. The scheduler remembers that one by the work itself, not by its place in the list, so work that ends or is dropped during a turn never costs another its turn (review MV-O-25). Only the frame's own first work is sure to get on, so a frame runs past its 4 ms by at most one step that cannot stop partway: a world's build, a leg test, or one straight leg checked whole. A drop still waiting when a new drag starts is the one exception (As built). **Cap:** 200,000 settled nodes in one drag, never a time, so every device finds the same route. Past it the drag acts as if no route existed, with "Too far to work out a way around" as the note's first sentence.
- **Pieces.** The traced route becomes straight pieces, split wherever the direction, the extra, `swim` or the ground's height changes. A route over 300 squares of reach is treated as no route, and the drop goes without one (section 10). On a scene that stops moves, the client also checks every route it would send by the server's own rule, piece by piece: both sides call `routeStop` in `shared/rules/route.ts`, the server from `routeCheck` in `shared/permissions.ts`. A route with a piece that fails is treated as no route too, and the drop goes as the plain straight leg, which the server takes. The failing piece is never split into its lattice steps, since a split can change what the walk costs: each piece's feet round up to the creature's step (review MV-O-28). In each of these cases the drag's line and label draw the straight drop, and they end where it lands, held at the wall or snapped, not at the spot under the pointer. So they never read a walk the drop would not take (review MV-O-24). The label and the cost the drag's frames carry read the landing as the move records it: at the height it lands at, and squeezed where it squeezes (`plainLegCost` in `shared/rules/route.ts`, review ASTRA-18). Past 64 pieces the client cuts the route and the drop lands there with "Stopped partway: the way there turns too often for one move. Drag again to go on."

### 5.3 Ties

The search orders by cost, then corners, then straight-line length, so among equal routes it draws the one with fewest bends, closest to straight, and a walk around one pillar never zigzags.

### 5.4 True distance pulled taut

From each corner the piece runs to the farthest later spot reachable by an allowed straight leg along which every spot pays the same public extra. So a walk around a wall corner reads its true length, and a walk across a rubble patch has corners where the rubble starts and ends.

### 5.5 The public world (contract section 5)

Everything players observe of a move (the landing, the route's bends, drag frames, refusals, the spots traps and area reminders judge) must be a function of the op and what players can see, the same whatever the DM hides. So every route search, on every device and for every token, chooses in the **public world**:

- **Ground:** on a player's device, whatever token it moves (`playersMoveAny` included), and on the DM's device for a group with a party member or a player-owned token (the mover counts), only squares players have seen (`seenGround`, docs/design-v1-heights-readout.md 1: not fully under the merged fog, explored ground counting as seen), terrain and marks read only there. The DM's device reads it from the fog, explored and sight tiles it holds. For any other group the DM's search uses the DM's view of the ground, fog ignored (the owner's round 1 answer). Its geometry reaches other players only where they saw every spot (`routeSeen`, 7.2), and its drag frames carry no `path` on fog and vision scenes, as today.
- **Walls:** the movement set as players see it, so an unfound secret door is a wall on every device (the owner's answer, section 14).
- **Creatures:** only those players can see where they stand, as players' copy shows them (disposition, size, height, effects players receive). A token the DM hid never counts, and on the DM's device neither does one the projection withholds (`withheldWhereItStands`, shared/project.ts).
- **Areas:** as a player who owns none of them receives them (`projectTemplateCtx`): not DM-only, not attached to a token players cannot see, `playersSeeAoeOfOthers` on or owned by a DM, and without a caster where players cannot see it.
- **Conditions:** Prone only where players receive it. **Speeds:** none. Water always costs its swimming foot in the search, and a Swim Speed comes off only in the written cost (6.2).
- **Groups: public members** (contract section 5, attach 8.0): a group's members and links every player sees, the mover included. Anything another viewer can observe of a group's move (the sampling step, the route, which members walk and stand, the extras, trap stops) uses them and nothing else. The **check set** is the public members plus the tokens the op names. Refusals and limits read the check set (7.1, 7.4): a refusal's words are private, but every viewer misses the op it stops, so it must not depend on what they cannot see. Members outside the public members, a player's own token the DM hid from the others included, walk in the private pass on their own step, a `drag` token stopping unseen where its own wall test stops it (7.1), and never change a visible member's route, stop or spots.
- **History:** under 5-10-5 the search starts from the **public counters**: the diagonals of this turn's earlier counted legs that players who do not own the creature saw whole (7.3), read from their geometry. So which diagonal of a new route costs 10 ft, and so its bends, never depend on a leg nobody but the owners saw. The cost written still uses the true counters (6.2).

**Traps and area reminders on a DM's route through unseen ground.** A monster the DM walks through unseen ground meets the traps and areas there, which is the world as it is. Players perceive only what reaches their projection, by those features' own rules, so this keeps the rule.

**Private accounting.** A cost written from private facts (a Swim Speed, attach's mount cost from half a rider's Speed) reaches only the DM and the creature's owners, whose copies hold those facts (7.3). Nothing private changes a route's geometry, its pieces, or `moved`.

### 5.6 Fallbacks

No route, a search past its caps, or a scene not yet loaded fall back to today's straight leg, its landing and its notes, and the DM's drop goes straight. A drop the server refuses (a door closed during the drag) says so as today's refusals do.

## 6. Data model and ops

The shared contract between the three notes: a move is described once, as its route (here), its cost (here) and the tokens it carries (attach), before and after dispatch (traps, `planMove(op, before, actor)` and `describeMove(op, before, after, actor)`, the actor deciding which ground the search may read, 5.5).

### 6.1 `token.move` carries its route

```ts
op("token.move", { ...moveFields, squeeze?, teleport?,
  route: z.array(z.tuple([coord, coord, z.number().int().min(0).max(7), z.union([z.literal(0), z.literal(1)])])).min(1).max(64).optional() })
// each piece's end in order, [x, y, extra, swim], the last at the op's x and y
```

- Straight pieces from where the token stands. Absent means one plain straight leg. The client sends a route only when the leg bends or costs extra. The protocol checks the shape and refuses it with `teleport`. `canApply` checks the rest (7.1).
- `extra` is the piece's public extra feet per foot (4.1), from the public world (5.5) alone, and `swim` is 1 when one of them is the swimming foot. Pieces split where the direction, `extra`, `swim` or the ground's height changes, all public, so the pieces are the same whatever the DM hides.
- Elevation is not in the op. It follows one fixed rule from the state before the op: a token on the ground at the start takes the ground under its footprint at each spot, any other keeps its elevation, and the last spot takes the op's landing elevation. attach's carried tokens follow its amendment.
- `token.moveMany` is unchanged: straight legs.
- **Spots** (for traps and area reminders): `routeSpots(build, route, token, step?)`, `build` being the scene and its chunks (`BuildState`, the leg test's own context), gives the spots the footprint passes from where the token stands, the start first, each with its elevation, `squeezed`, `stand` and `progress`. 8-direction pieces step exactly along their lattice, so every spot lies on its piece's segment. Other pieces (true distance pulled taut, a plain straight leg at any angle) step as `lastClearSpot` does, snapping spots off the segment. `stand` says the token may stop there: its core fits, squeezed only where `squeezeFits` holds, and the route cut at that spot is allowed. That last part is automatic only for a spot on the segment of a piece whose straight sweep is clear (every piece of a searched route). Any other spot runs the leg test on the cut piece: a snapped spot, and a spot of a plain straight leg the server allowed only by a shifted path, since a clear segment does not make a snapped prefix clear (a Medium token from (0, 0) to (2, 1) past a wall from (1.25, 1.25) to (1.75, 1.25) is clear, and its spot (1, 1) is not). The start is a `stand` by definition. `progress` is `[piece, k, n]`, step k of the piece's n.
- **Groups.** The caller passes one `step` for a group: the finest of its public members (5.5, members and links every player sees), half a square when one of them steps by halves, else 1. Each member outside that set takes `routeSpots` on its own offset route with its own step, in the private pass. Each public member's spots are the holder's spots on that step plus its offset, so every public member shares `n` and progress at every spot, and a spot off a member's own snap grid has no `stand`. A hidden member never changes the step, so a hidden Tiny passenger never moves a Medium holder's stop to a half square.

### 6.2 What a path stop adds (M6)

```ts
type PathStop = { ...today,
  via?: number[]            // display only: flat x, y of the corners between the stop before and this one
  moved?: number            // feet walked: the leg's length under the room's rule, no extras
  cost?: number             // feet taken off the creature's speed
  diag?: [number, number]   // the 5-10-5 diagonals the leg took, horizontal and vertical
  routeSeen?: true          // players who do not own the token saw every spot of the leg (7.2)
}
```

- **Accounting is apart from display.** For every leg an op at or above movement's op version records, the reducer writes `moved`, `cost` and `diag`, straight legs included, from the op's route (after the traps' stop step, which may cut it) with one pure function, `routeFeet(from, route, rules, counter)` in `shared/rules/route.ts`: the sum over pieces of `legFeet(dx, dy, dz)` for `moved`, and of `(1 + extra - swim * s)` times it for `cost`, where `s` is 1 when the creature's actor holds a Swim Speed (the private pass: the reducer reads the stored speeds, which only the DM and owners receive), the 5-10-5 counters running on in exact half-foot units, true distance rounded once per leg, other rules rounded up to the token's step. Elevations come from 6.1's rule, so a walk over `+5, -10, +5` ft of ground counts each rise. attach's mount and dismount legs write `cost` directly.
- **Readers** (`turnTrail`): "Moved" sums `moved` over counted legs, "used" sums `cost`, the next leg's counters start from the sum of `diag` over counted legs. A stop without them (an older op's) reads from geometry, as today.
- **"Doesn't count"** flips `uncounted` and changes nothing else: the readers' sums leave the leg out, its diagonals with it.
- **Joins** (`withStop`, a full path). At or above movement's op version, the joined leg's `moved`, `cost` and `diag` are the sums over its counted parts (all parts when none counted), a part without them first given them from its geometry with the counters at its place. `via` joins the two legs' corners with the one that goes, and `routeSeen` holds only when both legs and that corner had it. **Below that version `withStop` is exactly today's** (M5): the corner goes and nothing else changes.
- **The display cap.** A path keeps at most 100 corners: past that the oldest legs lose `via` and draw straight. Accounting never changes.
- **Carried legs** (attach's `carried`) never store `via`: the walk is the holder's, on the holder's path.
- **Below movement's op version** (M14) replay writes exactly today's stop shape: no `via`, `moved`, `cost`, `diag` or `routeSeen` on any stop, and today's join. So an older op's token, and its restore guard, come out bit for bit as before.

### 6.3 The Difficult ground mark

```ts
type BuildChunk = { ...today, rough?: string }   // 256 marks, row-major: '.' none, 'd' difficult ground. Absent when none
op("build.rough", { sceneId: id, cells: z.array(cellKey).min(1).max(MAX_BUILD_CELLS), on: z.boolean() })
```

DM only, like every build op. It touches no walls, so it bumps no walls version. Erase and Clear remove marks with the rest of a cell. A duplicate, the export and the import copy it as stored. Traps may paint it later (Collapsing Roof's rubble).

### 6.4 Areas

```ts
type AreaTemplate = { ...today, slows?: { kind: 'difficult' | 'halfSpeed' | 'quarter', foes?: true } }   // absent: Normal
```

Set from the SRD preset and in the pane by whoever may edit the area. `foes` without a caster affects everyone.

### 6.5 Frames, kept rulers and undo steps

- `dragMove`'s `path` carries the live route's corners (at most 64 under its 200-number cap), an empty one for a straight walk, and a new `ft` the leg's cost. The server judges the preview's footprint at the end of the walk those corners draw (docs/design-v1-attach.md 8.0). The server sends `ft` only to the DM and the token's owners, and strips `path` from players' frames on scenes with fog or vision on, as today.
- The `ruler` frame and a kept ruler gain `walk?: true`.
- An undo step of a routed move keeps the route (`UndoEntry.routes`, by token), and the `sys.restore` it builds for a redo carries it as `routes`, which only permissions read, as `teleport` today (7.4).

### 6.6 Versions

Movement takes its own op version and its own snapshot version, the next free pair at build time, and builds first of the three notes (the coordinator's order: movement, attach, traps). The snapshot step is an identity step, so an older build refuses a room that may hold `rough`, `slows`, `walk` or the new stop fields instead of loading them under old rules (shared/migrate.ts practice). Every field the reducer writes on its own (the stop fields of 6.2) is gated below the op version as `opVersion !== undefined && opVersion < N`, writing today's stop and join there. Fields that come only from new ops or new op fields (`rough`, `slows`, `walk`, `route`) need no gate: no older op carries them. If `routeFeet` or 6.1's elevation rule ever changes, the op version moves with it.

## 7. Server: permissions, reducer, projection, undo

### 7.1 Permissions

- **Every role:** each route point lies on the half-square lattice from the token's start (`(px - start.x) * 2` a whole number), its footprint inside the scene, consecutive points distinct, and the route at most 300 squares of reach in all (section 10). A bad route is refused `invalid`.
- **Players on a scene that blocks moves:** today's full leg test (`legBlocker`, with its shifts) on each piece, from the token at the piece's start with 6.1's elevation, for the check set: the tokens the op names and the `drag` tokens among the public members, each on the route offset by its place (attach 4.2). Any other `drag` token is tested in the private pass: it stops unseen where its own wall test stops it, and the link pass frees it if that leaves it out of reach (attach). So walls stay honest and no refusal depends on a token or link some player cannot see. The client chooses the landing and route with the same members (5.5), so a piece the client found by straight lattice steps always passes. The first stopped piece refuses the move with today's words. The DM's routes are not tested.

### 7.2 Reducer

On the active creature's turn, `withPath` writes the new stop with `via`, `moved`, `cost`, `diag` and `routeSeen`. **`routeSeen` is judged at every spot** of the leg (`routeSpots`, straight legs included, no exemption for a leg without corners). A party member's leg is always seen, since players are always shown it, and its route was chosen in the public world. For any other token a spot counts as seen when players who do not own it would see its footprint there (`inSightOfNonOwners` asked of the token at that spot) both in the state before the move and in the state after. That asks of a candidate position against the light sources and party sight of the state as it is, the token's own light included where it stands, so it reuses the party sight caches (`partySight` in vision.ts) and computes no polygon per spot. Sight at both ends of the move holds through it when nothing that lends sight moves, so a leg whose group carries a member that lends the party sight is never seen whole, and the rule only errs toward hiding. Outside the creature's turn a route writes nothing to a path. **Area reminders** (L3-ASTRA-29). Every leg keeps `alongLeg`'s sampling: every half cell along it, elevation interpolated, vertical walks and template movement included. A route is swept piece by piece that way, at today's half-square density, at most 664 samples for the whole op (section 10), so an op without a route sweeps exactly as today, and an older op replays as it did. Traps judge `routeSpots` instead (the contract's order).

### 7.3 Projection

- The DM and owners get every stop whole. Owners get the creature's path on its own turn even where the DM hid its row from them, so its drag's label counts on from the turn's earlier legs as the move stores the leg (review AT-HIDDENPATH).
- Other players never get `cost` or `diag`. They get a leg's `via` only when they saw both its ends, it is not `joinedUnseen`, and it has `routeSeen`: the leg is **seen whole**. **Published measurements** (contract section 5, L3-SOL-24): they never get `moved`. They read each leg's length from the stops and corners they received, as today, so no value shown to them depends on history they could not see. The 5-10-5 search starts from the public counters (5.5) for the same reason, since a route's bends are shown.
- Drag frames: `path` to players only on scenes with neither fog nor vision, as today, and `ft` only to the DM and the token's owners. The route a frame carries was chosen in the public world, so its bends are the same whatever the DM hides.
- The shared differential test holds both channels to it (section 12).

### 7.4 Undo and redo (M7)

- Undo is today's: the step puts the token back, path and all, and is never stopped by a wall, since it retraces a move that was allowed.
- A player's redo of a routed move runs the leg test on each piece of the kept route from where the token stands, instead of the straight chord, under the same rules as the move: on a scene that blocks moves, for the check set, as 7.1 says. A door closed or a wall built since stops it: "Could not redo moving Thorn: a wall is in the way." It never routes again. A door opened since changes nothing. A step merging two moves of one token keeps both routes in order.

## 8. Who may do what, and what stays hidden

- **The DM** paints Difficult ground, edits any area's "Movement inside", and routes every drop, never stopped.
- **Players** route their own drops and any they may move (`playersMoveAny`), checked piece by piece on scenes that block moves. They set "Movement inside" on areas they own.
- **Hidden things** (contract section 5): every route is chosen in the public world (5.5), so its landing, bends, spots and refusals are the same whatever the DM hides. A DM's drag of a token with no party or player-owned member may cross ground under the fog, and players other than its owners see its geometry only where they saw it. Private facts change only `cost` and `diag`, which reach only the DM and owners. A leg's bends reach players who do not own the creature only when they saw every spot, and they never get a stored length or cost. Drag frames lose their route on fog and vision scenes and their cost for everyone but the DM and owners. A shared walking ruler reads the same on every device.

## 9. Edge cases

- **A door closes during a drag.** The step cache follows the wall set, so the route changes on the next finger move. A drop already sent through the door is refused for a player, with today's words.
- **The build, the diagonal rule or the scale changes mid-turn.** Stored accounting stays as walked. Only older legs read from geometry.
- **A hidden monster in the corridor.** The player's route passes through its space at no cost, and the server never says otherwise. The DM rules at the table.
- **Entering Spirit Guardians mid-drag** turns the band yellow at the step where used passes the halved Speed, a 25 ft Speed reading 12 ft inside. Leaving it, the full Speed is back less what was used (4.2).
- **A hidden passenger** (a Tiny familiar the DM hid on a Medium holder) changes neither the holder's step, nor its route, nor where a trap stops it (6.1). It follows in the private pass.
- **Tiny creatures** step half squares at 2.5 ft and pay by entry (4.1). **Custom sizes** use the core rule, the half lattice with a side of 2 squares or more, and `sizeCategory`.
- **An unsnapped token** routes on the lattice from where it stands. **A drop on a squeeze spot** ends the route there and sets `squeeze`. **A flier landing on higher ground** rises on its last piece, which counts the rise.
- **A teleport or a scene change:** no route. **Prone:** crawling costs extra on every step. Standing up stays the table's.
- **Grappling** (attach): the holder's every step costs 1 more, and its dragged creatures are tested on the holder's route offset by their place.
- **A route over 64 pieces** is cut there. **A search over its caps** falls back (5.6). **Two players dragging one token** is today's last drop wins.

## 10. Performance on a phone

A prototype outside the repository ran the search on the real leg test (`legStop`) over a 200 x 200 dungeon of 20 x 20 rooms joined by open doors, a pillar and a patch of rubble in each, on a development laptop, and again on its efficiency cores (macOS background priority), which stand in for a phone's CPU. Phone timings are an estimate from that: a mid-range phone may be slower still.

| Search | Laptop | Efficiency cores | Settled |
| --- | --- | --- | --- |
| Medium, cost up to 12 squares (a 30 ft speed's Dash) | 1.5 ms | 5.7 ms | 504 |
| Medium, cost up to 30 squares | 9 ms | 17 ms | 2,879 |
| Medium, the whole scene | 75 ms | 244 ms | 39,900 |
| Large, half squares, cost up to 12 | 4 ms | 18 ms | 1,890 |
| Large, half squares, cost up to 30 | 20 ms | 65 ms | 10,987 |
| Large, half squares, to the next room through a 5 ft door | 11 ms | 29 ms | 4,523 |
| Large, whole squares | | | 357, never leaving its room |

- A route within a Dash takes one or two 4 ms slices on a slow CPU, and a whole-scene flood about 60 slices, during which the label says "Finding the way…". 5-10-5 multiplies the nodes by the counter residues reached: four horizontal ones on the half lattice, and vertical ones only where the ground's height changes (4.7). The half lattice is both needed and affordable for big creatures.
- The build adds `scripts/bench-route.ts` with these rows plus the densest wall build at the caps (design 9.7), a stair map with 1 ft and 3 ft rises under 5-10-5 for the vertical residues, the reducer's `routeSeen` on 1,000-spot legs of a lit monster on a dark vision scene at the sight caps, and a row run in headless Chromium at a 4x CPU throttle (`Emulation.setCPUThrottlingRate`). It gates on a Medium route within a Dash under 5 ms and a whole-scene flood under 150 ms on a development laptop, a Large route within 30 squares under 40 ms, and the throttled Dash row under 20 ms, each run alone.
- Render on change only: the route line redraws when the finger enters a new spot. The search state is dropped on drag end. **Per op, with routes** (D3): a route is at most 64 pieces and at most 300 squares of reach in all, a piece's reach being `alongLeg`'s own measure, `max(|dx|, |dy|, |dz| / feetPerCell)`, with its change of elevation by 6.1's rule and the last piece's landing elevation included (R5-OPUS-1). A longer route is refused `invalid`, and the client treats it as no route and sends the drop without one. So 64 pieces zig-zagging down a 300 ft drop at 1 ft squares count their fall and stay within the cap. So the server does at most 64 leg tests per walker it tests, `routeSpots` gives at most 664 spots per walker, `routeSeen` at most 1,200 sight lookups, and one `routeFeet`. The area sweep keeps today's density on every piece: `ceil(reach / 0.5)` samples, generated lazily, never coarser than half a square, so it never skips an area a leg of today's length would catch. For a group, acceptance and the 300-square cap read the check set only (5.5: the named tokens and the public members), a piece's reach being the largest over it, each on its own elevation path (6.1's rule and attach's). A visible token carried by a hidden holder is not in it, so a hidden holder's path never decides acceptance (L3-SOL-39). The sweep runs three ways. The **public sweep** places the public members at samples from their reach, within the cap. The **reveal sweep** places each visible token carried by a hidden holder (contract section 5's second reveal) at samples from its own movement, which players see, under one deterministic budget of 664 per op spread evenly past it, and never affects acceptance. The **private sweep** places the other members under its own budget of 664 per op, shared across pieces in proportion to their largest private reach and spaced evenly past it, and writes only results the DM sees (L3-SOL-38). So a hidden token never changes how finely a public or revealed one is swept. Only the public sweep keeps the half-square guarantee: on extreme motion past their budgets the reveal sweep (a revealed token on a holder whose hidden path rises and falls steeply) can miss a reminder, and the private sweep (a hidden dragged creature over ground alternating 0 and 200 ft at 1 ft squares) a DM-only one (L3-SOL-40). **One moment per sample** (L3-ASTRA-49): at each sample a sweep places every moving token of the op, all three sets and every area's holder included, at that sample's progress along the route, so an attached area moves in step with its holder. **A pair is judged on both sides' samples** (L3-ASTRA-50, L3-SOL-41): at each of its samples a sweep judges every creature and area pair where the creature, or the area's holder, is in that sweep's set (an area on a revealed token counting as the reveal sweep's). A creature that does not move belongs to no sweep, so it is judged by the sweep that owns the moving area, as today's reminders count an area moving onto a creature as an entry. Each pair is reminded at most once per op. When more than one sweep hits a pair, the reminder comes from the first in the fixed order public, reveal, private, whatever the progress at which each hit it, so a hidden sample never displaces or changes a result players see. Who receives a reminder stays as today's rules give it, and the private sweep still writes only what the DM sees. There is no revealed area (R11-OPUS-1, L3-ASTRA-51, L3-SOL-42): an area attached to a token a player cannot see is not projected to that player and its reminder is marked hidden, and an area with only a `casterId` keeps its own origin and never follows its caster, so an area on a hidden holder sweeps with the private sweep and reminds the DM alone. A visible carried creature holding an area stays a reveal case. A sweep judges more pairs per sample, never more samples. At most 664 samples per sweep (600 for 300 squares plus at most one per piece for rounding), 1,992 per op, against today's 600. Traps' own worst case along the same spots is in docs/design-v1-traps.md section 9.

## 11. Out of scope, and why

- **Group drags** stay straight legs: routing up to 100 tokens at once would cost a phone too much. Drag the active creature alone to count terrain. The dragged token's label reads the height it lands at, never squeezed, as `token.moveMany` records it (review ASTRA-18).
- **Opportunity attacks** stay the table's. The trail shows the squares crossed.
- **Climbing, jumping, burrowing and standing up:** each is a choice only the player makes. The DM's moves and "Teleport here" cover them.
- **A reachable-area overlay** falls out of the same search and is a good follow-up.
- **Gust of Wind, Slow and walls of thorns:** direction, chosen targets and wall shapes the areas do not have.
- **Furniture stamps as difficult terrain:** a stamp does not say how big its furniture is. The DM marks difficult ground under it.

## 12. Tests

- **Route arithmetic** (`shared/rules/route.test.ts`): `moved`, `cost` and `diag` under the three rules, extras, the counters running across legs and through difficult diagonals, rounding, an elevation walk of `+5, -10, +5`, and every open straight leg equal to today's `movedFeet`. `routeSpots` along straight, bent and taut pieces, Tiny half steps, squeezed spots, `progress`, and `stand` refusing every snapped spot off its segment whose cut piece clips a wall, the (0, 0) to (2, 1) case included (contract 4.3). Halved Speeds round down (25 to 12) in what is left, Dash and bands.
- **Entry accounting** (M3): a brute-force reference over exact rectangles checks Tiny and Large half steps across one and two squares of rubble in all 8 directions cost exactly double, and leaving costs nothing.
- **Search** (`shared/rules/walk.test.ts`): around a wall corner, through an open door and not a closed or unfound secret one, up a stair and never over a ledge, a Large creature through a 5 ft door and corridor, a Huge one through 10 ft and not 5, never a diagonal past a wall's end, around a pit, around a hostile Medium creature but through an ally, a Tiny or an Unconscious one, squeezing charged between two walls and not beside one, 5-10-5 exact on the half lattice with all four horizontal residues and against a brute-force reference on stairs of 1 ft and 3 ft rises at 5 ft and 3 ft per square, true distance pulled taut. A randomized test over generated scenes checks every piece passes `legBlocker` and the cost equals a brute-force search's on small grids. `sizeCategory` for each standard and custom size.
- **Speed changes:** the bands entering and leaving Spirit Guardians, with difficult terrain and Plant Growth together.
- **Route work within the frame** (`client/features/movement/routeBudget.test.ts`): every entry point, a drag's aims and drop, each ruler's renders and turns and an arrow key's press, driven through one board's work on a budget counted in units, on an empty 200 x 200 map under true distance, 40 rulers into a closed room, and a drag with kept rulers searching. No frame, its events and the next callback's work, with every unit charged in it counted on whatever budget, does more than its budget and one step that cannot stop partway, and every ruler gets its turn (reviews ASTRA-08 and ASTRA-14). Beside it, `dragStops.test.ts` drives the drag's stops at random with frames spent by other work and ends between: each drop lands once, each press sends at most once, and nothing goes after the end (review ASTRA-16). `routeWork.test.ts` adds, finishes and drops work at random, between frames and from inside other work, and checks that no waiting work sees another run twice before its own turn (review MV-O-25). `drop.test.ts` builds 300 random drops and 600 presses over heights, terrain, wall stubs and corridors a Large creature squeezes through, and asserts that the server's `canApply` takes every op the client would send, and that the drag's picture ends where the drop lands (review MV-O-24). On the creature's turn, each drop's label and frame cost equal the cost the reducer records for the move, and so does each press's count. A group drag's label, a cut walk's and astra's squeezed landing are checked the same way (review ASTRA-18).
- **The drag's search as a state machine:** many random sequences of finger moves, slices, drops, cancels, wall changes and late answers. Invariants: a drop sends at most one move, nothing is sent after a cancel, the route sent is the settled route to the drop's spot, and no search state outlives its drag.
- **Protocol, permissions and undo:** the route's shape, lattice and bounds, `teleport` refused with one, pieces tested for players and never for the DM. Redo of a walk around a wall passes with the walls unchanged and is refused after the door closes.
- **Reducer and replay:** accounting on every recorded leg, joins and "Doesn't count" keeping the sums, the display cap leaving them alone. A replay fixture at the op version below movement's with a path past 50 stops, then an undo, applies exactly as today and its guard matches (M5). Another replays an older elevation move from -10 ft to +10 ft through a cube and still writes its entry reminder, and a new routed leg whose piece crosses a cube's corner between lattice spots is swept as `alongLeg` sweeps it.
- **Public determinism** (contract section 5): movement's generators for the shared differential test, each a pair of rooms that differ only in hidden state, with the same drag by the DM and by a player (`playersMoveAny` included), comparing answers, every viewer's `ev` stream, drag frames and route geometry, not only cost: an unfound secret door, fogged terrain, marks and pits (for player drags and drags of groups with a party or player-owned member only, since a DM's other drags read fogged ground by design and projections carry it), a DM-hidden creature, a withheld creature, a creature's hidden HP and life, a DM-only area, an area players do not receive, an area whose caster is hidden, a hidden Prone, a private Swim Speed (the monster's route through water is the same with and without one), a hidden holder whose change of elevation differs, dragging a visible creature whose own movement is the same in both rooms, past a small cube only a half-square sweep catches (the creature's reminders unchanged, since area reminders skip objects), a hidden dragged creature over ground alternating 0 and 200 ft at 1 ft squares (acceptance and every player's results unchanged, its private sweep within 664), a visible holder carrying a 5 ft area and dragging a hidden creature that carries a visible one, which stays 10 ft from the holder all the way (no reminder in any room, since every sample places all of them at one moment), a public creature with a 5 ft area moving from x = 2 to 22 while a hidden holder drags a visible creature from x = 7 to 8, which is inside the area only during the move (one reminder in both rooms), a hidden named holder dragging a visible creature that carries a public area across a stationary visible creature outside it at both ends (one reminder in both rooms), an area on a hidden holder crossing a stationary visible creature (players receive neither the area nor its reminder: a DM-only reminder in both rooms), and a route at the cap's edge whose visible carried token, on a hidden holder, would make it 299 or 303 squares of reach depending on the holder's hidden path (accepted in both rooms), a hidden Tiny passenger on a Medium holder, and one the acting player owns but other players cannot see (spots, stop and sweep unchanged for them), and earlier legs of the turn unseen by non-owners that took different diagonals (the next route's bends unchanged).
- **e2e:** `e2e/vision.e2e.ts` gains steps `mv-1` to `mv-3`: a player on a phone drags around a wall's corner and the trail bends, a step into rubble reads 10 ft, and the marker reads "Moved 15 ft, used 20 ft". Its test 9 ("Teleport here after a stopped walk") needs a spot with no way around and the note's new words. `reach` runs as always.

## 13. Build plan

Each step is one commit with its tests, in this order.

1. `feat(rules): route cost, spots and size categories` (`shared/rules/route.ts`, `sizeCategory` in footprint.ts).
2. `feat(rules): walking route search` (`shared/rules/walk.ts`) and `scripts/bench-route.ts`.
3. `feat(protocol): routes on moves, accounting on path stops, difficult ground marks and costing areas` (model, protocol, movement's op version and its snapshot version with an identity step).
4. `feat(rules): moves walk their route` (`canApply`'s piece test, `withPath` and joins by version, `routeSeen`, projection, redo of routes, and area reminders swept along routes). The teleport-only-where-it-lands sweep stays traps'.
5. `feat(builder): difficult ground mark`.
6. `feat(areas): areas that slow movement` (the pane, SRD presets in both directions).
7. `feat(movement): drags walk around walls and count terrain` (search, line, label, Speed changes, drop, frames, marker).
8. `feat(measure): walking ruler`.
9. `test(e2e): walking around walls`.
10. `docs: walking routes and difficult terrain`: docs/design.md (6 data model, 7.6 frames, 7.7 undo of routes, 9.2 stop fields and costs, 9.8 routes and the leg test, 12 the mark, 16.2 Versioning), FEATURES.md and docs/dm-guide.md, last.

attach and traps build on steps 1 and 3 (`routeSpots`, `sizeCategory`, the fields), which land first.

## 14. Questions for the project owner, and the answers

Round 0, before review, each answered as recommended:

1. The ruler's default: Straight, with Walking one tap away, remembered per device.
2. Water costs double unless the creature has a Swim Speed. The Difficult ground mark covers wading.
3. Other creatures' spaces are difficult terrain, and routes go around those a creature cannot pass, allies being the same disposition.
4. A drop walks the cheapest way, around a rubble patch when that is cheaper.
5. A Prone creature's moves count as crawling, at double cost.
6. No new setting: routes follow "Walls and ledges block players' moves", and terrain always counts.
7. Add the "Difficult ground" mark that paints over a map image without hiding it.

Round 1, from review: **DM routes, "Party's knowledge".** Every device's route treats an unfound secret door as a wall, and a DM's drag of a token a player owns or a party member routes only over ground the party has seen, else it moves as a straight leg (4.4, 5.5). Every other route input stays public under round 2's public determinism rule (5.5).

Round 2, from review: **Plant Growth over difficult terrain** costs the larger only, 4 ft per foot, not both. The SRD does not settle it, so this is the chosen reading (4.1).

The coordinator's call inside those answers: Spirit Guardians halves Speed while the creature is inside and gives it back when it leaves, rather than charging per foot (4.2).

The coordinator decides product questions from round 2 on. No new questions.

## 15. As built

What the build settled where the note left room, each the reading closest to the note:

- **Label words.** Plant Growth's 4 ft per foot is named "overgrowth" in a drag's and a ruler's second line ("+30 ft for overgrowth"), after the spell's own Overgrowth effect. The other sources read "difficult terrain", "swimming" and "crawling", in that order.
- **An unsnapped token** keeps today's snapped landing when the straight leg is the route. When a route is needed it lands on the lattice from where it stands, at the spot nearest the snapped one, since every piece must end on that lattice.
- **While the search runs** the preview follows the finger. It holds at the wall only once the search finds no route.
- **A route cut after 64 pieces** lands at the last piece end, no later than the 64th, where the creature can stand: squeezed where the squeeze is a real one, else on its own grid from where it stands. The note shows as a notice, without "Teleport here", since nothing stopped it.
- **On a scene that stops no moves** nothing blocks a route: a creature the mover could not pass is difficult terrain there, as every other creature is.
- **Areas on the ground.** The squares an area costs are the squares it shades (`computeCoverage` at its own height), for walkers only, as the other ground sources are. An area attached to the mover goes with it and never costs it, and neither does one on a token carried rigidly with it: a public member it carries, or that rides or perches on it, by links every player sees, at any depth (review AT-ASTRA-28). The Half Speed lookup leaves those out too. A hidden link never counts for this, but on the DM's own ruler before it is shared, which reads every area and so judges every link too (review AT-O-37). An area on the mover's holder, on a creature it drags, or on what that creature carries still costs it, since those do not go where the mover goes.
- **Areas reach by the walls players know.** Areas pass a secret door by its real state, and players hold one nobody found as a wall. So on the DM's device the public world reads an area's squares, and a Half Speed area's hold, from the chunks as players hold them. Only the DM's own ruler, before it is shared, reads the real walls (review MV-O-10).
- **Walls from fogged terrain.** Automatic walls come from painted cells, fogged or not, so a painted cell under the fog can stop a diagonal at its wall's end, as it stops a straight drop today. The differential test's pairs keep automatic walls off, so they differ only in terrain.
- **Seen ground on the DM's device** is the DM's fog and the party's explored layer joined, the layers a player's merged fog is made of. Sight tiles are not read on their own, since the party's sight writes the explored layer.
- **Public counters** read a leg's corners at the leg's starting height, and its last part takes the stop's, since `via` carries no heights.
- **The band.** When an earlier spot inside a Half Speed area is the leg's worst, the color is that spot's and the words read what is left against the Speed at the end, in that band ("30 ft left with Dash"). When that spot is past Dash and the end is not, the words are the spot's own, against the halved Speed ("5 ft past Dash"), since the end would read less than nothing (review MV-O-3).
- **Open ground first** (5.2) also asks that the ground rise or fall evenly all along the leg, as one piece of the search does, since a walk counts each piece's climb (4.6) and the straight leg only the change between its ends. A straight leg over a rise and down again is searched and reads both climbs. Last, the straight leg must cost what the route along it does: a walk's feet round up to the creature's step, so 3 ft up a stair in a Tiny creature's half square reads 3 ft straight and 5 ft walked, and is searched (review ASTRA-13). That route is the straight leg split where its cost changes, never pulled taut, so unseen ground reads as plain in it as everywhere else, and a straight leg into the fog stays open ground under true distance too (review MV-O-21). The check goes a few steps at a time on the frame's budget (review ASTRA-08).
- **Ties** (5.3) are exact. The search keeps one state per spot and residues, so of two equal arrivals from different directions it keeps the first. The trace then looks again over every step of a cheapest walk back from the spot, and takes the fewest corners, then the shortest length. Each spot's walk is kept once traced. The trace looks at no more than 10,000 states: past that, on a long walk across open ground where cheapest walks tie by the tens of thousands, it keeps the walk the search first arrived by, as cheap and perhaps bent once more (review MV-O-17). A drag and a ruler run the trace in the same 4 ms slices as the search, every phase of it to the last piece, true distance's pulling taut included, so no frame pays for any part whole (review ASTRA-08). One trace runs at a time on a search, and one asked for elsewhere first is finished and kept, never thrown away, so two rulers from one spot never undo each other's progress (review ASTRA-12).
- **Arrow keys** step one square and never search: what the step walks over counts, as a route along the step, split where its cost changes, its pieces built by the code that builds a search's (reviews MV-O-20 and ASTRA-13), and a wall stops the press as today. What it counts never hangs on whether a search could go on from a spot: a step into the space of a creature it may end in, or over a pit, still pays its way. So does a press held short at a wall, for the part it walks, and a drop that goes straight because no route was found, which the drag's label reads as the drop will count it (review ASTRA-15). A straight drop through a wall, the DM's, or one past 64 cost changes still goes as the plain straight leg. So does a press or a straight drop whose walked route the server's check would refuse, such as a ledge met from the low half of a step (review MV-O-24). This replaced a whole search of the one-square drop in review, the coordinator's call (MV-O-12).
- **A drop still waiting** when a new drag starts or an arrow key is pressed lands first, its search run to the end at once, since the next move starts where it puts the token (review MV-O-7). A press or a landing still waiting for its frame goes then too. When the board goes away instead, they go with it, and never send or land after (review ASTRA-16). It is the one route work that keeps to no frame's 4 ms: at most one whole answer, within the cap, and only in that moment.
- **The walking ruler** reads no Swim Speed and no crawling, since a ruler has no turn and a shared one must read the same on every device.
- **The walking ruler searches on the frame's budget**, the one a drag shares, and a leg still searching waits grey and straight, with "Finding the way…" past the shared loading delay. Its searches and finished walks are kept while the parts of the room they read stay the same objects (the scene, its build, areas, tokens, fog, the explored layer, settings, members and characters), so a kept ruler is not walked again for an op that leaves them alone (review MV-O-5). Its legs run on the frame's shared budget, their worlds' builds counted in it: once it is spent no leg begins and none gets an allowance of its own, so forty rulers searching at once take the frame's 4 ms between them, each in turn (reviews ASTRA-14 and MV-O-23). Only the ruler being drawn works as it renders, so its walk follows the pointer as a drag's does. The rest read what is known and wait their turn. Each ruler keeps its own progress, its legs answered and the search of the leg it is on, so however many rulers search at once, none pushes out another's (review ASTRA-12).
- **Measure in the row** stands after Shared at priority 4, below the kept rulers' chip, so on a narrow row it is the first to wait behind ⋯. It is a choice the device keeps, and Keep, Clear and the kept rulers act on the map. Shared gained its eye alone as a compact form, so a DM's row with kept rulers still holds every control at 375 px. At 360 px it cannot, even in short forms, and Measure and the kept rulers wait behind ⋯ (the look pass had kept that chip in the row there, L11).
- **`routeSpots`** keeps the contract's name, but takes the route's points, the start first, each with its elevation, as `routePoints` gives them, not the op's pieces. Attach and traps call `routePoints` first (review MV-O-14).
- **Differential generators** that need attached tokens (hidden holders, dragged and carried creatures, passengers) wait for attach's build, which adds them to `shared/differential.test.ts`.
