# raccoon-vtt design addendum: v1 waves 3 and 4

This addendum designs the v1 map features of [features.md](features.md) section 3 (wave 3) and the walls, vision, light and height features of sections 8 and 11 plus raised areas (wave 4). It extends [design.md](design.md) and follows its rules: server-authoritative state, one pure reducer, per-viewer projection as the security boundary, commit before publish, bounded everything. Where this file names a design.md section, it means that section as deployed.

It is written against the deployed app, which includes v1 wave 2: `Token.path` (one leg per drop, design.md 9.2), snapshot version 5 and op version 3, and "seen" helpers that answer "not seen" during a blackout (section 4.3.3).

Status: revised after design review rounds 1 to 7 (section 11 lists every finding and what became of it). Wave 3 (section 3, parts 3A to 3G) is built and deployed. Wave 4 (section 4, parts 4A to 4I) is built and deployed, and design.md and features.md describe it as built. The project owner decided every question in section 9 and the fog undo rule on 2026-10-14. Questions 1, 6, 11, 12, 15, 17 and 20 have answers of their own. Every other question keeps its recommendation or owner default: "All defaults good with me". That includes question 5, whose door reach the owner had chosen from its recommendation.

Where the wave 3 build differs from this addendum:

- Stamp footprints from the Poly Haven models round up to the next quarter cell, and each render keeps its true size inside, instead of rounding to the nearest quarter (section 3.5). Rounding down had shrunk a 0.96 by 0.52 m chest to 62%. So the crate and the chest are 0.75 by 0.5 cells and the bed 1 by 1.5.
- The `namaqualand_boulders_01` renders are named Stone 1 and Stone 2, not boulders, since both meshes are about a foot across.
- A DM device preloads the other phases' images in the variant it draws, the full one on a computer, rather than always the mobile one (section 3.4).
- Erase leaves the edges on a scene's east and south borders, as it always did, so a stored erase replays the same on a scene shrunk since. Remove and Clear take them.
- Undoing a duplicate refuses once a later scene in the list was edited, and an older undo step on a later scene refuses after a duplicate, as after Reorder (section 3.2). The copy goes right after the original, so the duplicate moves every later scene down one under their value guards. Undoing newest first works.
- On a screen below 900 px, a selected stamp's tint swatches and its Flip, Bring to front, Duplicate and DM only buttons open in two small sheets ("Tint" and "More"), so the options bar keeps to two rows instead of the row section 3.5 describes, which wrapped to six on a phone.
- With Fog left unticked, a map scene's copy gets fog on and starts fully fogged, even when the original's fog is off. A blank mat's copy keeps the original's setting. The Fog hint names the outcome: "Left off, the copy starts fully fogged." or "Fog is off on this scene, so the copy's is too." (section 3.2).
- A kept ruler's stop on a token left behind becomes a free stop where that token stands now (its stored point only when the token is gone or on another scene). When players who do not own that token could not see it, the copied ruler is DM-only (section 3.2).
- A room import keeps an image reference only where its kind belongs (a token image on tokens, characters, monsters and stamps, a map image on maps and phases, a thumbnail on thumbnails, a handout image on handouts) and drops the rest. Each phase must pass the reducer's shape and grid checks, `map` must equal the active phase's image on the reference grid, and `scene.setPhase` refuses a phase that fails them (sections 2.5, 3.4).
- A tap places a shipped stamp at its catalog footprint (a tree 2 by 2, the long woodpile 2.25 by 1), and a room image one cell across on its long side (section 3.5). With no stamp chosen, the tap opens the picker once its click has passed, so on a phone the click never lands on a tile.
- DM-only stamps are dimmed inside a dashed outline on the DM's board, like hidden tokens. The map export and thumbnails draw them as made.
- The stamp resize handle stands 16 px out from the corner, and a press inside the selected stamp always moves it. On a phone the armed Delete reads "Delete?".
- Renaming a folder to another folder's name merges the two, says so under the field before Save, and undoes as "renaming the folder A to B".
- The light caption reads "15 ft bright, dim to 45 ft" (the outer ring), and Lights mode on a scene with no lights says where lights come from.
- Removing the phase that is showing says on its armed button that the map switches ("Tap again: the map switches to Day").
- A thumbnail counts as updated, and its scene's mark clears, only once the server takes it.
- Create scene shows "Uploading the map…" with a spinner, the image's size and, when the server is slow, "Waiting for the server…", not upload progress (section 3.1): the upload goes through fetch, which reports none.
- A grid outside the protocol's bounds is refused on the import's summary sheet, before the upload. "Add as a phase" reads only the image (no 200-square bound, no geometry), and checks an image that uploads as it is with the reducer's exact shape rule before the upload (sections 3.1, 3.4).
- While walls are sent the dialog's button reads "Hide (keep this page open)". Hiding the dialog does not stop the import: the scene still opens unless the DM has gone to another scene since, and a toast says how it ended. When a reconnect loses answers and none was refused, the dialog opens the scene, counts its edges, free walls and lights against what it sent, and says the import is complete or could not be confirmed, naming Undo (section 3.1 step 8).
- Every iPhone and iPad keeps to the iOS canvas limit when resizing a map, whatever its screen size ("too large for an iPad to resize"). An iPad reads files up to 150 MB, and its file picker takes any file, as a phone's does (section 3.1).
- The split's candidate pairs are every pair its counting pass compares: a free wall and another segment that share a cell row and overlap along x, whether or not their boxes meet (section 2.1 says overlapping boxes). The cap stays 100,000 and now bounds the pass's real work.
- Pillars are capped at 1,000 per scene and drawn edges at 20,000 per scene. Drawn edges are every edge entry a scene's chunks store: walls, doors, windows and removed automatic walls. Doors and windows are capped at 1,000 within them, on the grid and free together, secret doors included. The split's added pieces came down from 10,000 to 5,000. `scripts/bench-walls.ts` sized all of these on the densest build at every cap, and the server-box gate (a modest 4-core server runs at about 1.4 times a development laptop's times) left room for 20,000 drawn edges, enough for a large imported map whose walls snap to the grid (section 2.4). The limits step refuses only an op, undo included, that raises a count past its cap, so a room already over one still loads and takes other edits. A scene over a cap cannot be duplicated until it is under it, and an undo or redo that would bring back a scene past a cap is refused. A room import refuses a scene over any cap. The Universal VTT import refuses a map with too many grid edges, or too many door and window edges, before sending anything. A refusal says whether the room or the scene is full.
- An area's origin on or within 1/4096 cell of a wall steps off it with section 4.3.2's exact step (toward the origin creature first, to its side of a wall it lies exactly on), instead of a fixed nudge that could run along a diagonal free wall. A probe that cannot step covers nothing.
- A player's uploader rows count only for `token` assets, and a room import keeps uploaders only on `token` assets. A thumbnail is never listed for or readable by a player, whoever uploaded it.
- A folder rename is always one undo group and is named "renaming the folder A to B", a folder of one scene included.
- Lining up a map's grid with the 3 by 3 box puts the origin on the first grid intersection at or right of and below the image's top-left corner, so a margin before the first printed line falls outside the scene. An origin within 5% of a cell of 0 or of a whole cell is 0 (`calibrationFromBox`). A box drawn a hair above or left of a line on art whose squares start at its edge had put the origin just under a whole cell, and the scene lost the art's first row or column, a 20 by 14 map becoming 20 by 13 (the owner's decision after the wave 5 live play review). A wider margin, such as a tenth of a cell, is kept.

Where the wave 4 build differs from this addendum:

- A scene with vision on holds at most 6,000 potential sight pieces, not 8,000 (sections 2.1 and 2.4). The server-box gate measured the densest dark vision scene at the caps on a modest 4-core server: a room's first snapshot, which computes sight from nothing, took 267 ms against the 250 ms budget, and a light level switch 236 ms. Three changes that send exactly the same messages came first. The held map's hash reads whole code units, with the same digests. A snapshot keeps the map's chunks, fog tiles and sight tiles in the socket's held map unhashed until a batch compares them, and a player's chunk and fog tiles come back as the same objects while what they read stands, so an unchanged map is never hashed again. On the laptop they took the switch from about 158 ms to 105 ms and the first snapshot from about 177 ms to 149 ms, still about 223 ms on the server at its 1.5 ratio. At 6,000 pieces the first snapshot measures about 126 ms on the laptop (about 190 ms on the server) and the switch about 87 ms. Lowering the free lights from 100 to 60 bought as much, but wave 3 scenes already held up to 100 lights, while no scene could have vision before wave 4 deployed, so none was over the new cap.
- Senses and light radii stop in cells as well as feet: a sense at 30 cells and each light radius at 24, which are 150 ft and 120 ft at 5 ft per cell (section 2.4). On any grid of 5 ft or more the feet bind first, so nothing there changes, to the last bit. The room settings allow 1 ft per cell, and there a capped light or sense covered 25 times the cells, and so the walls, that the gate measured: the densest dark scene's first snapshot took about 368 ms on the laptop and a light level switch about 266 ms, past 250 ms on the server. Bounding the cells bounds what sight costs at every scale, where a cut in feet would have shortened every 5 ft game's torches and darkvision for the sake of a rare fine grid. At 1 ft per cell those rows now measure what they do at 5 ft, about 132 ms and 88 ms on the laptop. On a grid finer than 5 ft per cell, a darkvision of 60 ft therefore reaches 30 cells rather than 60, though the DM's Vision settings still list it as 60 ft.
- Door reach is the larger of 5 ft and one cell, measured in three dimensions by the room's distance rule, with a clear line to the door (section 4.1). That was the owner's choice following the recommendation of question 5, which the project owner kept with the other defaults on 2026-10-14. Only the player's own tokens reach a door, not tokens they may move under `playersMoveAny`. A free door's two sides are the cells 1/256 cell off its midpoint along its normal. The clear line counts a blocker it touches, except one that meets it only at the door's midpoint, and ledges count for a walker. The client checks reach before sending, so a tap out of reach says "Too far from the door." at once.
- A tap reaches the nearest door within 22 px of its line anywhere along its length, rather than a 44 px zone around its middle, and a player reaches only a door with a cell beside it out of the fog. The pill shows with the Select tool and no token selected, and steps aside while a token is dragged. The action bar's "Open door" and "Close door" are a player's, on their own tokens: the DM uses the pill. A door already in the asked state writes nothing, `found` marks any door discovered, and Lock locks an open door too.
- A squeeze needs a real narrow space (the owner's rule after the build, sections 4.1 and 11), and its checks and a drop's squeezed spot judge ledges from where the token stood before the move. A squeeze leaves the token's height and eye as they were. A drop tries the squeezed spot under the finger before the rule's half-cell shifts, so a squeezed creature dragged along its corridor stays in it. A group move never squeezes.
- A player's teleport must keep the token's full footprint inside the scene, with `blockMovement` off too ("a teleport lands inside the map"). The DM's teleports are not checked. The undo of the walk shows no toast of its own, so "Undid moving Thorn." never reads as if the teleport were taken back. Beyond the addendum's messages, an answer lost with the connection stops the flow ("The connection dropped before the server answered. Check where the token stands, then try again."), and a teleport refused for another reason than a lock says "Teleport refused. The walk was taken back."
- The server refuses a `token.moveMany` whole when any leg is stopped. The client sends only the allowed legs and names the rest ("Thorn stayed where it was: a wall is in the way."). The leg test is skipped for a move that changes neither `x` nor `y`. A stopped drag holds its preview with a red ring around the held spot, and only a lone token's preview holds.
- A stair connection passes fliers as well as walkers. Raised edges come only from cells inside the scene, and a neighbor outside it never counts as higher when a stair's direction is worked out.
- The wall derive is not incremental. Moves reuse the cached wall set, which is derived again only after a build or a door edit.
- A free area's point takes the ground under it, the highest of the cells it touches, when the DM first sets it on open map. Tapped again or dragged before it is placed, it keeps its height above the ground, so one moved off a platform comes down with it, and a lift set with the Elevation stepper stays (the owner's decision after the wave 4 live play review). A placed area moved later keeps its origin height, as section 4.2 says.
- Placing a token at elevation 0 stands it on the ground there. A token placed at any other elevation keeps it, where the addendum set every placement to the ground. A token's Duplicate lands the copy as a drop of the original would land there (the owner's decision after the wave 4 live play review). Erase and Clear take heights and stair marks, and a token that stood on that ground lands on what is left, as a height paint lands it, in the same undo step. A flier above and a token inside the ground keep their elevation. That is the owner's default for question 18, which the project owner kept on 2026-10-14.
- A token inside the ground shows "Inside the ground (10 ft below)." with a separate "Stand on it" button, for those who may change its elevation.
- Height mode has an Area brush beside the 1, 2 and 3 square brushes, and a ✕ choice that removes stair marks. 0 ft reads "Ground (clears)". Region heights show as pills ("↑10 ft"), at most 300, largest first and never overlapping, and "?" shows only at 8 px a cell or more. Cells already as a stroke would leave them are not sent.
- Raised ground's shadow falls in three fading bands, each lower neighbor by its own height difference, and edges a directed stair joins draw no rim or dark line. A stair over a map image draws translucent treads with a pale halo on its risers and chevron, rather than only the treads.
- A token's shadow is its own node drawn with `destination-over` on the tokens layer, under every token body and over the map, rather than a pass in TokenNode. It shrinks to 70% and fades from 75% to 45% dark as the token rises to 30 ft. It sits 0.2 cell down and to the right just off the ground and drifts to 0.6 cell at 30 ft, times the footprint's shorter side for a token larger than a cell, rather than 0.1 cell per 5 ft: at 0.1 the shadow hid under the token's disc, and a creature 5 or 10 ft up showed no cue (the owner's decision after the wave 4 live play review).
- The source cap is taken before the step off a wall, so a source that fails closed on a wall still holds one of the 12 places. A missing actor counts as down, and a source in a 1/64-cell gap between two walls sees nothing.
- A source's sweep box is the whole scene in a bright or dim scene, its senses and every lit area in a dark one, and its blindsight alone while Blinded. A polygon is worked out again when a sight piece that differs meets its box, finer than a changed chunk grown by 5 cells. A token's carried light always casts shadows from walls, since `Token.light` has no switch for it.
- There is no limit of 4 vision scenes per room: the state carries no room ID, and the 64 MB cap on the vision caches, two entries per scene, bounds their memory.
- Explore runs after a batch that holds ops, never after a batch of refusals alone, a `hello` or a room load. An explore op that fails the protocol schema or the reducer is logged and dropped, never refusing anything. The reducer adds a `sys.explore`'s bits to what the layer holds and refuses a tile outside the scene.
- The fan-out works out sight before and after each batch for every vision scene a socket holds and diffs the two, rather than keeping the last committed sight, so an edit of a creature's senses, conditions or life reaches players through that diff, with no token touched. Values every player gets alike (chunks, fog, sight, the scene, labels, stamps) are projected once per batch for all players.
- The server judges a drag frame by the squeezed footprint where the creature would squeeze on fog-only scenes too. The ephemeral channel asks whether the sender may move the token through the move rights directly, without building a `token.move` for `canApply`, and still without the wall test.
- "The room is too full for the party to explore that scene. …" answers every op that makes another scene the exploring one, deleting the player scene and the undo of each included, when the room without the reserve still fits. A room that does not fit even without it gets the usual full-room answer.
- The lit token light cap counts a token whose light gives any, unless the DM hid the token, whose light is dark for players and costs no sight. It refuses only the DM's ops, the DM showing a lit token included, with the count, which only the DM sees. A player's op is never refused by it: the count told a player whose torch was refused of creatures they had not seen (live play after wave 4, the owner's decision). A hidden combatant revealed on its turn is never refused either, and neither is a room import. Past the cap, sight lights only the first 20 carried lights in a fixed order, as the source cap takes its sources: the party's own in the source cap's order, then every other token, each by token ID. So a player's torch always lights, a monster's light past the 20th lights nothing for the party, and sight's cost stays bounded. The DM's Vision settings then say how many light nothing ("3 carried lights light nothing for the party: at most 20 do, the party's own first."). It and the sight piece cap refuse only an op that raises the count past them, so a room over one still loads and takes other edits. A room import checks the sight piece cap on every scene outright.
- `partyVision` is stored only while true. Membership lifts a token above the fog on every scene, not only vision scenes.
- A hidden combatant revealed on its turn follows the fog and the party's sight like any other creature (question 20, decided by the project owner after wave 4 shipped). Players get its token and its initiative row only on revealed ground on a fog scene, and only while the party sees it on a vision scene, and see "Another creature's turn" until then. Its drag previews follow the same rule, and its turn's start, path stops and log lines are marked unseen while it stands out of view. The reducer still sets and clears `fogExemptAuto` as before, so stored ops replay to the state they made. Ops stored before op version 4 keep the old seen marks on replay (design.md 16.2), and the DM's token panel no longer shows the automatic flag.
- Turning vision on keeps the scene's stored light level, Bright when it has none, and a phase's light level sets `vision.light`, keeping whether vision is on: when the map switches to the phase, when the phase list's change makes it the showing phase, and at once when the list sets a level on the showing phase (the owner's default for question 19, which the project owner kept on 2026-10-14). Taking a level off the showing phase leaves the scene's. The Vision settings show the light level's meaning, a "Turn fog on" button when fog is off, "Working out what the party sees…" while vision turns on, and "Light with each map phase" for a scene with phases, where the addendum had only the field. The fog-off note reads "Explored ground is not remembered while fog is off. Players see the whole map dimmed outside the party's sight."
- The DM's Party sight veils only what the party cannot see, at 40%, shows only on a vision scene, and lasts for the visit. The DM's dotted outline of explored ground draws while the scene's fog is on.
- The sight overlay writes a large change at 48 tiles a frame, draws the area past the scene's edge as not seen, and counts a `vision` value it cannot read as on.
- The token's Light chip and Sight section show on a vision scene, and on any scene while the token carries a light, so it can be put out. "Shares sight with the party" is offered for creatures no player owns, or one already marked.
- Lights mode places a Torch by default, on the 1/64 lattice, lit and casting shadows, named after its preset. Its pane adds the presets, a Name and Done, and while it is open a tap on empty map closes it instead of placing.
- A Universal VTT import reads the ambient light's Rec. 709 luminance on the color as written, and makes the scene with vision off and the level chosen, Bright when the file says nothing.
- "Move players" knows whether the party can see only on the scene in view, from its sight tiles. For another scene it says what to check, and with fog off it says the map shows dimmed.
- A duplicate that copies the fog copies the explored layer with it, outside the duplicate's undo step, since the explored layer has no undo (section 4.3.3): undoing the duplicate takes the copy's explored tiles with the scene, and redoing it brings the scene back without them. Every new scene, the room's first Battle mat included, stops players' moves. A duplicate keeps the original's setting.
- The undo of the move-blocking switch is named ("making walls and ledges block players' moves on the scene Crypt"), and so are doors ("opening a door"), heights ("painting heights"), stairs ("marking stairs"), the Vision settings ("turning on party vision on the scene Crypt", "making the scene Crypt dark"), a token's light ("giving Thorn a light", "putting out the light of Thorn"), sharing sight ("letting Bree share its sight with the party") and a teleport ("teleporting Thorn").
- The map export's player view judges labels and stamps by the merged fog, as section 4.3.3 says, after the integration found it reading the DM's layer alone.
- The benches hold a laptop to the budgets over 1.4 (`scripts/bench-vision.ts`) and 1.5 (`scripts/bench-server4.ts`), the ratios a modest 4-core server ran them at, where section 4.3.6 assumed two to three. The phone rows were measured on the laptop.

## 1. Summary of the decisions

- **One wall set for every rule, split so no two segments cross.** Builder edges stay the grid model. Walls that do not sit on grid lines (from a Universal VTT import) are stored as free wall segments inside the same build chunks. One derived set, split at every crossing once per walls version, feeds areas of effect, movement and sight, each with its own blocking rule. The split's work is capped where geometry is written, on every scene.
- **Universal VTT import runs in the DM's browser**, in a worker. The image goes through the normal map upload and the server's sharp pipeline. Walls, doors and lights arrive as ordinary bounded ops that the server validates like any other.
- **Map phases swap only the active image.** Players receive the active phase's image and nothing about the others, so "on fire" never spoils ahead.
- **Stamps are their own collection**, drawn on the board layer. The shipped set is top-down art the project owner chose: Prime_8's trees and stones (CC0), Liosan's foliage and village elements (CC BY 3.0), and Poly Haven's CC0 furniture models rendered straight down by a committed build script. The DM can also stamp images from the room's library.
- **Movement blocking is a permission rule, not a reducer rule**, so stored moves replay unchanged. The client runs the same shared test while dragging, so a drag stops at the wall instead of bouncing. A creature fits through an opening sized for one size smaller, as the SRD's narrow-opening rule allows, and never through a wall. A blocked drop offers "Teleport here" (the project owner, 2026-10-14), which replaces the stopped walk with one uncounted leg and tells the DM.
- **Raised areas are painted heights on cells.** An edge between two heights blocks walking tokens unless a stair connects it. A token that lands on raised ground takes its height as its elevation. Stairs point up, inferred from the heights around them.
- **Vision is party vision (the project owner, 2026-10-14), computed on the server only, with exact arithmetic.** The visible region is the union of what every party creature sees, rasterized at the fog's resolution (4 x 4 sub-cells per cell). Players receive it as derived tiles and never compute it. Creatures out of the party's sight are withheld exactly as creatures under fog are today. Lights never reach players, only their effect does. The geometry uses only addition, subtraction, multiplication, division and comparison, so every engine and every replay gets the same bits.
- **Explored areas are a second fog layer.** What the party sees is written by a server-made op in the same batch into an explored layer beside the DM's fog, and players receive the two merged, so every existing fog rule keeps working. The DM's undo touches only the DM's layer, so it never fights exploration and never erases it (the project owner, 2026-10-14).
- **Hard caps bound the work.** At most 12 party sources, 100 free lights plus 20 lit token lights, 6,000 potential sight pieces and light radii of 120 ft per scene, and caps on the split's work for every scene. Every row of the performance table is measured at those caps on the server before release.

## 2. Shared ground

### 2.1 The wall set

`shared/rules/walls.ts` derives a set of blocking segments per scene. Today it has `edges` (for drawing) and `blockers` (segments that stop areas). Waves 3 and 4 add free segments, pillars and raised edges, and three blocking rules:

| Feature | Areas (MVP rule, unchanged) | Movement (wave 4) | Sight (wave 4) |
| --- | --- | --- | --- |
| Wall (edge or free) | blocks | blocks | blocks |
| Window | blocks | blocks | open |
| Door, open | open | open | open |
| Door, closed or locked | blocks | blocks | blocks |
| Secret door not yet found | its real state | blocks | blocks |
| Pillar cell (a square inset 9/64 cell, so its corners lie on the 1/64 lattice) | open, as today | blocks | blocks |
| Raised edge (section 4.2) | open | blocks walking tokens unless a stair connects it, when `blockMovement` is on | blocks a viewer whose eye is below its top |

A secret door that is not yet found blocks movement and sight whatever its state, because players see a wall there (design.md 7.3). So the server's blocking set for players equals the one a player's own projected build gives, and the drag preview on a phone and the server's answer always agree. A test checks that equality for every secret-door and lock state.

Pillars blocking movement and sight is new. Today a pillar is only drawn. It is the obvious expectation at the table. Areas keep the MVP rule, so no placed area changes when wave 4 deploys.

**No two segments cross.** The existing sweep (`visibilityPolygon`) requires segments that never cross (walls.ts, the comment above `mergeBlockers`), and three reviewers showed sight leaking through two crossing walls. Free walls cross grid walls, each other and object outlines, and snapping adds crossings. So the derivation:

1. Collects every candidate segment once: edge walls, doors and windows, free walls, pillar squares, and raised edges with their top height.
2. Merges collinear overlaps and splits every segment at every point where another one crosses or touches it, using a per-cell bucket index. Grid-aligned segments already meet only at grid points and split there as `mergeBlockers` does today, so a scene of grid walls alone splits in time linear in its cells. Crossings come only from free walls.
3. Tags each piece with the sets it belongs to: areas, movement, sight, and for a raised edge its top.

Any subset of a set split this way is crossing-free, so the area and sight sets, and a sight set filtered by eye height, can go to the sweep as they are. This runs once per derived set. The split lives in `shared/rules/segments.ts` and uses the exact arithmetic of section 4.3.4, since sight depends on it. Areas keep the existing sweep in walls.ts, fed the split area set: area results are never stored, so they need no exact arithmetic.

**Stored segments decide, pieces only feed sweeps.** A split point is computed once and shared by both pieces it ends, so a split never opens a gap. But it is rounded, so it need not lie on the 1/64 lattice, and a test of whether something touches or lies on a piece would not be exact. So every touch or incidence decision reads the stored segments, whose ends all lie on the lattice: edge walls and doors, stored free walls (unsplit), pillar squares and raised edges. A point that is not on the lattice, such as a token's center or an eye, is tested against them with an exact orientation predicate: Shewchuk's adaptive arithmetic, as the `robust-predicates` package implements it, which gives the exact sign of the cross product for any double coordinates using only addition, subtraction and multiplication. Part 3B adds that package as a dependency, pinned at 3.0.3 (Unlicense, no dependencies, section 10). So every side, touch and incidence decision is exact, and nothing is rounded to make it so. The movement test (section 4.1) and the on-wall test for eyes and lights (section 4.3.2) work on stored segments only. The split pieces go only to the area and sight sweeps, which never decide a touch.

**A sweep's own box.** The sweep closes its polygon with a box of four segments (walls.ts, `visibilityPolygon`), and a culled sweep (section 4.3.4) uses a box smaller than the scene. A segment crossing that box would cross its sides, the same leak again. So a sweep takes every segment that intersects its box, not only the ones inside it, and clips each to the box before sweeping. The clipped pieces only touch the box at their ends.

A property test compares sight against an independent brute-force ray cast (a ray from the viewer to each sub-cell center, tested against every unclipped segment) on random scenes with crossing free walls, raised edges and pillars, for whole-scene sweeps, culled sweeps and light sweeps alike. An incremental-equals-cold test alone could not catch an error both share.

**The split's work is capped where geometry is written.** Areas use the split set on every scene, vision on or off, and phones derive the same set as the server. So the bound must hold before anyone derives, not after. A counting pass in `segments.ts` counts, without building any piece, the candidate pairs (a free wall and another segment that share a cell row and overlap along x, every pair the pass compares) and the pieces their crossings would add, and stops as soon as a count passes its cap (section 2.4: 100,000 candidate pairs and 5,000 added pieces per scene). The limits step runs it for every op that writes geometry (`build.walls`, `build.edge`, every build op that paints or erases cells, pillars included, `build.height`, `build.stairs`, a scene's `autoWalls`), for a `sys.restore` that writes chunks or a scene's `autoWalls` (an undo over the caps answers, for example, "could not undo …: this scene's walls would cross too often: they would split into more than 5,000 extra pieces"), and so do the room import schema and the Universal VTT import. Over a cap, the op is refused with `quota` before anything is allocated. So every stored scene splits within the caps, everywhere. A dense pile of free walls in one cell, or a lattice of crossing walls, is refused at the op that would create it.

On a scene with vision on, the potential sight pieces may number at most 6,000 (8,000 until the server-box gate, section 4.3.6): every piece that would block sight if every door were closed and every secret door hidden, and every raised edge whatever its height. Counting them whatever the door states means only build ops and turning vision on can reach the cap. A player closing a door never gets `quota`. Turning vision on over the cap refuses with the count ("This scene has 9,200 wall pieces, more than vision can handle (6,000)."), and so does a build op that would cross it on a vision scene.

**Movement tests a creature's core.** Section 4.1 defines it: a square one size smaller than the creature, so a Large creature passes a 5 ft door or corridor and a Huge one needs 10 ft, as the SRD's narrow-opening rule says, while no creature's path ever crosses a wall.

**Automatic walls** (the owner's rule, corrected in round 3 and approved by the project owner on 2026-10-14, question 17). Today every painted terrain counts as floor, and an edge between any painted cell and an unpainted one gets a wall. A cell holds one terrain, so water, a pit, a pillar or stairs replace the floor in their cell rather than sitting on it. That rule therefore stays for the scenes where dungeons are built. Only scenes made from a map image or an import change: on an image the art is the floor and painted terrain is a note on it, and an import brings its own walls.

```ts
Scene.autoWalls?: 'all' | 'floor' | 'off'   // absent reads as 'all'
```

- `'all'` is today's rule: a wall between any painted cell and an unpainted one. Every blank mat gets it, new or existing, and so does every scene that exists before wave 3. No existing scene changes its walls, and no area on any builder scene changes.
- `'floor'` is only for scenes made from a map image from wave 3 on. Only floor terrains (stone, wood, grass, dirt, cave) make automatic walls. The overlay terrains (difficult ground, water, rubble, pit, pillar, stairs) never make one by themselves, so difficult ground, water or stairs painted over the art are not walled in, while a stone room painted over it still is. Compared with `'all'`, the only edges that change are those between an overlay and an unpainted cell, which have no wall. Inside a dungeon built over an image, that opens a stair corridor between rooms, a pillar against a room's outer edge or a water channel to the void, which is why blank mats keep `'all'`. A blank mat that later gets its first image keeps its rule, since its build was drawn under it.
- `'off'` makes no automatic walls. Universal VTT imports get it, because the file brings its walls.
- A wave 4 stair mark (section 4.2) counts as a Stairs cell under every rule. Heights paint no terrain and make no automatic wall.
- One shared predicate decides what is painted for a cell: its terrain, or a stair mark. Wall derivation and the secret-door projection below both call it, reading the neighbor chunk's cells and marks across a chunk border, so they can never disagree.
- The scene settings show "Automatic walls" with three choices: Around every painted cell, Around floor only, and Off. Switching changes exactly the edges named above, and the setting says which.
- A hidden secret door is dropped from a player's projection only where the scene's rule puts an automatic wall on its edge. Elsewhere, and on every edge of an `'off'` scene, it arrives as a plain wall (`projectChunkForPlayer` takes the scene's rule, and the player map export uses the same function). So players never see a gap where a hidden door is. The equality test of the blocking sets runs under all three rules, including a hidden secret door beside a stair mark and across a chunk border.
- A change of `autoWalls`, by an edit or by an undo or redo, bumps the walls version (a restore keeps the higher of the old and current version, as build restores do), sets `global` for the scene so every chunk is projected again, and is part of every derived-set cache key. The client's area cache (`client/features/areas/coverage.ts`) keys on the walls version, so the bump reaches it too.

**Caches follow identity, not version numbers.** A cache keyed on the walls version can serve walls from a staged state the size guard refused, since a refused op's version number is reused by the next op (actor.ts checks size before accepting a staged state). The derived set, the movement index and every vision cache are keyed on the identity of their inputs (entities are replaced, never changed): per scene, the list of its chunk objects, plus the scene's `autoWalls` and bounds. Each scene keeps at most two entries, one for the committed state and one for the staged state.

### 2.2 Free walls

```ts
// In BuildChunk (wave 3). Coordinates are cells, each a multiple of 1/64.
walls?: FreeWall[]
type FreeWall = { id: string, a: [x, y], b: [x, y], f: WallFeature }   // WallFeature: wall, door or window
```

- A free wall lives in the chunk that holds its midpoint. It is at most 8 cells long, enforced by the protocol on every write and by the room import schema, so it reaches at most 4 cells past its chunk.
- Coordinates are multiples of 1/64 cell, checked by the protocol schema (`Number.isInteger(v * 64)`), and lie within the scene, from 0 to its width and height inclusive.
- `id` is 12 random characters from the client, unique within its chunk. Ops name a free wall by chunk and id. An id never encodes what the wall is or where it came from.
- The op is `build.walls { sceneId, put?: FreeWall[], remove?: {cx, cy, id}[] }`, DM only, at most 500 walls per op and batched by the client to stay under 48 KiB serialized. 500 doors serialize to about 73 KB, past the 64 KiB frame limit, so the byte bound is what binds. The reducer places each put in its midpoint's chunk and bumps the walls version.
- Free walls count toward a limit of 4,000 per scene (section 2.4). They are drawn with the edge walls in the same path, and doors and windows on them draw their usual symbols turned to the segment.
- Erase takes a free wall whose midpoint is in an erased cell. `build.clear` takes them all.
- Player projection treats a free secret door exactly as an edge one (design.md 7.3): not yet found, it arrives as a plain wall, and a locked door arrives closed. A free wall is never automatic, so a hidden secret free door always becomes a plain wall. A player's copy of a chunk lists its free walls sorted by coordinates, so their order never shows which one was imported as a door.

### 2.3 Versions and migrations

| Wave | Snapshot | Op | Why |
| --- | --- | --- | --- |
| 3 | 6 | 3 (unchanged) | Adds the `stamps` and `lights` collections, empty in older snapshots and backups. Everything else is an optional field. No protocol rule tightens. Edge validation loosens (section 3.1), which older ops still pass. |
| 4 | 7 | 3 (unchanged) | Adds the `exploredTiles` collection (section 4.3.3), empty in older snapshots and backups. Every other addition is an optional field or a new op. Movement blocking is a permission rule (section 4.1), and replay does not run permissions (persistence.ts replays through the reducer only), so stored moves replay as they were made. Sight is derived and never stored. |

A scene without the new fields reads as before: no phases, no folder, automatic walls by the older rule (`'all'`), movement not blocked, vision off. So no migration step changes an existing room's behavior. A value guard on a chunk or a scene hashes the stored value, and older values simply lack the new fields, so stored restores still match on replay (design.md 7.7).

### 2.4 Limits

Added to `shared/limits.ts` and design.md 10.5:

| Item | Limit |
| --- | --- |
| Free walls | 4,000 per scene, 8 cells long at most, 500 and 48 KiB per op |
| The split's candidate pairs | 100,000 per scene, every scene (section 2.1) |
| Pieces the split adds | 5,000 per scene, every scene (section 2.1, lowered from 10,000 in the wave 3 review) |
| Pillars | 1,000 per scene (added in the wave 3 review) |
| Doors and windows | 1,000 per scene, on the grid and free together, secret doors included (added in the wave 3 review) |
| Drawn edges | 20,000 per scene, every stored edge entry: walls, doors, windows and removed automatic walls (added in the wave 3 review) |
| Potential sight pieces | 6,000 per scene with vision on, counted whatever the door states (section 2.1, lowered from 8,000 by the server-box gate of section 4.3.6) |
| Party sight sources | 12 per scene (section 4.3.2) |
| Free lights | 100 per scene, 100 per op |
| Lit token lights | 20 per scene |
| Light radii | bright at most 120 ft, and dim at most 120 ft beyond it, each also at most 24 cells, which binds only on a grid finer than 5 ft per cell (section 4.3.6) |
| Parsed senses | darkvision, blindsight and truesight at most 150 ft, and at most 30 cells, which binds only on a grid finer than 5 ft per cell (section 4.3.6) |
| Stamps | 500 per scene, 100 per op |
| Map phases | 8 per scene, the active one included |
| Heights and stairs | the scene bounds, 2,000 cells per op, heights -100 to 200 ft in whole feet |
| Folder name | 40 characters, single-line text rules |
| Scene thumbnail upload | 512 KiB, stored at most 320 px on its long side |

The radius caps come from the SRD. Its largest light, Daylight, is Bright Light in a 60-foot radius and Dim Light for an additional 60 feet, and its longest darkvision is 150 ft. Over the light caps, the op that would light one more refuses with `quota` and says which cap ("This scene already has 20 lit token lights."). Over the source cap, nothing is refused: the first 12 sources lend sight (section 4.3.2), every party member stays shown to players, and the DM's Vision settings say how many lend no sight.

**Bytes.** New stored data is kept compact. Heights are one base64 string of 256 little-endian 16-bit values per chunk (684 characters), present only in chunks with a height. Stair marks are one 256-character string per chunk, present only in chunks with a stair. A scene's free walls take about 300 KB at the limit, stamps about 100 KB, and the sight tiles a player receives up to about 235 KB for an ASCII scene ID (section 4.3.4).

A scene at every limit at once would now pass the 3 MiB projected-scene check. That is the check's job: the size guard refuses the op that would cross it, as it does today. The guard (`server/rooms/sizeGuard.ts`) measures stored entities, and sight is derived, so the guard reserves sight's maximum instead of measuring it: on a scene with vision on, every projected-size check adds the scene's tile count times the most one of its sight tile entries can serialize to, computed once per scene from its own ID (section 4.3.4).

**The explored layer's reserve.** A `sys.explore` is never refused (section 4.3.3), so the room must always have space for it before it happens, not after:

- Only the player scene explores, so only it is reserved, and only while it has vision and fog on. A scene with either off has no reserve at all. The reserve is the scene's maximum explored layer minus what the layer already takes, computed per tile so no term is ever negative. Its maximum entry is the most one tile entry can serialize to under that scene's own key (its JSON key and value, the 684 base64 characters every tile has, a rev at its widest, 16 digits, and a comma, computed once per scene from its ID). The reserve sums, over every tile inside the scene's bounds, that maximum less the tile's actual size if the layer holds it, or the whole maximum if not. Actual size is measured as the room check measures: `utf8Bytes` of the entry with its key, colon and comma. A held tile outside the bounds, left when the bounds shrank, counts only in the measured state. A tile entry's size does not depend on which bits are set, so this is exact. Exploring adds or grows held tiles by exactly what it takes off the reserve, rev digits included, so spending the reserve never raises stored size plus reserve, and the check can never trip on exploration's own growth.
- At 200 x 200 a full layer measures about 137 KB with a UUID scene ID and up to about 255 KB with the longest escaped ID the protocol allows (round 6 reviewer measurements).
- Every op's room-size check adds that reserve, and so does the projected-size check of the player scene (the DM's projection carries both layers). Other scenes' explored layers cannot grow, and are measured as they are.
- Every op that changes which scene can explore is checked with the new reserve in place of the old, and refused with `quota` when it does not fit: moving players to another scene, turning vision or fog on for the player scene, and a room import. Only the DM does any of these, so the DM sees the refusal: "The room is too full for the party to explore that scene. Turn vision off there, or delete unused scenes to free space." Both ways out work at once. Turning vision off removes that scene's reserve, so the move goes through. Deleting a scene shrinks the room state with everything on it. Images do not help: they count toward the room's storage quota, not the 8 MiB room state (design.md 10.5), so the message does not name them.
- So explore only spends reserved space, and a room never passes 8 MiB. An export of a room whose layers are full is within the limit, and its import passes, since the import gives scenes UUID IDs, the length clients already make them. Only a hand-made op can give a scene a shorter ID, and the import then refuses with the usual message rather than storing an oversized room.
- A test runs this at a reduced room limit: an ordinary op refused once the reserve would not fit, explore filling the layer without a refusal while revs cross digit boundaries (9 to 10 and 99 to 100), an ordinary size-neutral move accepted right after the layer fills at each boundary, the room staying within the limit, moving players to a scene whose reserve does not fit refused with the message, and turning vision off there letting the move through, and the export and import round trip.

Room state grows too: a 200 x 200 import adds up to about 0.5 MB, and the 8 MiB room limit refuses imports past it with its usual message.

### 2.5 Export and import

`room.json` carries the new collections and fields as they are stored, the explored layer included. The import (design.md 16.4) additionally remaps stamps' asset references, every phase's asset ID and each scene's thumbnail asset ID, and gives lights and stamps new IDs. Free wall IDs are local to their chunk and keep. A reference to an image that did not come through is dropped: a stamp with it goes, and a phase with it goes (the scene switches to its first remaining phase). Thumbnails are assets of a new kind, `thumb` (section 3.3), so they travel and count like any other asset. The import schema applies the new limits, the free wall length included.

## 3. Wave 3: maps

### 3.1 Universal VTT import

**The format.** Dungeondraft, Dungeon Alchemist and DungeonFog export one JSON file (`.dd2vtt`, `.uvtt`, `.df2vtt`, the same format under three names) holding the map image as base64 and its grid, walls, doors and lights. From Arkenforge's description of the format, checked against the most used open importer (Foundry's Universal Battlemap Importer, `ddimport.js`, MIT), the keys are:

```ts
format: number                          // a version, which importers do not check
resolution: { map_origin: {x, y}, map_size: {x, y}, pixels_per_grid: number }   // origin and size in squares
line_of_sight: {x, y}[][]               // wall polylines, in squares
objects_line_of_sight: {x, y}[][]       // polylines around objects that block sight (not in every file)
portals: { position: {x, y}, bounds: [{x, y}, {x, y}], rotation: number,   // radians
           closed: boolean, freestanding: boolean }[]
environment: { baked_lighting: boolean, ambient_light: string }            // a hex color
lights: { position: {x, y}, range: number, intensity: number, color: string, shadows: boolean }[]
image: string                           // base64 PNG or WebP (the importer also detects JPEG)
```

All positions and sizes are in squares except `pixels_per_grid`. Section 10 lists the sources and what could not be verified.

**DM behavior.** Scenes panel, New scene, "From a Universal VTT file". On a computer the file picker accepts the three extensions. The dialog shows "Reading the file…" (the shared loading notice, design.md 14.1) while a worker parses it, then a summary sheet:

- A preview, the name from the file name, and the size ("30 x 20 squares").
- What it found: "412 walls (380 on the grid, 32 free), 14 doors, 3 windows, 9 lights."
- "Objects block sight and movement" (on), for `objects_line_of_sight`.
- "Portals that don't block light import as": Windows (default) or Open doors (question 8).
- "Start under fog" (on), as for any scene made from a map.
- Create scene, which shows "Uploading the map…" with progress, then "Adding walls…", then opens the scene. When the dialog was opened from a scene's phases (section 3.4), "Add as a phase of Crypt" takes only the image.

Plain errors: "This file has no map image.", "This map is 260 squares wide. Scenes can be at most 200.", "This is not a Universal VTT map file.", "This file is 90 MB. On a phone, import files up to 40 MB, or import it on a computer.", and "This map's image is 12,800 by 12,800 pixels, too large for a phone to resize. Import it on a computer." Players never see any of it.

**Where it runs.** The DM's browser parses the file in a Web Worker and turns it into an image upload plus ordinary ops. The server never parses the file.

- The file is the DM's own and untrusted. Everything it becomes is either an image that goes through the server's sharp pipeline (design.md 11.1) or an op the server checks with its zod schema and limits. A hostile file can only hurt the DM's own tab.
- A server-side parse would hold a 50 to 150 MB JSON string on the server's one event loop, which every room shares, and block it while parsing.
- iOS cannot draw a canvas over 16,777,216 pixels, so a phone cannot downscale a large export, and a large file may not fit a phone tab's memory at all. So a phone checks the file's size before reading it. A DM imports on a computer, which the DM normally does when preparing.

**Steps.**

1. **Read and check.** At most 150 MB on a computer and 40 MB on a phone, checked from `File.size` before reading. A zod schema for the subset above, with bounds: at most 20,000 polylines, 200,000 points in all, 2,000 portals and 500 lights, and every coordinate finite and within one square of the map. Unknown keys are ignored. A missing optional key reads as empty.
2. **Image.** Decode the base64 in the worker and detect the type from its magic bytes (PNG, WebP, JPEG). If it is at most 8,192 px on its long side and at most 32 MiB, upload the bytes as they are. Otherwise downscale to 8,192 px and re-encode: WebP where the browser can encode it, JPEG at quality 0.92 on Safari, which cannot encode WebP from a canvas. The server makes its variants as for any map, so its `full` variant is the canonical size (design.md 5).
3. **Grid and coordinates.** The canonical `cellPx` is `pixels_per_grid` times the canonical width over the file's image width. The file's grid intersections are at whole numbers. Per axis, world = file - floor(map_origin), so world 0 is the grid line at or before the image's start and every coordinate inside the image is at least 0. The image then starts at world `f = m - floor(m)`, which is never negative, even for a negative origin, and `originPx` is `-f * cellPx`, which the protocol allows (it accepts any `originPx` from -100,000 to 100,000). The leading partial cell, from world 0 to `f`, is part of the scene with no image over it. The scene bounds are `ceil(f + map_size)` per axis, and a map over 200 squares a side is refused. Walls, portals and lights all use this one transform. Geometry that falls outside the scene after it (the schema allows one square of slack) is clipped to the scene, and the summary says so.
4. **Walls.** Each polyline is simplified: points closer than 0.1 square merged, then Douglas-Peucker at 0.05 square, then coordinates snapped to 1/64. Wall ends within 0.1 square of another polyline's end are welded onto that end, and ends within 0.1 square of another wall's middle are welded onto it, with that wall split at the shared lattice point, so a snapped export never leaves a hairline gap a creature's center could slip through. The summary reports how many ends were welded. A segment whose ends both lie within 0.1 square of grid intersections on one grid line becomes edge walls, one per cell edge it covers. Every other segment becomes a free wall. A free wall longer than 8 squares is cut into `ceil(length / (8 - 1/32))` equal parts, each new end snapped to 1/64, so every stored end stays on the lattice. Snapping moves an end by at most 1/128 per axis, which the 1/32 margin covers, but the cut is checked anyway: if any part is still longer than 8 squares, the count goes up by one and the wall is cut again, until every stored part is at most 8. Stored free walls are these snapped originals, never split where they cross: a crossing point need not lie on the 1/64 lattice, so crossings are split only in the derived set (section 2.1). The summary's counts come from running the counting pass of section 2.1 on what would be stored. If the free walls number over 4,000, simplification repeats at 0.1 and 0.2 squares. Past that, or over the split's caps, the import is refused with the counts.
5. **Edges on the map's border.** A 20 x 20 map's east wall becomes edges such as `20,0,w`, and its south wall `0,20,n`. Today `buildEdge` validates an edge as a cell, so it refuses those. Wave 3 validates an edge as an edge: a west edge `x,y,w` needs `0 <= x <= width` and `0 <= y < height`, and a north edge `x,y,n` needs `0 <= x < width` and `0 <= y <= height`. The builder can then draw a scene's east and south border as well. Tests cover all four borders and a fractional origin.
6. **Doors.** Each portal's `bounds` is its segment. `closed: true` becomes a closed door, on edges when it aligns (a wide door becomes one door per edge, as the builder's drag makes them) and free otherwise. `closed: false` is Dungeondraft's "block light" switch turned off (the Foundry importer's own hint says so), which marks a window, so it imports as a window unless the DM chose Open doors. Wall segments that overlap a portal's segment are cut back exactly to the portal's ends, so a door never sits on top of a wall that would keep it shut, and no gap opens beside it. `freestanding` needs nothing special. `position` and `rotation` are not needed.
7. **Lights.** Each light inside the map, placed by step 3's transform, becomes a free light (section 3.6): bright radius `range / 2` squares and dim `range / 2` beyond it, as the Foundry importer reads `range`, converted to feet at the room's scale and capped at 120 ft each. `color` keeps its last six hex digits. `shadows: false` stores a light that walls do not block. `intensity` is not used. Every light's position, after the transform, is snapped to the 1/64 lattice that section 3.6 requires. A light then within 0.05 square of a sight segment (a wall-mounted torch) moves 0.1 square off it, to the side from which it lights the larger area, since a light on a wall line would otherwise light both sides, and is snapped to the lattice again and checked against the walls once more. Anything left near a wall is handled by sight's own step (section 4.3.2). More than 100 lights keeps the 100 with the largest range, and the summary says how many were left out.
8. **Ops.** `scene.create` with the map, the grid and `autoWalls: 'off'`, then `build.edge` (500 edges per op), `build.walls` and `build.lights`, each batched under 48 KiB, every op of the import in one undo group. "Start under fog" is the usual new-scene fog. The ops queue like any other, so a dropped connection resends them. The dialog says "Keep this page open until the walls are added" while they are pending.

**Model.** Nothing new beyond free walls (section 2.2), lights (section 3.6), `autoWalls` (section 2.1) and edge validation (step 5). The import is a client feature built on existing and wave 3 ops.

**Permissions.** DM only, as are the ops it sends.

**Projection.** Walls and doors project as builder walls do, secret handling included. Universal VTT has no secret doors, so imported doors are all plain. Lights are DM only.

**Undo.** The import's ops share one undo group, so one undo takes the whole scene back. That is at most one scene, 169 chunks and 100 lights, under the 5,000-entry restore cap (design.md 7.7). The DM can also delete the scene.

**Performance.** Parsing runs in a worker under the loading notice, so a large file never freezes the page. Its time was not measured. Areas of effect clip against the imported walls at once, since free walls join the area set.

**Out of scope.** Exporting Universal VTT files. Stitching several files into one scene (the Foundry importer does it). Multiple floors. Animated maps. Drawing free walls by hand: the DM fixes an import with edge walls, the eraser and the door states. "Reveal room" stays a builder tool: it floods built floor cells (`floodRoom`), and an imported map has none, so it does nothing there, and the fog tools' hint says so. Ambient light from `environment` is read only by wave 4 (section 4.3.8).

### 3.2 Duplicate a scene

**DM behavior.** A scene's menu in the Scenes panel offers Duplicate. A sheet asks what to copy. Its Duplicate button reads "Duplicating…" and ignores a second tap until the server answers. Then the copy, "<name> (copy)", opens right after the original, in the same folder, under the scene loading notice (design.md 14.7). The options and their defaults:

- The map, its phases, the build, labels, stamps and lights: always.
- Monsters, NPCs and objects: on.
- Player characters: off. A PC token on the copy would point at the same character, which is allowed, but the DM usually brings the party over by moving players.
- Fog: off, so the copy starts fully fogged like any new map scene. On copies the fog as it is, the party's explored layer included.
- Drawings and placed areas: off.

**Model.** One op, `scene.duplicate { sceneId, newSceneId, name, include: { creatures, characters, fog, drawings } }`. The reducer copies everything in one step.

- New IDs for copied entities are derived, never sent, because an op carrying thousands of IDs would pass the 64 KiB frame limit. Each is the 128-bit hash (`hash128` in shared/project.ts) of the new scene ID and the old ID, formatted as a UUID. A collision with an existing ID refuses the op.
- Encounter rows and paths are not copied. So a copy's `fogExemptAuto` is cleared: that flag belongs to the original's fight, and nothing would ever clear it on the copy.
- Effect durations on a copied creature's own actor are re-anchored to the copied token and paused, keeping what remains. Otherwise advancing the original's fight would tick the copy's effects, since every actor in the room ticks against its anchor (encounter.ts). A PC token shares its character's effects on purpose, so those stay as they are.
- A kept ruler's anchors follow the copied tokens, or become free stops when their token was not copied. Areas attached to a token are copied only with drawings and areas on. A copied area's `casterId` follows the copied caster, or is removed when the caster was not copied.

**Permissions.** DM. Limits as for any scene: the 50 scenes per room and the 8 MiB room state, refused with `quota`.

**Projection.** The copy is a DM scene like any other until it becomes the player scene.

**Undo.** The inverse removes the scene and everything copied. The largest possible copy is about 4,240 entities, under the 5,000-entry restore cap.

**Performance.** One op, bounded by one scene's limits. Its `ev` reaches only DMs, as scene list metadata.

**Out of scope.** Copying a scene into another room.

### 3.3 Scene folders and thumbnails

**DM behavior.** The Scenes panel groups scenes under folder headers, each a 44 px row that collapses with a tap. Collapsed folders are remembered on this device (local storage, wrapped in try and catch). Scenes without a folder sit at the top. A scene's menu offers "Move to folder", a list of the existing folders plus "New folder…". Renaming a folder from its header renames it on every scene in it as one undo step. A folder sits where its first scene is in the scene order, and reordering scenes works as today. Each row shows a thumbnail, 64 px tall, with the player scene marked as now.

**Thumbnails.** A DM device renders them. The DM's projection holds only the scene in view (design.md 7.3), so no device can draw another scene's build on demand.

- The renderer is the map export's (design.md 12): background, the active phase's image, build and stamps, never tokens, drawings or fog, at most 320 px on its long side, as WebP (JPEG on Safari).
- It runs when the DM leaves a scene that this device changed since its last thumbnail, and from "Update thumbnail" in the scene's menu. An automatic one uploads in the background with `PUT /api/rooms/:id/assets?kind=thumb`, then sends `scene.update { thumb }`. A failure is silent and tried again next time, since nobody waits on it. "Update thumbnail" is a wait the DM asked for, so it reads "Updating…" until done and says so if it fails.
- Until a scene has one, its row shows the map's own `thumb` variant, or a swatch of the background color for a blank mat.

**Model.** `Scene.folder?: string` and `Scene.thumb?: AssetId`, both set with `scene.update`. The `assets.kind` check gains `'thumb'` (an idempotent `alter table` in `db/schema.sql`). A `thumb` asset is DM only to upload and to read, with one variant, `full`, at most 320 px on its long side. `scene.update { thumb }` must name a `thumb` asset of this room.

**Projection.** Scene projection for players becomes an allowlist, because today it sends the player scene whole. Players get `id`, `name`, `bounds`, `map`, `grid`, `background`, `fogEnabled`, `defaultView`, `autoWalls`, and in wave 4 `blockMovement` and `vision`, with `rev`, `order` and `wallsVersion` sent as 0 (the live play review after wave 3: a counter that moves on hidden edits, such as a secret door's state, would tell players something changed). `folder`, `thumb`, `phases`, `phaseId` and `phaseGrid` are DM only. Thumbnails never enter a player's visible-asset set.

**Undo.** Moving a scene to a folder and renaming a folder undo like any scene edit. A thumbnail is bookkeeping, like the walls version: `guardHash` leaves `thumb` out of a scene's guard, and a restore of a scene keeps the scene's current `thumb`. So a background thumbnail that lands between a rename and its undo never makes the undo refuse, and an undo never puts back a stale picture. `scene.update` with only `thumb` is left off the DM's undo stack.

**Performance.** About 15 to 30 KB per thumbnail, re-rendered only after edits. Old thumbnails stay as unused assets until the v1 asset cleanup (features 18) removes them, and they count against the room's quota meanwhile.

**Out of scope.** Thumbnails for players. Nested folders.

### 3.4 Map phases

**DM behavior.** A scene's settings gain a Phases list: the current image is the first phase, named "Day" by default. "Add a phase" takes an image upload or a Universal VTT file (image only). Each phase can be renamed, reordered and removed. A row of phase chips in the scene's settings, and on a computer a Phase menu in the top bar, switches phases with one tap. No confirmation: the DM prepared it, and the switch is the point. Tokens, fog, the build, drawings and areas stay exactly where they are, since they are in cells.

**Player behavior.** The map changes. The old image stays on screen until the new one is decoded, then swaps, so nothing flashes. A slow phone shows the scene loading notice's map stage after 200 ms ("Changing the map…"), as design.md 14.7 does for a first map.

**Model.**

```ts
Scene.phases?: MapPhase[]     // DM only, at most 8, the active one included
Scene.phaseId?: string
Scene.phaseGrid?: { refWidthPx: number, refHeightPx: number, cellPx: number, originPx: { x, y } }   // the grid in reference pixels
type MapPhase = { id, name, assetId, widthPx, heightPx, light?: 'bright' | 'dim' | 'dark' }   // light: wave 4
```

- `Scene.map` stays the active image, so the map layer, projection, the visible-asset set and the export need no change.
- A phase's asset must be a `map` asset of this room. The server fills its `widthPx` and `heightPx` from the asset row, as `withAssetSizes` (actor.ts) already does for `scene.setMap`, so a client never decides a canonical size.
- **One calibration reference, independent of the list.** The grid is kept once, in `phaseGrid`, measured in a reference image size (`refWidthPx` by `refHeightPx`) that is a pair of stored numbers, not a pointer to any phase. It is set when the scene first gets phases, from the image it had then. Reordering, replacing or removing phases never changes it, so no rebase is needed: the grid is the same world rectangle whatever image wears it. A restore puts back the scene as one entity, `phaseGrid` with its phases, so undo is atomic.
- `scene.setPhase { sceneId, phaseId }` copies the phase's image into `map` and sets `map.cellPx` and `map.originPx` to `phaseGrid`'s values times the phase's `widthPx` over `refWidthPx`: one multiplication from the stored reference, never a chain of ratios. `scene.setGrid` on a scene with phases converts the new grid into reference pixels by the active image's width over `refWidthPx`.
- Every phase must have the reference's shape: its height computed from its width at the reference's aspect ratio must be within 1 px of its actual height. A tolerance in pixels follows the rounding of the canonical sizes, which a percentage does not. An image that fails is refused at "Add a phase" or on a replace: "This image is not the same shape as the map, so the grid would not line up."
- A phase whose scaled `cellPx` would fall below 1, the protocol's minimum, is refused at "Add a phase" ("This image is too small for the map's grid."), and `scene.setGrid` refuses a grid that would put any phase below 1. So every stored calibration stays valid and every backup imports.
- Phases are edited with `scene.update { phases }`, the whole list at once (it is small). Removing the active phase switches to the first remaining one. Removing the last phase is `scene.setMap` with null, which clears every phase and `phaseGrid`.
- `scene.setMap` on a scene with phases replaces the active phase's image and must keep the reference's shape.
- Tests: reorder, replace and remove the phase the reference came from, then switch, and undo each, with the grid on the same cells every time.
- Wave 4: a phase may carry a light level, which `setPhase` applies to the scene's vision (section 4.3.8), so switching to Night can also make the scene dark.

**Permissions.** DM.

**Projection.** Players receive `map`, which is the active phase. `phases`, `phaseId` and `phaseGrid` are DM only, so neither the other images nor their names ("On fire") reach a player, and the other images are not in their visible-asset set. So a player's device cannot fetch the next phase ahead of time. That costs a player on a slower connection about a second of download on the switch, and the old image stays up meanwhile.

**Undo.** A switch undoes as a scene edit, putting the earlier phase back.

**Performance.** A DM device preloads every phase's mobile variant when the DM opens the scene, so the DM's own switches are instant.

**Out of scope.** Cross-fades. Phases with their own walls or lights. Scheduled phase changes.

### 3.5 Stamps

**DM behavior.** The builder gains a Stamp mode.

- A picker sheet (a grid of 56 px tiles, each with its name, and a search box) lists the shipped art and, under "This room's images", the room's library.
- A tap on the map places the chosen stamp centered on the tap, snapped to half cells: shipped art at its catalog footprint, a room image one cell across on its long side.
- The placed stamp is selected, with a 44 px rotate handle (snapping to 15°, free with a switch), a corner handle to resize (keeping its shape), a row of 8 tint swatches plus None, Flip, Bring to front, Duplicate, and Delete (red, a second tap to confirm, design.md 14.4).
- A drag moves a stamp. A tap elsewhere places another. Undo and redo in the builder's bar take back one gesture each.
- Erase takes stamps whose center is in an erased cell, and Clear takes them all.

**Player behavior.** Players see stamps as part of the map, below walls, doors, labels and tokens.

**Art** (the project owner, 2026-10-14, question 6). The art rule holds: no AI-generated art, only openly licensed art, credited. The project owner chose the top-down look of Prime_8's trees: pictures seen from straight above, in color, with a soft shadow. The shipped set:

| Source | Author | License | Used for |
| --- | --- | --- | --- |
| [Trees Top-down fake shadow](https://opengameart.org/content/trees-top-down-fake-shadow) | Prime_8 | CC0 | trees |
| [Simple stones](https://opengameart.org/content/simple-stones) | Prime_8 | CC0 | stones |
| [Top down foliage collection](https://opengameart.org/content/top-down-foliage-collection) | Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | CC BY 3.0 | bushes, plants |
| [Top down village elements](https://opengameart.org/content/top-down-village-elements) | the same, submitted by Liosan | CC BY 3.0 | bonfires, wood stacks, a wheel, a bucket |
| Poly Haven 3D models, rendered straight down | each model's authors, below | CC0 | furniture and the rest |

The Poly Haven models, each at `https://polyhaven.com/a/<id>`: barrel `wine_barrel_01` (James Ray Cock), chest `treasure_chest` (Rico Cilliers), crate `wooden_crate_01` (James Ray Cock), table `WoodenTable_01` (Ethan Place), round table `round_wooden_table_01` (Ulan Cabanilla), bed `GothicBed_01` (Kirill Sannikov), bookshelf `wooden_bookshelf_worn` (Ulan Cabanilla), fire pit `stone_fire_pit` (Sebastian Platen), rocks `rock_moss_set_01` (Kless Gyzen) and `namaqualand_boulders_01` (Greg Zaal, photography, and Jenelle van Heerden, modeling), and a young pine `fir_sapling` (Rob Tuytel, photography, and Rico Cilliers, modeling). Poly Haven's license page (https://polyhaven.com/license) says every asset is CC0, and the project owner approved rendering them. No throne or altar ships in v1: the DM stamps a library image for those.

**The build** is a committed script, `scripts/stamps.ts`, like `scripts/textures.ts` and `scripts/icons.ts`, never hand-made images:

- **Fetch and pin.** It fetches each original from where its author published it and checks it against a pinned SHA-256, so a changed upstream file fails loudly: the OpenGameArt downloads, and each Poly Haven model's glTF with its 1k textures. Prime_8's trees ship only as a 7-Zip archive (`trees_192rez_topDown_png.7z`), which the zip reader the textures script uses cannot open, so part 3F adds `7zip-bin@5.2.0` as a pinned dev dependency to extract it. It is MIT licensed and wraps a prebuilt 7za, which is LGPL, used only by this build script and never shipped. "Simple stones" ships as a zip (`SM_set.zip`) and goes through `yauzl` (3.4.0, already a dependency) like the textures. The script pins the SHA-256 of each archive and of each sprite it takes from one.
- **Sprites.** Sprites from the OpenGameArt packs are taken by name, trimmed to their opaque pixels with sharp, and re-encoded as WebP. Each one's footprint in cells is set by hand in the script.
- **Renders.** Each Poly Haven model is rendered straight down with an orthographic camera and a fixed light, with a soft baked shadow like Prime_8's, by three.js in headless Chromium through playwright-core (already a dev dependency). The script launches the installed Chrome (`channel: 'chrome'`, as the e2e tests launch it) headless with `--use-angle=swiftshader` and `--enable-unsafe-swiftshader`, so it renders in software without the machine's GPU. three.js is pinned as the dev dependency `three@0.160.0` (r160, the version the owner's prototype renderer used), which part 3F adds.
- **Footprints from the models.** A model's footprint in cells is its width and depth in metres over 1.524 (5 ft per cell), rounded to the nearest quarter cell and at least a quarter: a barrel of about 0.74 m is 0.5 cell, a crate of 0.83 m 0.5, a table 1.8 m long 1.25, a bed of 1.5 by 2.0 m 1 by 1.25. A set holds several meshes, each rendered on its own as its own stamp, and the script names the ones it takes: for example two rocks of `rock_moss_set_01` (about 8 by 7 m as a whole), the boulders of `namaqualand_boulders_01`, and one sapling of `fir_sapling`.
- **Outputs are committed.** The script writes `public/stamps/<key>.webp`, at most 512 px on the long side, and the stamps' keys and footprints into `shared/stamps.ts`. The outputs are committed, so a later run need not match them bit for bit: a re-render that changes a pixel is reviewed like any other image change.
- **Credits.** `CREDITS.md` and `shared/credits.ts` list each file with its source, author, license and what changed. The CC BY works are also credited on the About page, linking the license (https://creativecommons.org/licenses/by/3.0/) and saying "cropped and converted to WebP", and the renders say "rendered from above and converted to WebP". The credits test (`shared/credits.test.ts`) extends to `public/stamps/`.

The art is in color, so a tint multiplies a color into it as a cast (autumn leaves, a burnt table), and None draws it as made.

**The DM's own images.** A stamp can also use any `token` asset in the room's library, which covers anything the shipped set lacks (question 7). The DM can upload or search for a throne or an altar as for a token. The app ships none of it, so licensing is the DM's own matter, exactly as for token images today.

**Model.**

```ts
type Stamp = { id, rev, sceneId,
  art: { key: string } | { assetId: AssetId },   // key: a slug, /^[a-z0-9-]{1,40}$/, drawn from /stamps/<key>.webp
  x, y,                    // center, cells
  w, h,                    // cells, 0.25 to 20
  rotation,                // degrees, clockwise from east
  tint?: string,           // a color, multiplied into the art
  flip?: boolean, z: number,
  visibility: 'all' | 'dm' }
```

The op is `build.stamps { sceneId, put?: Stamp[], remove?: StampId[] }`, at most 100 per op. A key the client does not know draws as a dashed box, so a renamed stamp never breaks a scene. Keys are slugs, never paths.

**Permissions.** DM. An `assetId` must be a `token` asset of this room (design.md 8.2).

**Projection.** Stamps on the viewer's scene. Removed for players when `visibility` is `'dm'`, or when the scene has fog and every cell under the stamp's rotated bounding box is fully fogged, the rule labels use (design.md 13.4). So a chest in an unexplored room is not in a player's data. A stamp's asset joins the player's visible-asset set while the stamp is in their projection. The map export's player view leaves out the same stamps.

**Undo.** Per gesture, as for labels.

**Performance.** Each distinct art, tint and size bucket is drawn once into a small offscreen canvas and reused, so 500 stamps cost 500 image draws on a board redraw, a few milliseconds on a phone, and the board redraws only on change (design.md 12).

**Out of scope.** Stamps that block movement or sight (walls and pillars do that). Animated stamps. Snapping stamps to walls.

### 3.6 Lights (stored in wave 3, used in wave 4)

Universal VTT files carry lights, and dropping them would mean asking the DM to place them again in wave 4. So wave 3 stores them and shows them to the DM.

```ts
type Light = { id, rev, sceneId, x, y,     // cells
  bright: number, dim: number,             // ft: bright radius, and dim light for this many feet beyond it, each at most 120
  color?: string,                          // stored, not drawn in v1
  on: boolean,
  walls: boolean,                          // walls cast shadows from it (Universal VTT "shadows")
  label?: string }
```

The SRD's wording "Bright Light in a 20-foot radius and Dim Light for an additional 20 feet" is `{ bright: 20, dim: 20 }`, so the SRD's light sources read straight across: Candle 5/5, Torch 20/20, Lamp 15/30, Hooded Lantern 30/30, the Light cantrip 20/20, Daylight 60/60. The Bullseye Lantern lights a cone, which v1 does not model.

- The op is `build.lights { sceneId, put?: Light[], remove?: LightId[] }`, DM only, at most 100 per op and 100 per scene.
- Wave 3 draws each light as a small sun icon for the DM, with its radii as faint rings while selected, and the builder's erase and clear take them. Placing and editing lights by hand is wave 4 (section 4.3.8).
- A free light sits 5 ft above the ground under it (section 4.2). Its position is stored on the 1/64 lattice, checked by the protocol as free walls are, so sight's on-wall test stays exact (section 4.3.2).
- Lights are DM only in every wave. Players never receive the collection. In wave 4 they see only light's effect (section 4.3).

### 3.7 Wave 3 build split

One part lands first, because the others build against it. The rest run in parallel jj workspaces with the ownership shown. Shared registry files (tools, layers, panels) get one-line additions only.

| Part | Owns | Depends on |
| --- | --- | --- |
| **3A Contract and core** | `shared/model.ts`, `shared/protocol.ts`, `shared/keys.ts`, `shared/limits.ts`, `shared/migrate.ts` (snapshot 6), `shared/reducer/*` (duplicate, setPhase, phases, build.walls, build.stamps, build.lights, edges validated as edges, erase and clear of the new things), `shared/reducer/tx.ts` (`thumb` out of scene guards, `autoWalls` setting `global` and bumping the walls version), `shared/permissions.ts`, `shared/limits.ts` and the actor's limits step (the split's counting pass on every op that writes geometry), `shared/project.ts` (scene allowlist, stamps, lights, free walls sorted, secret doors by the scene's `autoWalls` rule), `shared/reads.ts`, `server/rooms/actor.ts` (phase asset sizes), `server/rooms/importRoom.ts` and the export remaps, the `thumb` asset kind in `db/schema.sql` and `server/assets/*`. Tests for each. | nothing |
| **3B Free walls in the rules** | `package.json` and `pnpm-lock.yaml` (`robust-predicates@3.0.3` pinned as a dependency), `shared/rules/segments.ts` (the exact orientation predicate's wrapper, the exact split, its counting pass and caps, sweep-box clipping, `indexPolygon` and `crossingsAt` moved here), `shared/rules/walls.ts` (free segments, the three `autoWalls` rules, identity-keyed caches with `autoWalls` and bounds in the key), `client/features/areas/coverage.ts` (its key follows the walls version, which `autoWalls` now bumps), tests including the ray-cast oracle and areas clipped by crossing free walls, and the geometry rows of the wave 3 gate (section 4.3.6). | 3A types |
| **3C Universal VTT import** | `client/features/uvtt/*` (worker, schema, simplify, snap and split, image step, byte-bounded op batching, dialog), one line in the Scenes panel. Tests use synthetic files written for them, never a third-party map. | 3A, 3B |
| **3D Scenes panel** | `client/features/scenes/*` (duplicate sheet, folders, thumbnail render and upload). | 3A |
| **3E Map phases** | `client/features/phases/*`, the map layer's keep-until-decoded swap in `client/canvas/layers/MapLayer.tsx`. | 3A |
| **3F Stamps** | `scripts/stamps.ts` (fetch, pin, extract, cut, trim, render the Poly Haven models straight down, encode), `public/stamps/*.webp`, `shared/stamps.ts` (keys and footprints), `package.json` and `pnpm-lock.yaml` (`three@0.160.0` and a 7-Zip extractor pinned as dev dependencies), `CREDITS.md`, `shared/credits.ts`, `client/features/builder/stamps/*`, one-line registrations in the builder's store, options and tool. | 3A |
| **3G Free walls and lights in the builder** | `client/features/builder/draw.ts`, `BuilderLayer.tsx`, `cells.ts` (drawing free walls and doors, erase, tapping a free door through its states, light icons, the border edges). | 3A, 3B |
| **3H Integration** | e2e: import a synthetic file, duplicate, switch a phase with a player connected. `docs/design.md` and `docs/features.md` updated from this file. | all |

## 4. Wave 4: walls, height, vision and light

### 4.1 Walls and doors block movement

**DM behavior.** A scene setting, "Walls and ledges block players' moves" (`blockMovement`), on for new scenes and off for existing ones (question 4). The DM's own moves are never blocked. In play, with the Select tool, a tap on a door shows a pill above it: Open or Close, Lock or Unlock, and for a secret door Mark found or Hide. The builder's Door mode keeps working as today.

**Player behavior (phone first).**

- While dragging a token, the shared rule tests the leg from where the token stands to the finger. Where it is blocked, the preview stops at the last spot before the wall or ledge where the rule below lets the token stand, its outline turns red, and the label reads "Wall in the way" or "Ledge in the way". Dropping lands the token on that last clear spot, so a drag into a wall never bounces. Each drop is a leg (wave 2), so going around a corner is two drops.
- The note after a stopped drop says what stopped it: "Stopped at a wall. Drop at the corner first, then go on.", "Ledge in the way. Take the stairs.", or, when the blocker is a door the player sees as a door, "A door is in the way. Tap it to open." Beside it, a faint ghost of the token marks the spot the player dropped it on.
- **"Teleport here"** (the project owner, 2026-10-14), on the same note, for Misty Step and anything else that passes walls or ledges. The SRD says teleportation spends no movement, so it replaces the walk to the wall rather than adding to it. A tap, while the button reads "Teleporting…":
  1. If the drop was stopped at its very first step, no move was sent, and there is nothing to take back: the client sends the teleport straight away from where the token stands, with no note.
  2. Otherwise the client sends `undo` with `of` naming the stopped move, exactly as the action bar's "Undo move" does (design.md 7.7), and waits for the server's answer. `of` names only that move, so it never takes back an older one.
  3. If the undo applied, it sends `token.move` with `teleport` from where the undo put the token (where the walk began) to the ghost's spot. The path holds one leg from the start, uncounted. The landing spot follows the drop rule of Squeezing below: a Large creature teleported into a 5 ft corridor lands on the half-cell spot where it fits, with `squeeze` set, rather than full size across the walls.
  4. If the undo was refused (the token was moved since, or the walk is no longer this player's newest change), it still sends the teleport, from where the token stands, and says so: "Could not take back the walk to the wall, so it still counts."
  5. If the undo applied but the teleport is then refused (the token was locked meanwhile, or the player may no longer move it), it says so: "Teleport refused: the token is locked. The walk was taken back."
  6. The DM gets a note: a DM-only log line ("Thorn teleported past a wall", or "past a ledge"), which the DM's devices also show as a short toast.
- Climbing a ledge stays the DM's move. A player whose creature climbs or jumps asks the DM, who moves it.
- A door has a 44 px tap zone around its middle (design.md 14.4). A token under the finger wins. A tap on a door the player can see shows the pill: Open or Close. A player's token action bar also offers "Open door" or "Close door" while a door is within reach of that token, so a door never has to be hit exactly.
- **Reach** (the owner's choice after the build, following the recommendation of question 5, which the project owner kept on 2026-10-14) is 5 ft or one cell, whichever is more, by the room's own distance rule, as its ruler measures (`legFeet` in distance.ts, at the room's scale), so a creature on a cell beside the door always reaches it, whatever the feet per cell. It is measured in three dimensions, as the ruler measures: from the token's footprint and height to either cell beside the door (for a free door, the cells on each side of its midpoint), at the ground there. So under "every diagonal 5 ft" a token diagonally next to that cell reaches, and under true distance it does not, and a token flying 30 ft up does not reach a door on the ground. A straight line from the footprint's center to the door's midpoint must also cross no movement blocker other than the door itself. Otherwise: "Too far from the door." A locked door answers "It's locked." That is how players learn about locks (design.md 7.3). A second tap closes the door again, so the door needs no undo.
- A player who may move other tokens (`playersMoveAny`) is blocked the same way when moving them.

**The rule** (`shared/rules/movement.ts`). Here a token's center and footprint mean its footprint at its stored position, where the map draws it. The center is not rounded: every side and touch test uses the exact predicate of section 2.1, so it is exact for any position.

- **The movement set is the stored segments.** The test reads the stored segments (edge walls and doors, stored free walls unsplit, pillar squares, and raised edges for walking tokens), through a per-cell index of them, never the split pieces, whose rounded ends would make "touching" inexact at a junction.
- **The core** is for collision only. A creature fits through an opening sized for a creature one size smaller: SRD 5.2.1 makes such a narrow opening Difficult Terrain, so it can be passed. Per axis, with the footprint's side `w` (or `h`) in cells, the core's side is `max(0, w - 1 - 1/32)`: never negative, never rounded. So a Large creature's core fits a 5 ft opening, a Huge one's 10 ft and a Gargantuan one's 15 ft, one size smaller on the SRD's size table. The core is that rectangle around the center, a segment when one side is 0, and the center point alone when both are (Medium, Small and Tiny creatures, and a custom size of at most 1 1/32 cells a side).
- **A path is clear** when the core, swept along it, touches no segment of the movement set. Touching counts. The one exception is a segment the core already touches where the leg starts (a token the DM placed over a wall, or a center on a free wall): along the path's first straight part, that segment is ignored only while the part moves the center away from the segment's line, toward the side of the line that holds the start center, or toward either side when the start center lies exactly on the line. Moving along the line, or toward the far side, keeps the segment in the test. So a token can step off a wall it overlaps, but never through it: a Large creature centered a quarter cell from a free wall may move away from it and may not move across it.
- **A leg is allowed** when its straight path, from the start center to the end center, is clear. For a creature with a core larger than a point, when the straight path is blocked, the shifted paths start, start + d1, end + d2, end are tried, with `d1` and `d2` each one of the nine shifts of 0 or half a cell on each axis, in a fixed order with no shift first. The leg is allowed when any of them is clear. The shifts let a creature line its core up with an opening whose middle falls half a cell from its snapped centers, as every 5 ft opening does for a Large creature. Because the core touches nothing along the whole path, apart from stepping off a segment it started on, and the path joins the start to the end, the creature never crosses a blocker. No shift can jump a wall: a wall between the start and its shifted point is in the path's first part.

**Squeezing** (the project owner, 2026-10-14, question 12: a Large creature may stop squeezed in a 5 ft corridor, drawn full size over the walls).

- **Squeezed space** is separate from the core and never derived from it. A squeeze shrinks only an axis whose side is at least 2 cells, by one cell, as the SRD's one-size-smaller space does: a Large creature squeezes to 1 x 1, a Huge one to 2 x 2, a Gargantuan one to 3 x 3, and a custom 1 x 3 token to 1 x 2. Any other axis keeps its side. The squeezed footprint is that rectangle centered on the token's stored center, never snapped.
- **When a squeeze is allowed.** A move carrying `squeeze` is accepted, from anyone, only when all four of these hold at its end:
  1. The token has an axis of at least 2 cells.
  2. The squeezed footprint lies on cell boundaries, its edges on whole numbers, which the half-cell placement below produces for any standard size.
  3. It stands in a real narrow space (the owner's rule after the build, 2026-10-14): along an axis the squeeze shrinks, some cross-section of the full footprint, level with the squeezed footprint, meets a movement blocker on each side of the core, inside the full footprint, and none across the core, and no blocker passes through the squeezed footprint. Walls count, and ledges where they would stop the token's leg. So a corridor's walls, at its dead end too, and an open door's frame pinch it, while open ground beside one wall never squeezes, a corridor's outside wall and a closed door in its frame included.
  4. The core touches no blocker.

  `canApply` checks them with the exact predicate, like the wall test, so replay never depends on them, and refuses with `invalid` otherwise. So the flag marks only a real squeeze: a Large creature flush against a room wall, half over one, or standing in the open half a cell off the grid, cannot claim one. A custom size whose squeezed sides are not whole numbers never squeezes, and the DM moves it.
- **Standing in a narrow opening.** A Large creature cannot stand in a 5 ft corridor at a snapped spot, since its snapped center lies on a corridor wall. So when the spot a player or the DM drops a squeezing creature on leaves its core touching a blocker, the client tries the drop's nine half-cell shifts in the same order and keeps the first where the core fits, the leg is allowed and a squeeze is allowed. The token is stored there, half a cell off the grid, with `squeeze` set, and the map draws it full size, overlapping the walls beside it, which shows it squeezing.
- **A squeezed token counts at its squeezed size.** While `squeeze` is set, every rule that reads its footprint uses the squeezed footprint: areas, distances, the ruler, range rings, fog, sight, drag frames and the "seen" marks. It lies on cell boundaries, so design.md 9.1's cell rules (`occupiedRange` and `tokenCellBox`, which floor and ceil) read exactly its cells. A Large creature in a 5 ft corridor is in the corridor's cells, not in the rooms beyond its walls, and a fireball beyond the wall does not list it.
- **The flag is part of the pose.** Wave 2's move undo captures, compares and restores it with the position (`Place`, `Pose`, `samePose` and `putBack` in server/rooms/undo.ts), and a player's restore may set it (`POSE_FIELDS` in shared/permissions.ts). So undoing a move into a corridor takes the squeeze off, and undoing a move out puts it back, while damage dealt meanwhile stays. Any move without the flag clears it, and so does any `token.update` of the token's size, scene or position. Opening a door beside a squeezed creature leaves it squeezed until it next moves.
- **Drag previews.** A drag sends continuous, unsnapped positions, so a preview point is almost never on cell boundaries, and the committed checks would fail. So the server judges a frame's footprint for players' visibility by its own looser rule, whatever the frame says: at the preview point, when the token has an axis of at least 2 cells, its core touches no blocker, and it stands in a narrow space (checks 1, 3 and 4), the frame is judged by the one-size-smaller footprint centered on the preview point, with no cell alignment. Check 3 is judged around the core there, so a preview point a hair off a corridor's middle, whose squeezed footprint overlaps a wall, still counts. Otherwise, the creature dragged in the open or through a wall, the full footprint. So a Large creature dragged along a narrow corridor out of the party's sight, at any fractional point, is withheld, though its full-size preview would reach through the wall into lit ground (section 4.3.5). Cell alignment (check 2) applies only when a move commits `squeeze`. The rule errs toward withholding: a Large creature dragged past a pillar at the edge of sight can vanish from the preview and reappear on the drop. Accepted. The frames carry the dragging client's own state only to draw the preview.
- **Distance moved.** Wave 2 measures each leg of the turn's path with the footprint the token has now, so a leg into or out of a squeeze can read a cell longer or shorter. Accepted: the table sees the path and corrects by eye.
- **What it covers.** Grid-aligned openings (builder walls, and imported doors, which snap to the grid when they align) always line up. An opening off the grid passes when it is at least half a cell wider than the core, since the core then fits at some half-cell shift. A narrower one passes only when the grid happens to line it up, and the DM moves the creature otherwise. A squeezing creature goes straight through an opening: entering one on a slant takes two drops, one to line up and one through.
- **Medium and smaller** creatures keep the center path with no shifts: they pass any opening wider than nothing.
- A group move tests each token's own leg. The client sends only the allowed ones and notes the rest.
- Raised edges are in the movement set for walking tokens (section 4.2), only while `blockMovement` is on.
- The test uses only `+`, `-`, `*`, `/` and comparisons, like the sight code (section 4.3.4), so a phone running it on its drag and the server running it in `canApply` always agree.
- Blocking is a table aid, not an anti-cheat measure. A player can still raise a token's elevation and fly it over a raised edge (section 4.2), and the DM sees the elevation badge.

**Model.**

- `Scene.blockMovement?: boolean`. Absent reads as off. The client's `scene.create` sets it on for new scenes.
- `door.set { sceneId, door: { edge: EdgeKey } | { cx, cy, id }, state: 'open' | 'closed' | 'locked', found?: boolean }`. It writes one door's state in its chunk and bumps the walls version.
- `token.move` gains an optional `squeeze: true`, stored on the token as `Token.squeeze`, part of its pose, and cleared by any move without it and by any `token.update` of size, scene or position (Squeezing, above). Players receive it with the token, since it changes the footprint every rule reads. `dragMove` and `dragEnd` frames may carry it too, for drawing only.
- `token.move` gains an optional `teleport: 'wall' | 'ledge'` (what the client found in the way, used only for the log line's wording). On a move of the active creature during its turn, the reducer adds the leg already marked `uncounted` (wave 2). Outside a turn there is no path to mark. In every case it writes a log event `{ type: 'teleport', tokenId, past: 'wall' | 'ledge' }`, which projection gives to DMs only. The flag is in the stored op, so replay marks the same leg and writes the same line. It is an optional field, so no op version changes.

**Permissions.**

- The DM may `door.set` any door to any state.
- A player may set only `open` or `closed`, never `locked` or `found`, only on something their projection shows as a door (anything else, a secret door not yet found included, answers `gone`, the answer for anything a player cannot see), only when it is not locked ("It's locked."), and only within reach of a token of their own on the scene, by the rule above.
- `canApply` refuses a player's `token.move` or `token.moveMany` whose leg is not allowed on a scene with `blockMovement`, with `forbidden` and "A wall is in the way." or "A ledge is in the way." A secret door not yet found answers as a wall, as players see it, so a refusal never tells it from one.
- A `token.move` with `teleport` skips the wall and ledge test, and nothing else: the player must still be allowed to move that token, and it stays inside the scene. That is table trust, which the project owner chose, with the DM told every time.
- A `token.move` with `squeeze`, from anyone, is refused with `invalid` unless the four checks of Squeezing hold at its end. A player's undo and redo of a move may set or clear the flag with the position, as `POSE_FIELDS` allows.
- The ephemeral channel asks `canApply` whether a sender may drag a token (`server/rooms/ephemeral.ts` builds a `token.move` for it). That question is about rights, not walls, so the wall test stays out of it. The client clamps its own preview frames at the wall anyway.
- An undo of a player's move is never blocked: it retraces a move that was allowed when made. A redo is tested like a new move, except a teleport's (below).

**Projection and secrecy.** Nothing new is sent. The blocking set for players is exactly what their projected build shows. A door's new state reaches players as a chunk change, as every door edit does today.

**Undo.**

- A DM's `door.set` is on the DM's stack as a chunk restore. A player's is not on the player's stack (design.md 7.7 keeps players' stacks to moves and drawings), since a second tap reverses it.
- A teleport is a move, so it goes on the player's stack and "Undo move" takes it back. Its undo step records that it was a teleport, as wave 2's steps record the poses they left. The server-built redo of that step skips the wall and ledge test, as the teleport did, so a teleport can be redone whether or not a fight is on. Undo and redo write no new log line: the DM's line about the teleport stays, and the DM sees the token move.

**Performance.** A leg test walks the cells the swept core covers (at most about 280 cells along a leg) and tests the few segments the per-cell index holds for each. A blocked leg of a squeezing creature tries at most 81 shifted paths of three parts each. Well under 1 ms either way, on the server and during a drag on a phone. The index is built with the derived set (section 2.1).

**Out of scope.** Pathfinding around walls and true walking distance (features 4, Later). The extra cost of a narrow opening or of climbing. Squeezing on a slant through an opening. A teleport's range or line of sight: the table checks the spell. A door log line or a DM notice when a player opens a door: the DM sees the door swing open on the map, and a notice would need a new event, a product choice for later.

### 4.2 Raised areas and stairs

The feature request asked for raised areas "accessed via stairs up to it", with "the depth of the scene" showing that an area is raised, and for stairs that point the way up. This moves features 8's Later item "Painted elevation zones on the map, such as cliffs and balconies" into v1.

**DM behavior.**

- The builder gains a Height mode. A stepper picks a height in 5 ft steps from -20 ft to +30 ft (the model allows -100 to 200), shown as "10 ft up" or "10 ft down". The brush and a dragged rectangle paint it, and height 0 clears it. In Height mode each raised region shows its height as a number. Heights paint over a map image as well as over built floor, so a DM can raise the cliff drawn in a Dungeondraft map.
- Height mode also has a Stairs brush, which marks cells as stairs without painting any terrain, so a stair can be drawn over a map image. On built floor, the Stairs terrain works as today and is a stair too. For automatic walls a stair mark counts as a Stairs cell (section 2.1). Under Around floor only, which scenes made from a map image use, it makes no wall, so a stair drawn over the art is not walled in, and a stair bridging two floors across an unpainted gap is open at both ends. Under Around every painted cell (blank mats, and scenes from before wave 3), a stair mark gets walls toward unpainted cells, as Stairs terrain does there, and the Stairs brush's hint says so.
- A stair points up toward its one neighbor higher than it, so painting stairs between a floor and a platform just works. The Stairs option row offers Auto, North, East, South and West as arrow buttons for the cells the rule cannot settle, and the choice is stored. Cells it still cannot settle show a "?" in Height mode.
- When the DM paints a height under tokens standing on the ground there, they rise or sink with it (below).

**Player behavior.**

- Raised ground looks raised. Higher cells are slightly lighter (4% per 5 ft, at most 20%) and lower ones slightly darker. Each raised region casts a soft shadow down and to the right onto lower ground, offset by its height difference (0.08 cell per 5 ft, at most 0.5), with a pale rim on its upper left edges and a dark line on its lower right ones, as if lit from the top left.
- Stairs show their direction. Five treads run across the up direction, lighter toward the top, with a chevron at the high end. A stair drawn over a map image draws only the treads, translucent, over the art. A stair with no direction draws as today.
- A token on raised ground stands at that height. Its elevation badge shows it ("↑10", design.md 14.4), as the badge reports absolute elevation, and distances and areas count it in 3D as they already do. A creature off the ground is told apart by its shadow (section 4.4).
- A walking token cannot cross an edge between two heights except along a stair. The drag stops there ("Ledge in the way. Take the stairs."). A token higher than the edge's top, flying, crosses it.

**Model.**

```ts
// In BuildChunk (wave 4)
heights?: string   // base64 of 256 little-endian Int16, feet, row-major over the chunk's cells, absent when all 0
up?: string        // 256 characters, row-major: '.' not a stair, 'a' a stair pointing by the rule, 'n' 'e' 's' 'w' a stair pointing that way
```

- `build.height { sceneId, cells, height }` and `build.stairs { sceneId, cells, up: 'a' | 'n' | 'e' | 's' | 'w' | null }`, 2,000 cells per op, DM only. Both bump the walls version, because heights and stairs change movement and sight. Erase clears heights and stair marks in erased cells, and Clear clears them all.
- `ground(x, y)` is the cell's height, 0 when absent. A footprint's ground is the highest ground under it.
- A cell is a stair when its terrain is Stairs or its `up` mark is not `.`. Its direction, in order: an explicit `n`, `e`, `s` or `w`. Otherwise its one orthogonal neighbor with higher ground, if exactly one. Otherwise, repeating until nothing changes, the direction of the one adjacent directed stair that lies straight up or down its line (a stair run passes its direction down to the cells below it). A stair with none of these, or with conflicting neighbors, has no direction. The passes are bounded by the number of stairs and run in a fixed order, so the answer is the same everywhere.
- A raised edge is an edge between two cells of different ground. A directed stair connects the edges on its up side and its down side, whatever the heights. Its two side edges, and every edge of an undirected stair, are ordinary.
- A height paint lifts or lowers every token on that scene that was standing on the ground there (elevation equal to its old ground) to the new ground, in the same op, so nobody ends up inside a ledge. The reducer does it, bounded by 500 tokens. The lift is not a move, so it adds no leg to a path (wave 2).

**Where a token stands.** A token is on the ground when its elevation equals the ground under it, flying when above, and inside the ground when below. Inside the ground is legitimate: features 8 says "Negative values work for burrowing", so no rule ever raises a token's elevation on its own.

- Landings write the ground. Placing a token, and every drop by the DM or a player of a token that was on the ground, sets its elevation to the ground where it lands. A flying token lands at its elevation or the ground there, whichever is higher. A token inside the ground keeps its elevation. The client puts the elevation in the op, as `token.move` already can, so replay never depends on these rules.
- A duplicate and a room import copy elevations as stored, which already match the same heights.
- An undo or a restore may put a token back at an elevation below ground painted since. It is then inside the ground until it next lands.
- A token inside the ground says so to its owners and the DM, on its action bar and panel: "Inside the ground (10 ft below). Stand on it", where Stand on it sets its elevation to the ground. The DM's Vision settings list it among the sources as lending no sight, so the party's view going dark has a visible reason.

**Movement rule** (extends 4.1, only while `blockMovement` is on).

- A token on the ground at the start of a leg is walking. Its leg is blocked at any raised edge that is not a stair connection, in either direction (question 2): raised edges join the movement set for it, under the core rule of section 4.1.
- A flying token's leg is blocked at a raised edge only when the lower of its start and end elevation is below the edge's top.
- A token inside the ground is not tested against raised edges. Walls still block it.

**Sight rule** (used by section 4.3). A viewer's eye is at its elevation plus its height. A raised edge blocks a viewer's sight when the edge's top is above that eye. A token inside the ground has no eye and lends no sight.

- So a Medium creature on the ground (eye at 5 ft) sees over a 5 ft ledge but not onto a 10 ft platform, and a creature on the platform sees down over its edge.
- A creature standing in a 10 ft pit cannot see out of it.
- The simplification: from below, everything over a platform higher than your eye is hidden, because a creature is in sight only when sight covers its footprint (section 4.3.2), whatever its own elevation. That hides a creature at the platform's very edge, which in life would show its head and shoulders, and also a flier above the platform: a dragon 60 ft over a 10 ft plateau is hidden from a party on the ground beside it (question 3). The DM can mark such a creature always visible (`fogExempt`, design.md 13.4), which shows it everywhere on the scene, not only from below.
- The alternative is cheap in arithmetic: one 3D line test from each source's eye to each creature standing on higher ground. Its real cost is in the design. Today a creature is in sight exactly when sight covers its footprint, and the narrow fan-out (section 4.3.5), the drag frame check and the "seen" marks all rest on that. A per-creature test makes visibility a function of each creature and each source, so each of those needs its own rework and test.

**Permissions.** DM for every build op.

**Projection.** Heights and stair marks are map data, sent with the chunks like the floor. They are not secret. The player chunk projection carries `walls`, `heights` and `up`, and a chunk is withheld as empty only when it has no cells, edges, free walls, heights or stairs.

**Undo.** A height paint is a build gesture, and its tokens come back with it. Undoing it is refused, like any restore, if someone moved one of those tokens since (design.md 7.7).

**Performance.** Raised edges are derived with the walls, once per derived set. The shading is a few paths per height level, drawn when the build or camera changes, never per frame.

**Out of scope.** Climbing and jumping rules and their movement cost. Falling (the SRD's 1d6 per 10 ft makes a later "Jump down" rules-consistent). Several floors in one scene (features 3, Later). Areas of effect blocked by ledges: a fireball still spreads in 3D over a cliff edge. A free area placed on raised ground takes the ground there as its origin height when the client places it, which is the only height change areas get.

### 4.3 Dynamic lighting and vision

#### 4.3.1 Behavior

**DM.** The scene's settings gain a Vision section:

- "Players see only what their characters see" (off by default). Turning it on also turns the scene's fog on, since remembering explored ground needs fog (section 4.3.3). The DM can turn fog off again, and the setting then says "Explored ground is not remembered while fog is off."
- Light: Bright, Dim or Dark, the scene's darkness level.
- The DM's own view stays fully lit, so the DM can work. A "Party sight" switch beside "View as player" veils what the party cannot see at 40%, and "View as player" (features 13) shows exactly what players see.
- Lights: the builder gains a Light mode. A tap places a light with an SRD preset (Candle 5/5, Torch 20/20, Lamp 15/30, Hooded Lantern 30/30, Light 20/20, Daylight 60/60), and a tap on a light opens a small pane (a bottom sheet on a phone) to change its radii, turn it on or off, choose whether walls cast shadows from it, or delete it. A drag moves it.
- A token's action bar offers Light (None, Candle, Torch, Lamp, Hooded Lantern, Light, Custom) to the DM and the token's owners. Custom radii stop at 120 ft each.
- The token panel shows what the creature sees, read from its senses line: "Sees in the dark to 60 ft". The DM's token panel shows this and the token's light for every party source, and the Vision settings list the sources with their ranges and lights, so the DM sees what owners set (the project owner, 2026-10-14, question 11).
- An allied NPC the DM runs can lend the party its sight: "Shares sight with the party" in its token panel.
- Moving players to a vision scene where no party creature can see warns first: "No party creature on this scene can see. Players will see only what they explored before."

**Players.**

- Inside the party's sight, the map is clear in bright light and darker in dim light. Areas seen only through darkvision show in a dark blue-grey, as darkvision sees no color.
- Outside it, ground the party explored before stays drawn, dimmed, with no creatures on it. Ground never explored stays under opaque fog, as today.
- The party's own tokens are always shown, above everything (design.md 13.3). Other creatures appear when they come into the party's sight and vanish when they leave it. Their initiative rows follow them, as rows under fog do today (question 14).
- A player toggles their token's light from its action bar.
- Nothing else changes: rulers, areas, pings and drawings work as before.

#### 4.3.2 The visibility model

**Party vision** (the project owner, 2026-10-14, question 1). The visible region is the union of what every party source sees, the same for every player. A per-player model, each player seeing only from their own tokens, was the alternative, and the project owner chose party vision. The reasons the design rests on:

- Players at one table see each other's phones, and a player joining remotely is usually on a call with the table. Per-player secrecy buys little. Features 11 v1 already lists "shared party vision".
- Every "seen by players" mark in the model (log lines, a turn's start, path stops) is one bit, set when "players who do not own the token could see it" (design.md 7.3). Per-player vision turns each into a set of members and every projection of a creature into a per-player computation.
- One computation per scene serves every player, which keeps the server's cost flat in the number of players.

**Party members and sources.** Three rules, kept apart so each reads only what it needs:

- A **party member** is a token that is owned by a player or marked `partyVision` by the DM. Membership alone decides "always shown": every party member is sent to players like a player-owned token (`aboveFog`), whatever its conditions, its life and the source cap. A creature the party sees through must be on their screen, so an allied NPC lending sight from the dark stays visible. Membership changes only when those token fields change, so the fan-out finds it on the token itself.
- A **source** is a party member on the scene that is visible (`visibility: 'all'`), is a creature (kind `pc`, `npc` or `monster`, or any kind marked `partyVision`), is not dead, dying or stable, not Unconscious and not inside the ground. A hidden player token lends no sight, so it cannot give away where it is.
- **The cap** limits only how many sources lend sight: at most 12 per scene, taken in a fixed order (player characters, then other player-owned creatures, then `partyVision` creatures, each by token ID). The rest lend no sight but stay shown, and the DM's Vision settings say how many.

**Senses.** Read from the actor's `senses` line, which the SRD import, the custom monster editor and owners already fill: `darkvision N`, `blindsight N` and `truesight N`, case-insensitive, feet, each capped at 150 ft (the SRD's longest darkvision). A parse keeps one source of truth and needs no new field or migration. Tremorsense is ignored: the SRD says it "doesn't count as a form of sight".

**Light at a point.** The scene's level (bright, dim or dark) is the base. A lit light raises points it reaches to bright within its bright radius and to dim within its dim band. A light reaches a point when the point is inside the light's own visibility polygon (if it has `walls`) and within its radius. A free light sits 5 ft above the ground under it, and a token's light at the token's eye. A DM-hidden token's light is off for players, so a hidden torch-bearer is not betrayed by a moving glow. A token withheld only because the party cannot see it still lights its surroundings, so a torch around the corner shows its glow. In a scene whose level is Bright, lights change nothing and are skipped.

**Ranges are horizontal.** Light radii and sense ranges are straight-line circles on the map, not the room's diagonal rule (light spreads in circles, and the diagonal rule is for counting movement), and they ignore height differences. So a torch on a 30 ft balcony lights the ground below as if it were level. A 3D distance from each eye or light to each point's ground is the alternative, and it costs a distance per point and source on scenes with heights. It is out of scope for v1.

**What a source sees.** Each source has a line-of-sight polygon from its eye, computed by the sweep over the sight set plus the raised edges above its eye (section 4.2). At a point inside that polygon, its sight level is:

| Light there | Plain sight | Within darkvision | Within truesight |
| --- | --- | --- | --- |
| Bright | bright | bright | bright |
| Dim | dim | bright (dim light as if bright) | dim |
| Dark | not seen | grey (darkness as if dim, in shades of gray) | dim, in color |

- Darkvision follows SRD 5.2.1 (p. 180): dim light within range as if bright, and darkness as if dim, in shades of gray.
- Truesight: the SRD says a creature with it sees in normal and magical darkness within range, and gives no light level for that. The app draws darkness within truesight as dim light in color, which is a drawing choice, not an SRD conversion. It does not brighten dim light, as darkvision does, so the two differ in more than color. Magical darkness is out of scope.
- Within blindsight range, a point is at least grey, light or not, still blocked by walls.
- A Blinded source loses plain sight, darkvision and truesight, but keeps blindsight, which the SRD says works "even if you have the Blinded condition".

**Sources and lights on a wall.** The sweep ignores a segment that passes through its origin (walls.ts, `visibilityPolygon`), so an eye exactly on a wall would see both sides. A Large creature's eye sits on a grid intersection, and free walls on half-grid lines put Medium eyes on walls. Areas use this same step for their origins since the wave 3 review (`aoe.ts`, toward the origin creature first). Sight moves the eye, but with a bounded step that can never cross a wall or land near one:

- **Decided on stored segments, exactly, with a margin.** The eye is the token's center, not rounded. Every test reads the stored sight segments, never the split pieces (section 2.1), with the exact predicate. A split piece has rounded ends, so it may sit a hair off its stored wall's line, and an eye a hair off the wall could then sit on the wrong side of a piece. So the step below is taken whenever the eye is within 1/4096 cell of a stored sight segment, its interior or an end, not only when it is exactly on one. The test compares the squared cross product with the squared length times (1/4096)², so it needs no square root. Every eye the sweep receives is then at least 1/4096 cell from every stored wall, far more than any rounding in a piece, so no piece can pass through the origin or lie on the wrong side of it.
- **An eye keeps its side.** An eye near a wall but not on it may only move away from that wall's line, on the side it is on, which the exact predicate decides. An eye exactly on a wall may go to either side. So no step ever carries an eye across a wall: the eye at (1.0149, 4.5), just west of a wall at x = 65/64, stays west, and so does the eye of a custom token 1.99 cells wide at x = 0, centered at (0.995, 0.5) beside a wall at x = 1.
- The candidate directions are the sixteen vectors (a, b) of whole numbers with the larger of |a| and |b| at most 2 and no common factor, taken clockwise from (1, 2). A direction parallel to a segment the eye is near is skipped, so the step never slides along it, and so is a direction toward the far side of a segment the eye is near but not on.
- Along each direction in turn, the steps tried are 1/64, 1/128 and 1/256 cell, each divided by the larger of |a| and |b| so no square root is needed. Every step is under 1/32 cell and at least 1/512 cell.
- The first step accepted is one whose point is farther than 1/4096 cell from every stored sight segment and whose path from the eye crosses no stored segment and touches none except those the eye is near. Between two walls 1/64 cell apart, the 1/64 step lands on the second wall and is refused, and the 1/128 step lands between them and is taken.
- If none of the 48 tries qualifies, the source fails closed: it lends no sight, and the DM's Vision settings list it as standing on a wall. A light fails closed the same way and lights nothing. Should the sweep ever still find a piece through its origin, it fails closed the same way rather than skipping the piece.
- Which side an eye exactly on a wall goes to is fixed, not chosen: a token whose center sits exactly on a wall stands in it and sees from one side. The answer is the same everywhere.
- Tests: walls 1/64 cell apart, junctions of three and four walls, a wall parallel to the first direction, eyes on segment ends, the fail-closed case, the two eyes beside a wall above, an eye at (1.5, 0.5) on a stored wall from (0, 0) to (3, 1) that another wall splits at (1.2, 0.4), and an eye 1e-15 cell off that same split wall: each is stepped off on its own side, and sight is the same with and without the splitting wall.

**The party's sight** is, per sub-cell, the best level any source has there: 0 not seen, 1 grey, 2 dim, 3 bright. It is rasterized at the fog's resolution, 4 x 4 sub-cells per cell (1.25 ft), testing each sub-cell's center as the fog rasterizer does (design.md 13.1).

**A creature is in sight** when any sub-cell whose center lies inside its footprint rectangle at its stored position, where the map draws it, has a level above 0. For a snapped creature of whole cells this is every sub-cell of its occupied cells, the fog rule's mirror. A squeezed creature (section 4.1) is judged by its squeezed footprint, so the half of it drawn over a wall is not seen from the room beyond. For a Tiny creature it is only the quarter of the cell it stands on: `occupiedCells` returns the whole cell, so testing whole cells would show a Tiny creature standing wholly behind a free wall through its cell. Projection, drag frames and the "seen" marks all use this one predicate.

#### 4.3.3 How it combines with the DM's fog

- **Two layers.** The DM's fog stays exactly as it is: the committed fog tiles, which the DM's fog ops write and the DM's undo puts back. What the party explores goes into a second layer, `exploredTiles`, with the fog tile's shape (`{sceneId, tx, ty, rev, bits}`, one per 16 x 16 cells, absent when empty), which only the server writes. Players see a sub-cell revealed when either layer reveals it.
- **Explore writes only the explored layer.** After every batch, on the player scene only, when vision and fog are on and no blackout is on, the actor compares the party's sight with the explored layer alone. Every sub-cell the party now sees that the explored layer lacks goes into the explored layer, ground the DM's layer already reveals included, so seeing a revealed room records it as explored too. The write is one server-made op appended to the same batch, `sys.explore { sceneId, tiles: {tx, ty, bits}[] }`, with each changed explored tile's new bits (only ever adding). Replay applies the stored bits and never recomputes sight. A DM previewing another vision scene explores nothing, and nothing is explored behind a blackout, since players are shown nothing then.
- **Players get one fog.** A player's projection merges the layers: each fog tile it receives is the DM's tile and the explored tile at that key, revealed where either is. So the client's fog drawing, the fail-closed gate, labels and stamps under fog, the map export's player view and Fit map all work unchanged, on the merged fog. A DM receives both layers, and the DM's fog view draws explored ground like revealed ground, with a dotted edge.
- **The DM's tools.** A reveal shows more. A hide also clears the explored bits under its shapes, so players forget the area, except where the party is looking now, which the same batch explores again. `fog.reset` to hidden clears the whole explored layer of the scene. Those clears happen outside any undo step. A hide over ground the DM's layer already hides changes no DM tile and only clears exploration, so its undo step is empty and Ctrl+Z skips it, as it skips a fog op that changes nothing today.
- **Undo keeps what was explored** (the project owner, 2026-10-14, with the details the reviewers chose). A DM's fog undo puts back the DM's layer, guarded as today. Explore never writes that layer, so it never changes what a DM step's guard expects, and every fog undo chain works exactly as it does without vision. Anything the party explored after the edit stays explored: the DM reveals a room, the party walks through it and leaves, the DM undoes the reveal, and players keep the room.
- **Undoing a hide does not bring back what it cleared** (accepted, the owner's decision in round 6). The explored layer has no guards and no undo: explore adds to it, and only a hide or a reset clears it, outside any undo step. So undoing a hide or a reset brings back the DM's fog and not the exploration it cleared, which the party explores again by looking, or the DM reveals by hand. A mis-tap is already guarded: the buttons that fog or reveal everything ask for a second tap (design.md 14.4). On vision scenes the fog tool's hint says: "Undo brings back your fog, not what the party explored. Reveal it again by hand." Bringing the cleared bits back was considered in round 5 and dropped in round 6: a guard-free addition could override a later hide by another DM, and an exploration-only undo needed a replay contract of its own, all for a rare mis-tap that the second tap already guards.
- **Why two layers.** With one layer, explore changes the tiles the DM's steps guard. Round 3 moved the guards to follow it, which let an older undo erase what was explored after it. Keeping the restore values in step as well breaks undo chains: the restored value then includes explored bits the older step's guard does not expect. Keeping exploration out of the guarded layer removes the interaction instead of patching it.
- `sys.explore` is no one's undo step. Undoing a party move does not take back what that move explored.
- **The plumbing.** The explored layer reaches every place the fog does:
  - Every write to `explored:<scene>:<tx>,<ty>` adds the matching `fog:<scene>:<tx>,<ty>` to the batch's fan-out candidates (`dependents` in shared/project.ts), since a player's fog tile is the merge. A `sys.explore` also touches the tokens, labels and stamps overlapping the tiles it wrote (section 4.3.5). Any op that clears explored bits (a hide or a reset, even one that changes no DM tile, as one outside the party's sight over explored ground does) sets `global`, so every token, label and stamp there, and everything that depends on them, is projected again. `global` is room-wide in the fan-out (`server/rooms/fanout.ts`), so it re-projects the whole room, not only that scene: broader than needed, and correct. Clears are rare DM actions, so the full re-projection costs nothing at the table.
  - `allKeys` lists a `fog:` key for every tile either layer holds, so a snapshot and a global re-projection include a tile only the party explored.
  - `fogReader`, `withheldUnderFog` (tokens, labels and stamps, and the "seen" marks through it) and the ephemeral channel's `isTokenFullyFogged` read the merged layers, on every scene, including one whose vision was turned off since it was explored.
  - The room import's `remapState` carries `exploredTiles` under the new scene IDs.
  - The size guard never refuses a `sys.explore`, or the party's sight would stand outside the revealed area. So the layer's room to grow is reserved in advance, against the room limit and the projected scene alike (section 2.4), and explore only ever spends what is reserved.
  - The projection invariant test (section 6) runs explore writes, explored-only tiles, hides and resets that clear them, and vision turned off.
- **Scenes.** Explored tiles belong to their scene. A restore that removes a scene removes its explored tiles too, as bookkeeping, and they never count as "other work depends on it", so undoing a scene's creation, duplication or import is refused only for the DM's own work on it, as today (design.md 7.7). Delete scene removes both layers.
- With fog off on a vision scene, nothing is remembered. Players see the whole map dimmed and only the party's sight clear. Turning vision on turns fog on for that reason (section 4.3.1).
- **Tokens on a vision scene follow sight, not fog.** A non-party token reaches players only while it is in the party's sight, or when `fogExempt` is set (design.md 13.4). A creature revealed on its turn (`fogExemptAuto`) gets no exception (question 20). With fog on, sight is always inside the revealed area, since explore runs in the same batch. So the old fog rule is implied, and the token rule becomes "in sight". Off a vision scene, nothing changes.
- **One rule for every "seen" mark.** `seenByNonOwners`, `inSightOfNonOwners` and `rowSeenByNonOwners` (shared/project.ts) use this rule, so log lines, a turn's starting spot and path stops are marked by sight on vision scenes. The order of the checks keeps it cheap: `visibility: 'dm'` is never seen, and a party member or an exempt token is always seen, so sight is consulted only for the DM's other creatures.
- **Blackout.** Wave 2 already makes all three helpers answer "not seen" while a blackout is on, before any fog check. The vision rule sits after that check, and the design relies on it: nothing behind a blackout is marked seen, by sight or by fog.

#### 4.3.4 Where it is computed

**On the server, only.** The per-viewer projection is the security boundary (design.md 7.3): nothing a player may not see may reach them, devtools included. A creature out of the party's sight must not be in their data, so the server must know the party's sight. Computing it on clients as well would mean sending lights and every source's senses to players, which leaks where the DM's lights are, and the result would still not be trusted.

- `shared/rules/vision.ts` is a pure function, `partySight(state, sceneId)`, with a cache per scene. The server calls it from projection, from the actor's explore step and, through the "seen" helpers, from the reducer.
- **Players and DMs receive it** as derived entities, keyed `sight:<sceneId>:<tx>,<ty>`, one per 16 x 16-cell tile with any level above 0. In a projected state they sit in a `sight` map keyed `"<sceneId>:<tx>,<ty>"`, as fog tiles are, so an `ev` that removes one scene's tiles and adds another's never makes two entries share a key. A tile's value is `{"b": "<1,368 base64 characters>"}`, 2 bits per sub-cell in row order, or `{"f": n}` for a tile all at level n. They are never stored in `RoomState`. `projectState` derives them, the fan-out diffs them like any entity, and the client keeps them in its confirmed state.
- **Its largest size.** A scene ID may be any string of up to 64 code units, which JSON may escape and UTF-8 may widen, so the reserve is computed per scene from its own key rather than assumed: `utf8Bytes(JSON.stringify("<sceneId>:12,12"))` (`utf8Bytes` is in shared/limits.ts) plus 1,378 bytes for the colon, the value `{"b":"` with its 1,368 base64 characters and `"}`, and a comma. For an ASCII scene ID of 36 characters that is 1,422 bytes, about 235 KB for a 200 x 200 scene's 169 tiles. A test measures the largest entry under scene IDs of 64 CJK characters, quotes and control characters against the reserve computed for each.
- **No client computes sight.** A client's confirmed state always holds a `sight` map (perhaps empty), and the server's `RoomState` never does. So when the shared reducer runs on a client (optimistic replay) and a "seen" helper needs sight, it reads the tiles the server sent, and a scene with none counts as nothing seen. On the server it computes. A client's optimistic marks can therefore be wrong for one batch, and the server's answer replaces them. Only the server's marks decide what players receive.
- **Exact arithmetic.** The "seen" marks are stored facts: replay rebuilds the in-memory log, a turn's start and path stops through the reducer (persistence.ts), so a mark that came out differently on replay could show players a past event they never saw, or break a later stored restore's guard. So the code behind sight uses only `+`, `-`, `*`, `/` and comparisons, which IEEE 754 rounds the same way in every engine and which JavaScript never fuses:
  - The split and its counting pass live in `shared/rules/segments.ts`, the exact sweep, the nudge, the clipping and the raster in `shared/rules/vision.ts`, and ground heights in `shared/rules/heights.ts`. `indexPolygon` and `crossingsAt` move from walls.ts into segments.ts, and walls.ts imports them back, so the sight code imports nothing from walls.ts. Areas keep the existing sweep in walls.ts, fed the split area set, since their results are never stored.
  - The sweep sorts segment ends by an exact half-plane and cross-product comparison instead of `atan2`, finds hits by solving the line equations, and compares squared distances.
  - The nudge scales its steps by the larger of a direction's two components instead of normalizing it (section 4.3.2).
  - A circle (a light's radius, a sense's range) becomes spans per sub-cell row by an integer search: for each row, the first and last sub-cell centers whose squared distance from the circle's center is at most the squared radius, found by a binary search over whole column numbers.
  - A test fails if any of those three files, or anything they import, calls `Math.atan2`, `sin`, `cos`, `sqrt`, `hypot`, `pow` or `exp`. A golden-bits test pins the output for fixed scenes. The same inputs then give the same bits on the server, on replay after a Node upgrade, and on any client.
- **Incremental and exact.** The cache keeps each source's polygon and each light's lit polygon with the inputs they came from: position, eye height, range, the source's actor (its conditions, life and senses), the identities of the chunks they read, and the scene's `autoWalls` and bounds. After a change, a polygon is recomputed only when its own inputs changed, or when the box of a changed chunk, grown by 5 cells, overlaps the polygon's bounding box. The 5 cells cover a free wall reaching 4 cells past its chunk (section 2.2) and the automatic walls, raised edges and pillars on the chunk's border. A segment that changes outside a polygon cannot change it, since every ray from the source stops at the polygon's boundary first. So the incremental result always equals a cold computation. Tests check that, including long free walls across chunk borders and a new free wall stored in the chunk next to the room it closes.
- **Lazy lights.** A light's lit polygon is computed only when some source's sight box reaches the light's lit box. A light's sweep uses the box around its radius.
- **Culling.** A source's sweep uses the box that bounds everything it could see: its darkvision, blindsight and truesight, and the lit areas. In a dark scene with a few lights that box is small. In a bright scene, or a dark one whose lit areas spread across it, the box is the whole scene.
- **Every sweep box takes every segment that reaches it.** A culled or light sweep selects each segment that intersects its box, not only those inside it, and clips it to the box before sweeping (section 2.1). Dropping a wall that starts outside the box and runs into it would let sight or light pass it, and keeping it unclipped would cross the box's own sides. Clipping solves for the crossing points with division only. The ray-cast oracle test runs culled and light boxes as well as whole-scene sweeps.
- **Scanline raster.** Polygons and circles become spans per sub-cell row, polygons by the crossings of `indexPolygon` and `crossingsAt` (moved to segments.ts, and already basic arithmetic) and circles by the integer search above, and levels are written span by span. Cost grows with the number of polygon edges per row, not with the sub-cells covered.

#### 4.3.5 Projection, fan-out and the ephemeral channel

- Tokens: `tokenVisibleTo` for players on a vision scene uses section 4.3.3's rule. Everything that follows a token's visibility follows it unchanged: attached areas, kept rulers, initiative rows, a turn's start, a path's stops, log lines (design.md 7.3).
- Token fields: `light` goes to the DM and owners, never to other players, who see only its effect. `partyVision` is DM only.
- Scene fields: `vision`, `blockMovement` and `autoWalls` go to players, who need them to draw and to drag.
- Lights: DM only, always.
- **Vision settings set `global`.** A change of `vision.on` or `vision.light`, by an op or by an undo or redo, sets `global` for the scene (`isGlobalChange` in tx.ts compares them, as it compares `fogEnabled` today). Turning vision on changes the rule for every creature on the scene, including creatures far from any sight tile, so a narrow diff cannot find them. A phase switch that carries a light level writes the scene and is covered the same way. So does a change of `autoWalls` (section 2.1).
- **Actor changes reach sight.** Whether a token is a source reads its actor: its conditions (Unconscious, Blinded), its life and its senses. A PC's actor lives on its character, which a token only points at. So an `actor.*` op, or a `character.update` of an actor, on a creature with a token on a vision scene, touches that token, and the server recomputes that scene's sight after the batch. Its effect on players then reaches them through the sight diff below.
- **Everything else stays narrow.** A sight change from a move, a light, a door, a death or a condition does not set `global`, and neither do the explored-layer writes of `sys.explore` (the DM's fog changes keep setting it). The actor keeps the last committed sight of each vision scene and diffs it. The batch touches the sight tiles that changed and every token, label and stamp overlapping a changed sight tile or a tile `sys.explore` changed. Nothing else can change: with the rule unchanged, a creature's projection depends on sight only through its own footprint. Their dependents follow by design.md 7.3's rules.
- Party vision makes the projected sight tiles the same for every player, so the fan-out computes and hashes each changed tile once per batch and only compares hashes per connection.
- **Drag frames** (design.md 7.6): on a vision scene, a frame whose preview footprint is not in the party's sight is not sent to players unless the token is `aboveFog` or a party member, and players who had it get the bare `dragCancel`. The check reads the cached sight bitmap with the footprint predicate above, using the squeezed footprint whenever the server's preview rule of section 4.1 finds a squeeze at the preview point, whatever the frame says.
- **Drag paths.** A `dragMove` frame may carry the cells the drag passed through (`path`), and today `forPlayer` (ephemeral.ts) strips it only on a fogged scene. A monster dragged through darkness back into sight would show players its route. So players get frames without `path` whenever the scene has fog or vision on.

#### 4.3.6 Performance budgets

**Basis.** Measured on a development laptop with Node 24 (scratch benchmarks, not committed): 2.6 ms per polygon for 4,000 non-crossing segments and for a 200 x 200 builder dungeon (3,337 merged segments), and 6.8 ms to index and derive a dense 200 x 200 build. Random crossing segments made the deployed sweep run for minutes, one more reason for the split. The server and phones were not measured. Assume the server two to three times slower than the laptop.

**The caps** (section 2.4) bound every row: 12 sources, 100 free lights and 20 lit token lights, radii of 120 ft plus 120 ft and senses of 150 ft (at most 24 cells a radius and 30 cells a sense, so every grid scale costs what 5 ft per cell does, and `scripts/bench-server4.ts` runs the dark scene at 1 ft per cell too), 6,000 potential sight pieces, the split's 100,000 candidate pairs and 5,000 added pieces, 1,000 pillars, 20,000 drawn edges and 1,000 doors and windows per scene.

| Work, at the caps | Where | Budget | Typical scene |
| --- | --- | --- | --- |
| The split's counting pass on an op that writes geometry, accepted or refused | server | 15 ms | under 1 ms |
| Derive, split and index the wall set after a build edit or a door | server | 40 ms | under 3 ms |
| The same derive on a phone, for areas and movement, any scene | phone | 100 ms | under 10 ms |
| One party source moved, bright scene | server | 25 ms | under 2 ms |
| One source moved among lit lights, dark scene | server | 30 ms | under 3 ms |
| A light added, moved, switched or removed | server | 10 ms | under 1 ms |
| A source added or removed (a death, Blinded, a token placed) | server | 25 ms | under 2 ms |
| A door or wall that every source sees, including the derive | server | 250 ms | under 10 ms |
| A group move of every source (`token.moveMany`) | server | 250 ms | under 10 ms |
| Cold sight: room load, vision turned on, a light level or phase switch | server | 250 ms | under 20 ms |
| Sight fan-out for all players in one batch | server | 10 ms | under 1 ms |
| Applying changed sight tiles and redrawing the overlay | phone | 4 ms | under 1 ms |
| Leg test while dragging, a squeezing creature's shifted paths included | phone | 1 ms | under 0.2 ms |

- **Drawn edges are capped.** The wave 3 review found that hand-drawn edges were bounded only by a scene's 3 MiB, and a wall on all 80,000 edges of a 200 x 200 scene passed the count and derive budgets. So every scene holds at most 20,000 drawn edges, and the bench shows the 80,000-edge scene refused. Wave 4 runs the derive on every sight and movement change, so its gate measures it again, and may still make the derive incremental (per-chunk edge maps reused while the chunk object is unchanged).
- **Two gates.** The geometry rows (the counting pass, the derive and split, and the derive on a phone) arrive with wave 3, so they are gated before wave 3 ships: a benchmark builds scenes at the split's caps, with crossing free walls and pillars, and refused inputs just past the caps, and runs those rows on the server and on a mid-range phone. Every other row is sight or movement, and is gated before wave 4 deploys on scenes at the caps, bright and dark, with heights. In either gate, a row that exceeds its budget lowers a cap (sources, sight pieces, the split's caps or lights) until it fits, and section 2.4 is updated to the new number. A worker thread is not the way out, since the reducer's "seen" marks need sight synchronously.
- **What 250 ms means.** All rooms share one event loop, so the worst rows pause every room for up to a quarter second. They happen on rare events at the extremes: a maximal scene where every source sees the same door, the DM dragging the whole party at once, a room load. On a self-hosted server with a handful of rooms, that is accepted. Typical scenes stay in the right-hand column.
- **Memory.** Per vision scene: up to about 16 KB per source polygon, about 5 KB per light polygon (culled to its lit box), 160 KB for the level bitmap and up to about 235 KB of encoded tiles, under 2 MB in all. Vision caches across the whole server are capped at 64 MB, dropped least recently used by scene, and each room keeps at most its 4 most recent vision scenes.
- **Bandwidth.** A move changes a handful of sight tiles, a few KB per player before `permessage-deflate`, which shrinks 2-bit runs well. Snapshots carry up to about 235 KB of sight tiles, typically under 30 KB, reserved in the size guard (section 2.4).

#### 4.3.7 Client rendering

- The overlay layer (design.md 13.3) gains a sight image below the fog image: other creatures' drag previews, then sight, then fog, then party tokens, rulers, pings, laser and area previews.
- Sight draws like fog, from an offscreen canvas at 4 px per cell, but with smoothing on, so its edges are soft. Smoothing is safe here because the server already withheld every creature out of sight, and the opaque, unsmoothed fog still guards unexplored ground.
- Per level: bright clear, dim black at 35%, grey a blue-grey at 55%, not seen (explored only) black at 65%. True desaturation would need blending across Konva's separate layer canvases, which is out of scope.
- Changed tiles are written with `putImageData` into the offscreen canvas, then one image draw. Nothing runs at rest.
- Fail-closed: on a vision scene, missing or unreadable sight tiles count as nothing in sight. Creatures are filtered on the server anyway, and fog still gates the map.

#### 4.3.8 Model

```ts
Scene.vision?: { on: boolean, light: 'bright' | 'dim' | 'dark' }
Token.light?: { bright: number, dim: number }   // ft, each at most 120, at the token's eye
Token.partyVision?: boolean                    // DM: a creature that lends the party its sight
MapPhase.light?: 'bright' | 'dim' | 'dark'     // applied by scene.setPhase
```

- Ops: `scene.update` patches `vision` (and turns fog on with it, section 4.3.1). `token.update` patches `light` (the DM and owners, added to the owners' fields in design.md 8.1) and `partyVision` (DM). `build.lights` (section 3.6) edits lights.
- Server-made: `sys.explore`, checked against the server op schema like `sys.memberJoin`, never sent by a client, on no one's undo stack.
- Universal VTT import (wave 4 addition): the dialog proposes the light level from `environment`. With `baked_lighting` it proposes Bright, since the image is already lit ("The map image already shows its lighting"). Otherwise it reads `ambient_light`'s last six hex digits as a color and proposes Bright at 70% luminance or more, Dim at 30% or more, else Dark.

#### 4.3.9 Permissions and undo

- Vision settings and lights: DM. A token's light: the DM and its owners.
- Senses stay owner-editable, as they are today (`OWNER_ACTOR_FIELDS` in permissions.ts includes `senses`), and owners set their token's light, Custom radii included. The project owner decided on 2026-10-14 that this is trusted: ranges capped at the SRD's maximums (150 ft for senses, 120 ft for each light radius), and the DM sees what owners set (section 4.3.1).
- Undo: settings, lights and a token's light undo as ordinary edits, and a settings undo sets `global` like the edit (section 4.3.5). Exploration's undo rules are in section 4.3.3.

#### 4.3.10 Out of scope

Per-player vision (the project owner chose party vision). Colored and flickering light. Cone lights (the Bullseye Lantern). Magical darkness. Invisible creatures hidden automatically (the DM hides them). Sight cones and facing. Hearing and tremorsense. Half and three-quarters cover. 3D light and sense ranges. A live sight preview while dragging. Light from areas of effect (a Daylight spell is a light the DM places).

### 4.4 Token shadows (depth cue)

Features 8 v1: "A depth cue: the token's shadow drifts down and away as it rises", and the feature request's note for shadows under tokens that are not on the ground.

- A flying token (elevation above the ground under it, section 4.2) draws a soft ellipse shadow under its footprint, offset down and to the right by 0.1 cell per 5 ft of lift (at most 0.6 cell), shrinking and fading as it rises. A token on the ground, raised ground included, has none, so a platform does not look like flight. A token inside the ground has none either.
- It draws on the tokens layer below token bodies, for everyone who sees the token, and follows a drag preview. Client only, no model change. On a scene without heights the ground is 0.

### 4.5 Wave 4 build split

| Part | Owns | Depends on |
| --- | --- | --- |
| **4A Contract and core** | `shared/model.ts`, `shared/protocol.ts`, `shared/keys.ts` (the derived `sight:` keys), `shared/limits.ts` (the caps), `shared/migrate.ts` (snapshot 7, the empty `exploredTiles`), `shared/reducer/*` (door.set, build.height with its tokens, build.stairs, token light and partyVision, phase light, vision turning fog on, the teleport flag's leg mark and log event, `squeeze` set by moves and cleared by any edit of size, scene or position, hides clearing explored bits as bookkeeping, a scene's removal taking its explored tiles), `shared/reducer/tx.ts` (vision settings in `isGlobalChange`, explore not global), `shared/permissions.ts` (door reach by `legFeet`, the move-blocking hook calling 4B, the squeeze check, teleport skipping the wall test, a teleport's redo, `squeeze` in `POSE_FIELDS`), `server/rooms/undo.ts` (a teleport recorded on its step, `squeeze` in `Place`, `Pose`, `samePose` and `putBack`), `shared/project.ts` (token rule on vision scenes, party members always shown, field allowlists, chunk fields, the merged fog for players, the DM-only teleport event, sight entities and their shape through a 4C interface). Tests. | wave 3 |
| **4B Heights and movement rules** | `shared/rules/walls.ts` (movement and sight sets, pillars, raised edges, stair marks as Stairs cells, the per-cell index), `shared/rules/heights.ts` (ground, stair direction), `shared/rules/movement.ts` (the core rectangle, swept paths over the stored segments, the start exception by side, the nine shifts, the last clear spot and squeezed drop spots, on the ground, flying or inside, in exact arithmetic on the lattice), `shared/rules/footprint.ts` (the squeezed footprint for every rule that reads one). Tests with every corner case in sections 4.1 and 4.2. | 4A types |
| **4C Vision rules** | `shared/rules/vision.ts` (members, sources and the cap, senses parse, exact sweep, box clipping, the bounded nudge, eye-height raised edges, light polygons, scanline levels with integer circle spans, footprint predicate, party union, incremental cache with actor inputs, tile encoding). Ray-cast oracle tests, incremental-equals-cold tests, golden bits, the banned-functions test, benchmarks with thresholds. | 4A, 4B |
| **4D Server** | `server/rooms/actor.ts` (explore step writing the explored layer), `server/rooms/undo.ts` (the squeeze flag in a move's pose), `server/rooms/fanout.ts` and `dependents` in `shared/project.ts` (narrow sight dependents, one hash per tile per batch), `server/rooms/ephemeral.ts` (sight filter, `path` stripping), `server/rooms/sizeGuard.ts` (the sight reserve per scene key), actor and character ops touching tokens on vision scenes, the server-box benchmark. Integration tests (section 6). | 4C |
| **4E Vision client** | `client/features/vision/*` (overlay layer, Party sight, scene Vision settings, senses line, token Light chip), `client/features/lights/*` (the builder's Light mode in its own files, one registration line). | 4A, contract of 4C |
| **4F Movement and doors client** | `client/features/movement/*` (drag stop at walls and ledges, squeezed drop spots, notes with the ghost and the door hint, "Teleport here" through the undo of the stopped walk, the DM's toast, landings, the inside-the-ground notice), `client/features/doors/*` (the door tap zone and pill, the action bar's door button). | 4B |
| **4G Raised areas in the builder** | `client/features/builder/heights/*` (Height mode, Stairs brush, stair arrows), the raised-area shading and directional stairs in `client/features/builder/draw.ts`, the map export picking them up. | 4B |
| **4H Token shadows** | `client/canvas/TokenNode.tsx` shadow pass. | 4B |
| **4I Integration** | e2e with two browsers: a monster appears and vanishes at the edge of a torch, a player stopped at a door then opening it, a ledge and its stairs. Docs updated. | all |

Wave 3 and wave 4 can overlap: 4B and 4C need only 3A and 3B. Wave 4's contract (4A) should be reviewed before 3A merges, since both touch the build chunk shape.

## 5. Performance summary

- Wave 3 adds no per-op cost to play. Import and duplication are single DM actions bounded by one scene's limits. Stamps and free walls add bounded drawing on change. The crossing split runs once per walls version.
- Wave 4's cost is sight. Section 4.3.6 sets its budgets at enforced caps and the server-box gate. The design keeps it to one computation per scene, incremental and exact, on the server only, with the fan-out touching only what sight changed, except when vision settings change.
- Movement blocking is negligible on both sides.

## 6. Testing

Beyond each part's unit tests, the review asked for these, and the build includes them:

- **Geometry.** The derived sets are crossing-free on random scenes. Sight agrees with an independent brute-force ray cast on random scenes with crossing free walls, pillars and raised edges, for whole-scene, culled and light sweeps, including a wall that starts outside a culled box and runs into it. The nudge handles walls 1/64 cell apart, junctions of three and four walls, a wall parallel to its first direction, and fails closed when it must.
- **The split's caps.** A dense pile of free walls in one cell and a lattice of crossing walls are refused at the op that would create them, by `build.walls`, `build.edge`, painting, `build.height`, `build.stairs`, `autoWalls`, the room import and the Universal VTT import, before any piece is built. A closed or opened door never reaches the sight cap.
- **Movement.** A Large creature passes a 5 ft door and walks along a 5 ft corridor and up a stair one cell wide, and can stop inside the corridor. A Gargantuan one passes 15 ft and not 10 ft, and a Huge one passes 10 ft and not 5 ft. No path crosses a wall: a Large creature centered a quarter cell from a free wall is refused a one-cell move toward and across it, in either direction, by the straight path and by every shifted path, and allowed a one-cell move away from it. A token centered exactly on a wall may step off to either side but not slide along it. Junctions where walls meet are decided on the stored segments, the same on a phone and the server. A custom 1 by 3 token squeezes by its own rectangle. A squeezed Large creature in a corridor is listed by an area only for the corridor's cells, the ruler measures it from there, and a `squeeze` flag is refused on a move into the open, flush against a room wall, or for a token with no side of 2 cells. Custom tokens of 1.01, 1.99 and 1 x 3 cells get cores of 0 (a point), 0.95875 and 0 by 1.96875, and only the 1 x 3 one may squeeze, to 1 x 2. Undoing a move into a corridor takes the squeeze off and undoing a move out puts it back, with damage dealt meanwhile kept, and redo does the reverse. A DM's edit of a squeezed token's size, scene or position clears the flag. A Large creature dragged into a corridor out of the party's sight sends players no frame at any fractional point along it, though its full-size preview would reach through the wall into lit ground, and leaving the corridor into sight sends them again. A Large creature dragged in the open beside the edge of sight is judged by its full footprint. A Large creature's "Teleport here" into a corridor lands squeezed. A Medium creature keeps the center path.
- **Automatic walls.** The three rules make the walls of section 2.1, a blank mat, new or old, walls a stair corridor, a pillar against a room's edge and a water channel as today, and switching a scene to Around floor only opens exactly the overlay edges. A hidden secret door shows as a wall wherever no automatic wall stands, under all three rules, beside a stair mark and across a chunk border, in the projection and in the map export. Changing the setting, and undoing the change, re-derives walls, re-projects chunks and refreshes the client's area cache.
- **Caches.** Incremental equals cold, with long free walls across chunk borders, actor changes and `autoWalls` changes. A staged state the size guard refused never feeds a later computation (identity-keyed caches).
- **Determinism.** Golden bits for fixed scenes, and no banned `Math` functions in the sight code.
- **Projection.** The invariant (design.md 18) gains vision toggles and their undo, explore writes, tiles that only the explored layer holds (with no DM fog tiles at all), hides and resets that clear explored bits (one outside the party's sight over explored ground, with a monster, a label and a stamp under it, which players then stop receiving, run once with vision on and once with vision turned off after exploring, on a tile only the explored layer holds), and vision turned off after exploring: applying a viewer's events to its snapshot still equals a fresh projection. On a vision scene no player projection holds a non-party creature outside the party's sight unless exempt, including a Tiny creature behind a free wall in its own cell. Sight tiles equal a fresh computation. A player's derived movement set equals the server's for every secret-door and lock state.
- **Sockets.** A monster walking out of sight never reaches a player socket. A monster's drag frames out of sight never do, and no frame carries `path` on a scene with fog or vision on. Explore runs only on the player scene, never during a blackout, and replays as stored.
- **Teleport.** "Teleport here" after a stopped walk leaves one uncounted leg from where the walk began, and falls back to two legs with its note when the undo of the walk is refused. A drop stopped at its first step teleports with no undo and no note. A teleport refused after its undo applied says the walk was taken back. A teleport passes a wall and a ledge, refuses a token the player may not move, and writes a log line only DMs receive, the same on replay. Its undo takes the move back and leaves the line, and its redo passes the wall again, in a fight and outside one.
- **Undo.** The DM's immediate undo of a fog reset on a vision scene applies. The reviewers' sequences pass with the real `guardHash`: two fog steps by one DM (values 1 then 3) with exploration between and after undo in order, and DM A's hide-all under DM B's reveal undoes after B's undo, while A's undo refuses as long as B's step stands. A reveal of bit 1, an exploration of bit 2, the party leaving and an undo of the reveal leaves players bit 2. A reveal, the party seeing that same ground and leaving, and an undo of the reveal leaves players the ground. A hide or a reset clears the explored bits under it, and its undo brings back the DM's layer only, leaving them cleared. Undoing a scene's creation is not blocked by its explored tiles. An undo that would take a scene past the split's caps refuses. A height paint lifts tokens, and its undo puts them back or refuses when one was moved since. A background thumbnail between a scene edit and its undo leaves the undo working.
- **Scenes.** A duplicate clears `fogExemptAuto`, re-anchors durations so the original's fight never ticks the copy, and handles uncopied casters and ruler anchors. Phases refuse a shape or a grid that would break calibration, and reordering, replacing or removing the reference phase keeps the grid on the same cells.
- **Import.** Synthetic files with all four border edges, a positive and a negative fractional origin (walls, portals and lights through the same transform), crossing walls stored unsplit on the 1/64 lattice, long diagonal walls cut with their ends on the lattice (including the wall from (0, 0) to (1023/64, 45/64), whose two equal parts would snap to 8.008 cells and so are cut in three), wall ends welded within 0.1 square and counted, walls cut exactly to portal ends, wall-mounted lights, lights whose transformed or moved positions are off the 1/64 lattice (each stored on it, then checked against the walls again), more than 100 lights, and ops batched under 48 KiB.
- **Sizes.** A vision scene near 3 MiB with the sight reserve computed from its own key, and the largest tile entry measured against it under ASCII, CJK, quote and control-character scene IDs. Players moved between two vision scenes with overlapping tile coordinates keep both scenes' tiles apart.

## 7. Risks and hard parts

1. **Sight on one event loop.** Every room shares one Node process with 1.5 CPUs. The worst rows pause every room for up to 250 ms. Mitigations: enforced caps, the crossing split (without which the sweep can run for minutes), culling, lazy lights, exact incremental reuse, and the server-box gate.
2. **The security boundary grows.** Creature visibility now depends on geometry. Bugs there leak creatures. Rounds 1 to 3 of the review found six such leaks (crossing walls, Tiny creatures, eyes on walls, a nudge onto a second wall, walls crossing a culled sweep's box, and an eye on a split wall that inexact arithmetic missed), each now handled and tested against an independent oracle (section 6).
3. **Universal VTT files vary.** The format is described only loosely, and each exporter has quirks: whether walls have gaps at doors, what `closed: false` means outside Dungeondraft, the unit of a light's `range`. The import cuts walls back at portals, offers the portal switch and reports counts, so the DM can check. Section 10 lists what could not be verified. Real exports from each tool should be tried before release. They must not be committed, since they are not openly licensed test data.
4. **Large images on phones.** iOS's canvas limit makes big exports a computer-only import. Said plainly in the dialog.
5. **The 2.5D height rule is a simplification** (section 4.2). It will be wrong at the lip of a high ledge, and it hides a flier over a platform higher than the party's eyes, such as a dragon 60 ft over a 10 ft plateau. The DM's always-visible flag covers the dramatic cases.
6. **Squeezing is a heuristic.** The nine half-cell shifts line a creature up with grid openings, not with every opening an import draws. An opening off the grid that is barely wide enough may need the DM, and a squeeze on a slant takes two drops (section 4.1).
7. **Explored memory beside the fog** means a DM's hide does not stick where the party is looking. That is the meaning the project owner chose, but it surprises a DM used to fog alone. The fog tool's hint says so on vision scenes.
8. **Players cannot preload phases.** A player on a slower connection waits about a second on a switch. The old image stays up meanwhile.
9. **Two waves change the build chunk.** Wave 3 adds free walls and wave 4 heights and stairs. Both are optional fields, but the chunk projection, erase and clear change twice. Reviewing wave 4's contract before 3A merges avoids a second migration.

## 8. Not changed, with the reason

- **The scene's walls version reached players** when this addendum was written: a DM's edit to a hidden secret door bumped it, which told a watchful player that something on the scene changed, not what. The live play review after wave 3 closed that side channel: players get the walls version as 0, since no client reads it once the rules caches follow the derived wall set (section 2.1), and their tokens, characters and encounter carry rev 0 too, so a DM's edit of a token's `light` or `partyVision`, which other players never receive, sends them nothing.
- **The elevation badge** keeps reporting absolute elevation, as features 5 and the client define it. A creature off the ground is told apart by its shadow (section 4.4).
- **No notice to the DM when a player opens a door.** The DM sees the door open on the map. A notice needs a new event, a product choice for later.
- **Doors show their live state on explored ground** (question 16). Chunks reach players whole, so on a vision scene a door that a creature out of sight opens swings open on players' screens, in the dimmed ground they explored. Map knowledge has always reached players this way (design.md 7.3), and remembering each door's last-seen state per player would be another kind of state in the projection. Accepted, and the project owner agreed on 2026-10-14.

## 9. Questions for the project owner

The project owner answered questions 1, 6, 11, 12, 15, 17 and 20 on 2026-10-14, and decided the fog undo rule of section 4.3.3. Late that day every question still open was listed with its recommendation or owner default, and the project owner answered: "All defaults good with me". So every question here is decided. Questions 18 to 21 came from the wave 4 code review. The project owner overruled the default for question 20, and questions 18, 19 and 21 keep the owner's default. The numbers stay as the rest of the doc cites them.

Also decided by the project owner on 2026-10-14: undoing an older DM fog edit takes back only the DM's edit, and anything the party explored since stays explored (section 4.3.3). And outside this addendum, "Hold" means the same as Ready, which wave 2 already built (features 10's "Hold and Ready markers"). Nothing here changes for it.

1. **Party vision or per-player vision?** With party vision every player sees what any party member sees. Per-player vision hides from each player what only another player's character sees. **Decided (the project owner, 2026-10-14): party vision** (section 4.3.2).
2. **Can a walking token step down off a raised area, or only use the stairs?** Recommended: stairs only, both ways, as the request described. The DM moves a creature that jumps or falls, and a flying token passes over. **Decided (the project owner, 2026-10-14): as recommended.**
3. **Should a creature at the edge of a higher platform, or a flier above one, be visible from below?** The simple rule hides both: a creature is in sight only when sight covers its footprint, so the cliff-top archer and a dragon 60 ft over a 10 ft plateau are hidden from a party on the ground beside it. Recommended: keep the simple rule, and mark such a creature always visible, which shows it everywhere on the scene. The exact rule is cheap in arithmetic but makes every visibility rule per creature (section 4.2). **Decided (the project owner, 2026-10-14): as recommended.**
4. **Should walls block players' moves on existing scenes too?** Recommended: on for new scenes, off for existing ones, one switch per scene, so nothing changes mid-campaign without the DM choosing it. **Decided (the project owner, 2026-10-14): as recommended.**
5. **How close must a player's token be to open a door?** Recommended: within reach, with a clear line to the door (section 4.1). The alternative is any door they can see. At first the owner chose the recommendation and set reach at 5 ft or one cell, whichever is more, so a creature beside the door reaches it on any feet-per-cell setting, measured in three dimensions by the room's own distance rule as its ruler measures, so a creature flying above the door does not. **Decided (the project owner, 2026-10-14): as the owner chose.**
6. **Stamp art: one symbolic set, or top-down pictures?** **Decided (the project owner, 2026-10-14): the Prime_8 look.** Prime_8's trees and stones, Liosan's foliage and village elements, and Poly Haven furniture rendered straight down by a committed script, every author credited. No throne or altar in v1 (section 3.5).
7. **Should the DM be able to stamp images from the room's library?** Recommended: yes. It is cheap, and it covers anything the shipped set lacks without the app shipping new art. **Decided (the project owner, 2026-10-14): as recommended.**
8. **Universal VTT portals that don't block light: windows or open doors?** In Dungeondraft, `closed: false` means the portal's "block light" switch is off, which is how windows are made. Recommended: windows by default, with the import dialog's switch for a file that uses it for open doors. **Decided (the project owner, 2026-10-14): as recommended.**
9. **Duplicate defaults** (section 3.2): creatures yes, player characters no, fog no, drawings no. Recommended as listed. **Decided (the project owner, 2026-10-14): as recommended.**
10. **Should a map phase also change the light level** (Night makes the scene dark)? Recommended: yes, as an optional setting on each phase. **Decided (the project owner, 2026-10-14): as recommended.**
11. **May owners set their own senses and lights?** Owners already edit their senses line, and a Custom light lets them pick radii, so they control what the party sees. **Decided (the project owner, 2026-10-14): trusted**, with ranges capped at the SRD's maximums (150 ft for senses, 120 ft for each light radius), and the DM sees what owners set (sections 4.3.1, 4.3.9).
12. **Should a creature squeeze through an opening one size too small?** The SRD makes a narrow opening sized for a creature one size smaller Difficult Terrain, so it can be passed. **Decided (the project owner, 2026-10-14): yes.** A Large creature passes 5 ft doors and corridors and may stop squeezed in one, drawn full size over the walls while every rule counts it at its squeezed size. A Huge one needs 10 ft and a Gargantuan one 15 ft, nobody passes a wall, and the app does not charge the extra movement (section 4.1).
13. **Should a 5 ft rise block walking too?** Many characters can jump 5 ft by the SRD's High Jump, but the request said raised areas are reached by stairs. Recommended: stairs only for every rise, as the request said, with the DM moving a creature that climbs or jumps. **Decided (the project owner, 2026-10-14): as recommended.**
14. **Should initiative rows hide while their creature is out of sight on vision scenes?** Recommended: yes, as rows hide under fog today (design.md 7.3). Players then see "Another creature's turn" while a creature acts out of sight. **Decided (the project owner, 2026-10-14): as recommended.**
15. **Should a blocked drop offer "Teleport here"?** For Misty Step and similar. **Decided (the project owner, 2026-10-14): yes.** The token lands where the player dropped it, the leg is marked as not counting, and the DM gets a note (section 4.1). A review then showed that marking only the teleport left the walk to the wall counted, so the design takes that walk back first: the teleport is one uncounted leg from where the walk began. It is offered past ledges too, as the project owner approved, and climbing stays the DM's move.
16. **Should a door's state stay live on explored ground out of sight?** On a vision scene, a door a creature out of sight opens swings open on players' screens. Recommended: accept it (section 8), since remembering each door's last-seen state is new projection state for little gain when every player already shares the party's sight. **Decided (the project owner, 2026-10-14): as recommended.**
17. **Automatic walls** (section 2.1). **Decided (the project owner, 2026-10-14): yes, as written.** Blank mats keep today's rule, new and existing, since a cell holds one terrain and only that rule keeps a stair corridor, a pillar against a room's edge or a water channel walled. Scenes made from a map image from wave 3 on use Around floor only, so difficult ground, water or stairs painted over the art are not walled in. Universal VTT imports start with no automatic walls, because the file brings its walls. Every scene from before wave 3 keeps today's rule, and the DM can switch any scene's rule in its settings.
18. **Should erasing or clearing raised ground lower the tokens standing on it?** Left in the air, such a token reads as a flier: it draws a flight shadow and passes ledges as fliers do. **Owner default, kept by the project owner on 2026-10-14:** lower them, as painting the ground to 0 does. Erase and Clear land every token that stood on that ground on what is left, in the same undo step, and a flier above or a token inside the ground keeps its elevation.
19. **Should a light level set on the phase that is showing apply at once?** Otherwise it waits for the next switch to that phase, and the setting seems to do nothing. **Owner default, kept by the project owner on 2026-10-14:** apply it at once, as switching to the phase would. Taking the level off the showing phase leaves the scene's level as it is.
20. **Should a hidden combatant revealed on its turn stay shown out of the party's sight?** Revealing a hidden creature on its first turn set `fogExemptAuto` (design.md 13.4), which kept it shown to players for the rest of the fight, in the fog and, on a vision scene, out of the party's sight. **Decided (the project owner, 2026-10-14): a revealed creature follows the normal fog and sight rules.** In the project owner's words: "a monster appearing should then only be visible when players could conceivably see it." So it shows only on revealed ground on fog scenes, and only while the party sees it on vision scenes, and its row follows it, as any creature's does (design.md 9.4). The reducer still writes `fogExemptAuto`, so stored ops replay to the state they made, and it lifts nothing (the wave 4 build differences at the top of this addendum).
21. **Which of a player's tokens reach a door?** **Owner default, kept by the project owner on 2026-10-14:** only tokens the player owns, not the tokens the room lets them move under `playersMoveAny` (section 4.1).

## 10. Sources and what could not be verified

**Universal VTT.**

- Arkenforge, "Universal VTT Files", the format's own description: https://arkenforge.com/universal-vtt-files/ . It lists `format`, `resolution` (`map_origin`, `map_size`, `pixels_per_grid`), `line_of_sight`, `objects_line_of_sight`, `portals` (`position`, `bounds`, `rotation` in radians, `closed`, `freestanding`), `environment` (`baked_lighting`, `ambient_light`), `lights` (`position`, `range`, `intensity`, `color`, `shadows`) and `image` (base64 PNG or WebP), and states that positions and sizes are in squares and that the three extensions are one format.
- The Foundry VTT "Universal Battlemap Importer" by moo-man, MIT, `ddimport.js`: https://github.com/moo-man/FVTT-DD-Import . Read for how a working importer treats the keys: polylines of `{x, y}` points, `bounds` as a portal's segment, `closed: false` as a window (its own hint: portals import as windows when Dungeondraft's "block light" is unchecked), a light's `range` as its dim radius in squares with bright at half, the first two hex digits of `color` dropped, and the image type detected from magic bytes. It does not read `format`.
- Roll20's help article on Universal VTT support, for the format's origin with Dungeondraft's author and the three extensions: https://help.roll20.net/hc/en-us/articles/41643201127831-Universal-Virtual-Tabletop-UVTT-Support

**Not verified:** the unit of a light's `range` (Arkenforge gives none, the importer's reading is followed), what `intensity` means, the exact form of `ambient_light`, which `format` versions exist and how they differ, whether exporters leave gaps in walls at doors, what `closed: false` means outside Dungeondraft, and anything specific to Dungeon Alchemist or DungeonFog exports. No real export was opened.

**SRD 5.2.1** (CC BY 4.0), as the reviewers quoted it with page links: Darkvision, Blindsight ("even if you have the Blinded condition"), Truesight (sees "in normal and magical Darkness"), Tremorsense ("doesn't count as a form of sight"), the light sources (Candle 5/5, Torch 20/20, Lamp 15/30, Hooded Lantern 30/30, the Bullseye Lantern's cone, the Light cantrip 20/20, Daylight 60/60), Difficult Terrain's narrow opening, falling at 1d6 per 10 ft, and High Jump. The SRD has no "Brazier" light, which the first draft listed and later revisions drop. The darkvision wording for dim light ("as if it were Bright Light") was checked against page 180 by two reviewers in round 2. Teleportation spending no movement is on page 190, and the narrow opening on page 181.

**Stamp art.**

- Prime_8, "Trees Top-down fake shadow" (https://opengameart.org/content/trees-top-down-fake-shadow) and "Simple stones" (https://opengameart.org/content/simple-stones), CC0 as each page states.
- "Top down foliage collection" (https://opengameart.org/content/top-down-foliage-collection) and "Top down village elements" (https://opengameart.org/content/top-down-village-elements), submitted by Liosan, CC BY 3.0 as each page states, with the attribution the pages ask for: "Warlock's Gauntlet artists - rAum, jackFlower, DrZoliparia, Neil2D".
- Poly Haven: the license page (https://polyhaven.com/license) was checked and says every asset is CC0, with credit appreciated, not required. The eleven models' authors in section 3.5 come from Poly Haven's own asset data.
- Prime_8's trees download only as `trees_192rez_topDown_png.7z`, and "Simple stones" as `SM_set.zip`. The village pack holds `bonefire_*`, `wood_stack_*`, `broken_wheel_*` and `bucket.png`, as section 3.5 uses (round 5 reviewer check).
- Not verified: the exact sprites inside each download and the mesh names inside each Poly Haven set, which the build script names and pins by SHA-256 when it is written.
- 7zip-bin 5.2.0 (MIT, no dependencies, wrapping a prebuilt 7za, which is LGPL) and yauzl 3.4.0 (already a dependency) were checked by a round 6 reviewer.

**robust-predicates.** Version 3.0.3, Unlicense, by Vladimir Agafonkin (mourner), with no dependencies. Its `orient2d` calls only `Math.abs`, so the banned-call test of section 4.3.4 passes (round 5 reviewers checked the package metadata and source).

**Performance.** The timings in section 4.3.6 come from scratch benchmarks on a development laptop, by the author and by a reviewer. The server and phones were not measured. The budgets are targets that the server-box gate confirms or lowers.

## 11. Review dispositions

Adopted means the doc now does what the finding asked. Changed means it is resolved another way. Declined says why. Round 2 replaced the rules and product reviewer (Fable) with Opus at the project owner's request.

### Round 1


- D34-O-1 adopted: the derived set is split at every crossing once per walls version, with a ray-cast oracle test (section 2.1).
- D34-O-2 adopted: vision settings set `global`, undo included (section 4.3.5).
- D34-O-3 adopted: `path` is stripped for players when fog or vision is on (section 4.3.5).
- D34-O-4 adopted: caches keyed on input identity, committed and staged held apart (section 2.1).
- D34-O-5 adopted: changed chunk boxes grow by 5 cells, free wall length enforced on writes and imports (sections 2.2, 4.3.4).
- D34-O-6 adopted: caps on sources, lights, radii and split segments, lazy lights, a server-wide cache cap, every row gated at the caps (sections 2.4, 4.3.6).
- D34-O-7 adopted as F-16's jamb rule in round 1, then replaced in round 2 by D34-P-1's core rule (section 4.1), and asked of the project owner (question 12).
- D34-O-8 adopted: `thumb` out of scene guards, kept on restore (section 3.3).
- D34-O-9 changed: heights and stairs stored compactly, and sight's maximum reserved in the size guard rather than excluded, as W34-DATA-08 and two confer answers asked (section 2.4).
- D34-O-10 changed: the project owner decided on 2026-10-14 to trust owners, with SRD caps and the DM shown the values (question 11, section 4.3.9).
- D34-O-11 adopted: random ids, players' free walls sorted by coordinates (section 2.2).
- D34-O-12 adopted: reach needs a clear line to the door, the door itself excepted (section 4.1).
- D34-O-13 adopted: explore only on the player scene and never in a blackout, undo interplay stated (section 4.3.3).
- D34-O-14 adopted: phase asset checks and server sizes, one calibration reference (a stored size since round 2), active-phase removal, a pixel tolerance (section 3.4).
- D34-O-15 adopted: chunk allowlist and empty check, erase and clear of heights and stairs, free wall bounds, light preflight (sections 2.2, 3.1, 4.2).
- D34-O-16 adopted: copies clear `fogExemptAuto` and drop uncopied casters (section 3.2).
- D34-O-17 adopted: free areas take the ground as origin height, free lights sit 5 ft above the ground, sources are always shown (sections 3.6, 4.2, 4.3.2).
- D34-O-18 adopted except the walls version side channel, declined as pre-existing (section 8): ledges follow `blockMovement`, Brazier dropped, Hooded Lantern added, thumbnails by long side, `f` defined, byte batching, a phone file cap, Reveal room noted, the 8 MiB effect noted, initiative rows asked (question 14).
- D34-O-19 adopted: section 6.
- D34-O-20 adopted: `autoWalls`, then set in round 2 by the owner's decision (section 2.1, question 17).
- D34-O-21 adopted: imported wall-mounted lights move off the wall, plus the runtime nudge (sections 3.1, 4.3.2).
- W34-ASTRA-01 adopted: as D34-O-1.
- W34-ASTRA-02 adopted: the in-sight test samples the snapped footprint, one predicate everywhere (section 4.3.2).
- W34-ASTRA-03 adopted: a nudge policy for eyes and lights on walls, then made bounded and fail-closed in round 2 (section 4.3.2).
- W34-ASTRA-04 adopted: as D34-O-6, with dark scenes and group moves in the table.
- W34-ASTRA-05 adopted: stairs by mark without floor, and `autoWalls` (sections 2.1, 4.2).
- W34-ASTRA-06 adopted: edges validated as edges (section 3.1).
- W34-ASTRA-07 adopted: Blinded keeps blindsight (section 4.3.2).
- W34-ASTRA-08 adopted: as D34-O-8.
- W34-ASTRA-09 adopted: copied durations re-anchored to the copy and paused (section 3.2).
- W34-DATA-01 adopted: as D34-O-1.
- W34-DATA-02 adopted: as D34-O-5.
- W34-DATA-03 adopted: as D34-O-2.
- W34-DATA-04 adopted: as D34-O-3.
- W34-DATA-05 adopted: as D34-O-6, with "exceeds" in the gate's wording.
- W34-DATA-06 adopted: as D34-O-8.
- W34-DATA-07 adopted for same-batch guards, narrowed in round 2 to the last writer's guard (W34-DATA-15) and widened in round 3 to every matching guard on any stack (W34-ASTRA-14), and stated for later explores and scene removal, which keep today's rules (section 4.3.3).
- W34-DATA-08 adopted: the reserve in `sizeGuard.ts` (section 2.4).
- W34-DATA-09 changed: exact arithmetic makes every replay compute the same marks, instead of storing the decisions (section 4.3.4).
- W34-DATA-10 adopted: reach in feet at the room's scale (section 4.1).
- W34-DATA-11 adopted: the design relies on wave 2's blackout gating of the helpers (section 4.3.3).
- W34-DATA-12 adopted: phases and grids that would put `cellPx` below 1 are refused (section 3.4).
- D34-F-1 adopted: SRD presets only (sections 3.6, 4.3.1).
- D34-F-2 changed to Opus's version: landings write the ground, below the ground is inside it, burrowing kept (section 4.2).
- D34-F-3 adopted: the narrow-opening rule cited (section 4.1).
- D34-F-4 adopted: Blinded and truesight rules (section 4.3.2).
- D34-F-5 adopted: sources are creatures unless the DM marks them (section 4.3.2).
- D34-F-6 adopted: the wall contact rule for raised edges, and stair direction passed along runs (section 4.2).
- D34-F-7 declined: the badge reports absolute elevation by definition, and the shadow marks flight (section 8).
- D34-F-8 adopted for the tap zone, precedence and the action bar button. The DM notice declined as a new event for later (section 8).
- D34-F-9 adopted: the project owner decided on 2026-10-14 for "Teleport here", designed in section 4.1 (question 15).
- D34-F-10 adopted: the alternative's real cost restated (section 4.2, question 3).
- D34-F-11 adopted: turning vision on turns fog on, and the settings explain it (section 4.3.1).
- D34-F-12 adopted: "Duplicating…" and "Updating…" (sections 3.2, 3.3).
- D34-F-13 adopted: the "block light" fact and an import switch (section 3.1, question 8).
- D34-F-14 adopted as a stated simplification, 3D ranges out of scope (section 4.3.2).
- D34-F-15 adopted: lights capped at 120 ft per radius (section 2.4).
- D34-F-16 adopted, then replaced in round 2 by D34-P-1's core rule (section 4.1).
- D34-F-17 adopted: stairs by mark over map images (section 4.2).

### Round 2

- D34-O-22 adopted: secret door projection and the player map export follow the scene's automatic walls rule, so a hidden door is never a gap (section 2.1).
- D34-O-23 adopted: an `autoWalls` change, edit or restore, bumps the walls version, joins every cache key and sets `global` (section 2.1).
- D34-O-24 adopted: the nudge and circle spans need no square root, the sight files are named, `indexPolygon` and `crossingsAt` move out of walls.ts, and areas keep walls.ts's sweep fed the split set (sections 4.3.2, 4.3.4).
- D34-O-25 adopted: a teleport's undo step records it, and its redo skips the wall test (section 4.1).
- D34-O-26 adopted: potential sight pieces are counted whatever the door states (section 2.1).
- D34-O-27 adopted: a stair mark counts as a Stairs cell under each automatic walls rule (sections 2.1, 4.2).
- D34-O-28 adopted: wave 2 is deployed, redo entries follow the guard rule, and party members past the cap stay shown (sections 4.3.2, 4.3.3).
- D34-O-29 adopted: every sweep takes each segment that intersects its box and clips it (sections 2.1, 4.3.4).
- D34-P-1 changed: a core one size smaller swept along the leg or along shifted paths with half-cell shifts at each end, so Large passes 5 ft, Huge 10 ft and Gargantuan 15 ft, and no path crosses a wall. Unrestricted shifted retries declined, since both Codex reviewers showed them crossing walls (section 4.1).
- D34-P-2 adopted: "Teleport here" takes back the stopped walk first, and falls back with a note when it cannot (section 4.1).
- D34-P-3 adopted for the ghost, the door hint and the log line naming a ledge. The ledge keeps "Teleport here" as the project owner approved, and climbing stays the DM's move (section 4.1).
- D34-P-4 adopted: the inside-the-ground notice and its listing among sources (section 4.2).
- D34-P-5 adopted: fliers over a platform are named in section 4.2, question 3 and risk 5.
- D34-P-6 adopted: truesight in darkness is stated as a drawing choice, not an SRD conversion (section 4.3.2).
- D34-P-7 adopted as accepted behavior, recorded in section 8 and asked as question 16.
- D34-P-8 changed: reach follows the room's own distance rule through `legFeet`, not a grown rectangle (section 4.1).
- D34-P-9 adopted: wave 2 is deployed, and the darkvision wording is checked on page 180 (the opening paragraphs, section 10).
- W34-ASTRA-01 adopted with D34-O-29, culled and light boxes in the oracle test.
- W34-ASTRA-03 adopted with W34-DATA-21: directions skip the incident walls, every step stays under 1/32 cell, lands on and crosses nothing, and the source fails closed when none qualifies (section 4.3.2).
- W34-ASTRA-10 adopted: the calibration reference is a stored pair of numbers, so reorder, replace and remove need no rebase (section 3.4).
- W34-ASTRA-11 adopted: as D34-O-23.
- W34-ASTRA-12 adopted: free walls are stored as snapped originals and split only in the derived set, and long walls are cut with their ends on the lattice (section 3.1).
- W34-ASTRA-13 adopted: the split's pairs and pieces are capped on every scene, counted where geometry is written, and refused before allocating (sections 2.1, 2.4).
- W34-ASTRA-14 adopted: as W34-DATA-15.
- W34-ASTRA-15 adopted: world 0 at `floor(map_origin)` with a negative `originPx`, one transform for walls, portals and lights (section 3.1).
- W34-DATA-13 adopted: as W34-ASTRA-12.
- W34-DATA-14 adopted: as W34-ASTRA-13.
- W34-DATA-15 adopted: explore moves only a guard that still equals the tile's value just before it, on undo and redo entries alike, widened in round 3 to entries from any batch (section 4.3.3).
- W34-DATA-16 adopted: the sight tile's shape is defined and its largest entry is the reserve, corrected in round 3 (sections 2.4, 4.3.4).
- W34-DATA-17 adopted: membership decides who is always shown, the cap limits only sight, and actor changes touch the actor's tokens on vision scenes (sections 4.3.2, 4.3.5).
- W34-DATA-18 adopted: as D34-O-22 and D34-O-23.
- W34-DATA-19 adopted: as W34-ASTRA-10.
- W34-DATA-20 adopted: as D34-O-25.
- W34-DATA-21 adopted: with W34-ASTRA-03.
- The owner's automatic walls decision is recorded: on by default, off for Universal VTT imports, overlays never make walls, existing scenes unchanged, the project owner may override (section 2.1, question 17). Corrected in round 3 (D34-P-10).

### Round 3

- D34-O-30 adopted: a segment the core touches at the start is ignored only while the path moves away from its line, toward the start center's side, or either side for a center on the line, and the test now says so (section 4.1).
- D34-O-31 adopted: one painted predicate, terrain or a stair mark, across chunk borders, shared by wall derivation and the secret-door projection, in the equality test (section 2.1).
- D34-O-32 adopted: a drop stopped at its first step teleports with no undo (section 4.1).
- D34-O-33 adopted: eyes were rounded to the 1/64 lattice and lights stored on it. Round 4 replaced the rounding with an exact predicate and a margin (W34-ASTRA-21, D34-O-42).
- D34-O-34 adopted: long imported walls are cut into `ceil(length / (8 - 1/32))` parts and recut until every part is at most 8 cells (section 3.1).
- D34-O-35 adopted: the counting pass runs on restores that write chunks or `autoWalls` (section 2.1).
- D34-O-36 adopted: the core is a rectangle per axis (section 4.1).
- D34-O-37 adopted: imported wall ends are welded within 0.1 square and counted (section 3.1).
- D34-O-38 adopted: risks renumbered (section 7).
- D34-O-39 adopted: the movement test reads the stored segments, exact on the lattice, and the split pieces feed only the area and sight sweeps (sections 2.1, 4.1).
- D34-P-10 adopted as the owner's correction: blank mats keep today's rule, new and existing, scenes from a map image use Around floor only, imports start with none (section 2.1, question 17).
- D34-P-11 adopted: a squeezed token carries a `squeeze` flag, and areas, distances, the ruler, range rings, fog and sight all use its footprint one size smaller, the DM's drops included (section 4.1).
- D34-P-12 adopted: no undo when the walk never moved, and a refused teleport says the walk was taken back (section 4.1).
- D34-P-13 adopted for welding and cutting walls exactly at portal ends. A quarter-cell core for Small and Medium creatures declined: welding closes an import's hairline gaps, and builder walls meet exactly on the grid (section 3.1).
- D34-P-14 adopted: as D34-O-38.
- W34-ASTRA-14 adopted: explore moved every matching guard on any stack. Round 4 replaced that with a separate explored layer (W34-ASTRA-18, W34-DATA-28, the project owner's decision), and both sequences stay in the undo tests (section 4.3.3).
- W34-ASTRA-16 adopted: as D34-O-34, with the reviewer's wall in the import tests.
- W34-ASTRA-17 adopted: as D34-O-30.
- W34-DATA-16 adopted: sight tiles were keyed by their coordinates alone. Round 4 went back to scene-qualified keys with a reserve per scene key (W34-DATA-33, D34-O-40).
- W34-DATA-22 adopted: as D34-O-30.
- W34-DATA-23 adopted: as W34-ASTRA-14.
- W34-DATA-24 adopted: as D34-O-34.
- W34-DATA-25 adopted: as W34-DATA-16, with CJK, quote and control-character IDs in the size test.
- W34-DATA-26 adopted: the geometry rows are gated before wave 3 ships, the sight rows before wave 4 (section 4.3.6).
- W34-DATA-27 adopted: on-wall decisions read the stored lattice segments, never split pieces, so they are exact and leave no uncertain case, and the reviewer's eye on a split wall is in the tests (sections 2.1, 4.3.2).

### Round 4

Round 4 favored simpler, more robust rules over patches, so three earlier rules were replaced rather than patched: eye rounding by an exact predicate, guard moving by a second fog layer, and coordinate-only sight keys by scene-qualified ones.

- D34-O-40 adopted: sight keys are scene-qualified again, and the reserve is computed per scene from its own key (section 4.3.4).
- D34-O-41 adopted: any `token.update` of size, scene or position clears `squeeze`, and the squeeze checks live in `canApply` (section 4.1).
- D34-O-42 adopted: eyes are not rounded, and an eye within 1/4096 cell of a stored sight segment is stepped off on its own side, so a rounded split piece can never pass through or behind it (section 4.3.2).
- D34-O-43 adopted: the server derives each drag frame's squeeze state itself (sections 4.1, 4.3.5).
- D34-P-15 adopted: a squeeze needs a blocker through the full footprint's interior and a squeezed footprint on cell boundaries (section 4.1).
- D34-P-16 adopted as accepted behavior: each leg is measured with the token's current footprint (section 4.1).
- W34-ASTRA-18 adopted by the project owner's decision: an undo takes back only the DM's layer, and exploration stays (section 4.3.3).
- W34-ASTRA-19 adopted: `squeeze` is part of the pose in move undo and redo and in `POSE_FIELDS` (section 4.1).
- W34-ASTRA-20 adopted: squeezed space and the core are defined separately, the core clamped at 0, and only an axis of at least 2 cells squeezes (section 4.1).
- W34-ASTRA-21 adopted: no rounding, the exact predicate, and the step keeps the eye's side (sections 2.1, 4.3.2).
- W34-ASTRA-22 adopted: imported lights are snapped to the lattice after the transform and after the move off a wall, then checked again (section 3.1).
- W34-ASTRA-23 adopted: as D34-O-43, with the hidden-corridor case in the tests.
- W34-DATA-28 adopted: as W34-ASTRA-18. Keeping restore values in step with explore, as the confer suggested, was considered and not chosen: it breaks undo chains (section 4.3.3).
- W34-DATA-29 adopted: as W34-ASTRA-21, for movement centers too (section 4.1).
- W34-DATA-30 adopted: as W34-ASTRA-20, with custom 1.01, 1.99 and 1 x 3 tokens in the tests.
- W34-DATA-31 adopted: as W34-ASTRA-19.
- W34-DATA-32 adopted: the squeezed footprint is centered on the stored center, never snapped, and must lie on cell boundaries (section 4.1).
- W34-DATA-33 adopted: as D34-O-40.
- The project owner's decisions of 2026-10-14 are recorded: questions 6 (the Prime_8 look, with Liosan's packs and Poly Haven renders, built by a committed script, no throne or altar), 12 and 17, and the fog undo rule (sections 3.5, 4.1, 4.3.3, 9).

### Round 5

The project owner said on 2026-10-14 that the fog reveal and undo details are the reviewers' call, so the two fog findings below are adopted as they proposed.

- D34-O-44 adopted: explore compares sight with the explored layer alone and records every seen sub-cell it lacks, ground the DM revealed included, so undoing a reveal never takes away ground the party saw (section 4.3.3).
- D34-O-45 adopted: the explored layer's plumbing is named, from fan-out candidates and `allKeys` to the fog readers, the room import and the size guard, and it is in the projection invariant test (section 4.3.3).
- D34-O-46 adopted: the render launches Chrome headless with SwiftShader's flags, pins `three@0.160.0`, and commits its outputs so later runs need not match bit for bit (section 3.5).
- D34-P-17 adopted: the 7-Zip extraction is named, with the archive and each sprite pinned by SHA-256 (section 3.5).
- D34-P-18 adopted: footprints come from the model's size at 1.524 m per cell, rounded to a quarter cell, and the script names which meshes of a set become stamps (section 3.5).
- D34-P-19 adopted: the CC BY credits link the license and say what changed (section 3.5).
- D34-P-20 adopted: "Teleport here" lands by the squeeze placement, and a Large creature's teleport into a corridor is in the tests (section 4.1).
- D34-P-21 adopted in round 5, then dropped in round 6 by the owner's decision: undoing a hide or reset does not bring back the explored bits it cleared (section 4.3.3).
- W34-ASTRA-24 adopted: as D34-O-44, with the reveal, see, leave and undo sequence in the tests.
- W34-ASTRA-25 adopted: a drag frame is judged by the one-size-smaller footprint centered on the preview point when the core fits and a blocker passes through the full footprint, with no cell alignment, and by the full footprint otherwise. Cell alignment stays for committing `squeeze` (section 4.1).
- W34-ASTRA-26 adopted: as D34-O-45, including fog keys that only the explored layer holds.
- W34-ASTRA-27 adopted: section 8's contradicting line about scene removal is gone.
- W34-DATA-34 adopted: as D34-O-44.
- `robust-predicates` is verified as 3.0.3, Unlicense, with no dependencies (sections 2.1, 10).

### Round 6

The owner dropped D34-P-21 (the project owner had left the fog details to the reviewers, and two reviewers called restoring cleared exploration a policy change rather than a fix). That resolves the findings that rested on it.

- W34-ASTRA-28 resolved by dropping D34-P-21: an undo adds nothing to the explored layer, so it cannot override a later hide (section 4.3.3).
- W34-ASTRA-29 resolved by dropping D34-P-21: there is no exploration-only undo to make replayable.
- W34-ASTRA-30 adopted: the player scene's remaining explored capacity is reserved, from its own key, against the room limit and its projected size, checked on every op and on every op that changes which scene can explore, and an export at the maximum imports (section 2.4).
- W34-DATA-35 resolved by dropping D34-P-21: as W34-ASTRA-28.
- W34-DATA-36 adopted: as W34-ASTRA-30, without counting held tiles twice, tested at a reduced limit.
- W34-DATA-37 resolved by dropping D34-P-21: no restore carries explored additions, so none needs a scene.
- D34-O-47 resolved by dropping D34-P-21: as W34-ASTRA-28.
- D34-O-48 resolved by dropping D34-P-21: there is no redo of explored bits to store.
- D34-P-22 resolved by dropping D34-P-21: as W34-ASTRA-28.
- The drag-frame edge D34-P-22's reviewer noted is accepted: a Large creature dragged past a pillar at the edge of sight can vanish from the preview and reappear on the drop, since the rule errs toward withholding (section 4.1).
- 7zip-bin 5.2.0 (MIT, wrapping a prebuilt 7za, which is LGPL, used only by the build script and never shipped) and yauzl 3.4.0 (already a dependency) are verified (sections 3.5, 10).

### Round 7

- W34-ASTRA-31 adopted: the reserve is the scene's maximum explored layer, at the widest rev, minus the actual size of the tiles it holds, computed per tile inside the bounds so no term is negative, so exploring never raises stored size plus reserve (section 2.4).
- W34-ASTRA-32 adopted: any op that clears explored bits sets `global`, which re-projects the room (section 4.3.3).
- W34-DATA-38 adopted: as W34-ASTRA-32, with a hide outside sight over a monster, a label and a stamp in the projection invariant test.
- W34-DATA-39 adopted: as W34-ASTRA-31, with rev growth across digit boundaries and a size-neutral move right after the layer fills in the reduced-limit test.
- D34-P-23 declined after the round 7 confer: with explored memory off, explore writes nothing, so ground the party sees there would stay fogged, and a working fallback needs a temporary sight mask in the fog merge for a rare case. Moving players refuses instead, with "The room is too full for the party to explore that scene. Turn vision off there, or delete unused scenes to free space." (section 2.4).
- After the build, the owner tightened squeeze check 3 (section 4.1), which 4B and 4F found let a Large creature squeeze half over any single wall in the open: a squeeze now needs a real narrow space, blocked on both sides of the core along a squeezed axis inside the full footprint, with the squeezed footprint fitting between.
