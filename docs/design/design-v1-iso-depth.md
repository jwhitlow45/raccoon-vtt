# raccoon-vtt v1: depth in the isometric view

Status: lanes D1, D2 and D3 built (As built). Draft 3 (2026-11-04), revised after design review rounds 1 and 2 (section 17), with round 3's notes folded in where lane D1 builds them. Decisions D-261102-840 to 849 (draft 1) and D-261102-880 to 889 (draft 2, seven of them amended in draft 3), section 14. A throwaway prototype made the preview shots (section 16) and was abandoned. Code is cited from main at `073ab104`. The reviewers found no change in these trees at `6ae1693e`.

## 1. The owner's words

The project owner, 2026-11-03, playing the deployed site:

- "also in isometric view doors should have their own side texture based on the floor (assuming this is easily doable), im also noticing that at the tops of stairs the walls are visually jutting up on raised platforms"
- "sorry the jutting walls i was looking at were actually doors"
- "stairs should also be slanted to show their direction and not just flat in isometric view"
- "open doors could also use some texture fixups" (with a shot of an open door lying flat as a thin tan strip, its dashed swing arc beside it)
- "to be honest i think we could just use a "depth" review of the isometric view, namely making things appear as having their actual depth and not just being flat in 5 ft intervals. we don't have to go crazy with it but i would like the isometric view to be a bit better about things not being 5ft cubes and having some slants and depth to them if that makes sense?"

Scope from the coordinator: heights stay in 5 ft steps as data, and only the drawing changes. The coordinator's answers to round 1's questions: an upright open leaf takes a tap like its door's line, and raised floors keep their faint square lines when the grid is off.

## 2. Summary

- **Stairs become steps.** A straight run of stairs with a known direction, whose ground below its foot and above its head this viewer has seen, draws as treads climbing evenly from foot to head, five a stair. Raised and sunk runs alike, so a generated run reads as one staircase from corridor to room. Any other stair keeps today's look.
- **Sides wear their floor.** A stair's sides and risers take the floor it is painted on, not the flat cream stairs swatch.
- **Creatures stand on the treads.** A token standing on the ground stands on the tread under it. Drawing, rings, pills, picks and drags all place it on one stand surface, so nothing jumps. Whether it walks, flies or lands is still decided on the rules' ground, and its elevation is unchanged.
- **Doors stand in frames.** A closed door is a thin stained leaf between two stone posts. An open door's leaf stands upright on its hinge, swung into the room as Top-down's swing shows, and a tap on it opens the door's pill, as a tap on its line does. Top-down's flat leaf and arc leave the isometric ground where the leaf stands.
- **Walls get thickness.** Thin stone slabs with a lighter cap, at today's cut height. Windows sit between posts.
- **No more 5 ft cubes.** A raised side is outlined at its top, foot and ends, not at every square. Tops keep a faint square line, grid on or off.
- **Nothing stored changes.** No op, no snapshot version, no server change.
- **Detail follows zoom.** The new shapes draw at 24 px a cell and above (48 in Low power). Below that, today's pieces draw, and every reader (picking, standing, the ground stage, door taps) agrees with what is drawn.

## 3. The run tops the owner saw (no placement bug)

Reproduced in a builder scene and a generated dungeon with Heights on (seed 13RN-VJA6-F4ZM-1Q4J), shots in the screenshots folder `iso-stairs-doors`.

- A run's near landing sits at the room's ground (client/features/dungeon/heights.ts `runFor`), so every generated door at a raised or sunk room has equal ground on both sides: 0 of 1,443 in 600 generated dungeons span a height.
- `wallItems` (relief/pieces.ts) stands each such door on the room floor, `WALL_RISE` tall, the isometric design's own case ("a door on a raised edge stands on the higher ground").
- What reads as a tall stone door is the landing under it: one stone square raised to the room's height, rock on both sides, with the leaf alone on top, since raised rooms show no automatic walls (D-261026-27).
- Ordinary walls at run tops stand as designed: nothing beside the landing and the raised stairs, half a cell beside the lowest stair and the far landing.
- The fix is the look: steps up to the landing (5.2), sides in the run's floor (5.3), the door in a frame (5.5), as the preview showed (16). D-261102-840.

## 4. The audit

What each piece draws today and in this design. Fill calls are counted at one turn with textures loaded (section 7 has the details).

| Piece | Today | Design | Fill calls, today then design |
|---|---|---|---|
| Raised ground | a column a square, every side and top outlined | the same faces, sides outlined at top, foot and ends, tops with a faint square line (5.1) | unchanged fills, strokes about equal |
| Stairs in a run that steps | a column at the stair's ground, the symbol copied on its flat top, cream sides, no piece at 0 ft | five treads a stair along the run's span, risers and sides in the floor (5.2) | about 5, then 13 to 21 a stair |
| Other stairs | as above | unchanged, sides in the floor | unchanged |
| A run's near landing | a stone column the room's height | unchanged geometry, read as the staircase's head | none |
| Closed and locked doors | one zero-thickness wood plane | a stained leaf between two posts (5.5) | 2, then 12 |
| Open doors | Top-down's flat leaf and dashed arc on the ground | the leaf upright on its hinge, posts, no arc where it stands (5.5) | 0, then 12 |
| Secret doors not found | a wall | unchanged | as walls |
| Windows | a half-clear plane | the pane between two posts | 1, then 7 |
| Walls | zero-thickness stone planes | 0.14 cell slabs with a cap (5.6) | 3, then 6 |
| Pillars | stone drums | unchanged | none |
| Pits | floor copied down, far sides | far sides darker toward the floor (5.7) | 1 more a far side |
| Pit terrain, rubble, difficult ground, water, stamps | ground marks and textures | unchanged (5.8) | none |
| Standees | on the drawn ground | on the stand surface, treads included (5.4) | none |
| Areas | cut by drawn ground | unchanged, cut by stored ground across treads (5.4) | none |
| Hex scenes | hex prisms, flat stair tops | the same rules in lane D4 (5.9) | as squares |

## 5. The pieces

### 5.1 Raised ground

- **Sides.** Each visible side keeps its fills. Its top edge and foot are stroked. A vertical edge is stroked at each end of a side, except between two side-by-side sides on one line with the same top, the same foot and the same look. So a silhouette's left and right ends, concave corners and every point where a neighbor's height changes the top or the foot keep their line, and a long even side reads as one face.
- **Tops.** A top strokes its rim (each square side whose drawn neighbor is lower) in the edge color, and every square inside it in a faint line (black at 16%), whether the scene's grid shows or not, so squares stay countable on raised floors. The ground's own grid still copies on.
- **Lip (lane D5, optional).** A 0.04 cell lighter band along a rim.

### 5.2 Stairs as steps

**Runs.** On squares, a stair's direction is `WallSet.stairAt` (shared/rules/walls.ts), what Top-down's chevron and movement read, and for a player only what the player's chunk carries (`upDir`). A run is a straight chain of stairs, each pointing the same way d, each the down neighbor along d of the next. Its foot is the square before its lowest stair, its head the square past its top one. Let n be its stairs, F the foot's drawn ground and H the head's.

**Which runs step.** All of these, else every stair of the run keeps today's look:

1. the foot, the head and every stair of the run lie in the scene and this viewer has seen them (`seenGround` not null, heights/ground.ts),
2. H is higher than F,
3. each stair's own stored ground lies inside its span (below), so treads never stray from the rules' ground by more than one span,
4. the detail flag is on (section 7).

**Spans.** Stair i of the run, from 0 at the foot, spans F + i(H - F)/n up to F + (i + 1)(H - F)/n. Its tread k, from 0 at its low edge to 4, covers the fifth of the square from k/5 to (k + 1)/5 of the way up, at its span's low end plus k fifths of the span. The head's own side is the last riser.

- **A raised run to a 10 ft room** (stairs at 0 and 5 ft, foot 0, head 10): treads 0 to 4 ft on the lower stair, 5 to 9 on the upper, then the landing. Draft 1's local rule gave the same.
- **A sunk run to a -10 ft room** (`runFor` puts its stairs at -5 and 0 ft, pointing up away from the room): foot -10 (the near landing), head 0 (the far landing), so treads -10 to -6 on the -5 stair and -5 to -1 on the 0 stair. No cliff. Draft 1's local rule left the 0 ft stair flat and a 5 ft cliff at the room (ISOD-01).
- **A sunk run to a -5 ft room** (one stair at 0 ft): treads -5 to -1 ft on it.
- **A dais stair** (at the room floor, up to the dais): one span from the floor to the dais.
- **A builder stair at 5 ft between 0 and 10 ft:** one span, treads 0 to 8 ft in 2 ft steps, its stored 5 ft inside.
- **Equal foot and head, a corner, an unseen or off-scene end, a stair with no direction, a stair whose ground falls outside its span:** today's look.

**The run index (D-261102-884).** One shared function, `stairRuns(stairAt, drawnGround, seenGround)`, walks each run once from its foot, so its cost is linear in stair cells, and gives each stepping stair `{ d, lo, hi }`. It is built with `drawnHeights` (client/lib/view.ts) and carried on the `DrawnHeights` object, so the relief (IsoBoard.tsx), the picks, `tokenBase`, `heldPoint` and the drag (boardPick.ts `DrawnHeightsMemo`, isoDrag.ts `levelsOf`, which caches per `DrawnHeights`) all read one result. Its direction reader is `WallSet.stairAt`: a DM's directions come from the walls' rule, not the chunks (shared/rules/walls.ts). `DrawnHeightsMemo` is keyed on the detail flag and on that reader's identity too, besides what it keys on today (R2-01).

**Signatures.** `sameSig` (buckets.ts) compares by identity, so each bucket's signature carries one string, `x,y,d,lo,hi;...`, for the stepping stairs of its own chunk and of the four chunks beside it, since a neighbor's sides read them (below). An edit anywhere along a run, however long, then rebuilds every bucket whose stairs or neighbors' stairs change, and only those (ISOD-02, R2-02, R2-03).

**Edge profiles (ISODEPTH-ASTRA-09, R2-03).** Every face between two cells reads both cells' edge profiles on their shared edge, never a stepping stair's stored ground. An ordinary cell's profile is its drawn ground, flat. A stepping stair's is its treads along that edge: flat at its span's low end on its foot side, flat at its top tread on its head side, and stepped on its two outer sides. So:

- a column's side facing a stair's outer side runs down to the stepped profile, not to the stair's stored ground, which left a hole above the low treads of a stair whose span starts below its ground,
- a pit's far side runs up to the lower of the neighbor's profile and 0, so a sunk landing beside its run's lowest stair (stored at 0, its foot at -5) draws no face across the entrance, where `facesOf` (pieces.ts) would draw a full one from -5 to 0,
- two stairs of one run meet at a riser from the lower one's top tread to the upper one's first, one step, not the gap between their stored grounds,
- pit regions join through stairs by their profiles (a stair whose span starts below 0 is an opening).

**The piece.** A stepping stair is a third kind of cell piece, `steps`, sorted with columns' rank, whatever its stored ground, 0 ft included (ISOD-12).

- **Above 0**, tread k is a slab from 0 or its neighbor's edge profile up to its height, drawn far to near along d. Each slab draws its face toward the viewer along the run and its outer side facing the viewer, then its top. A zero-height slab, a face of no height and a back face that a nearer, higher slab always covers are skipped (ISOD-16). No column body is drawn under a stair whose span starts below its stored ground: the slabs are its body.
- **Below 0**, the stair is an opening, as a pit is. Its square at 0 joins its pit region (buckets.ts `#findRegions` counts a stair whose span starts below 0), and inside the region's clip it draws its treads far to near, then its far sides from the tread profile up to the neighbor's edge profile or 0, whichever is lower. Standees on it are clipped by the region, as standees in pits are.
- **Tops copy the ground** at each tread's own height, as every top does, so fog, sight, the grid and map art carry onto the treads. No tread is filled with a texture where fog could lie.
- **Batching (ISOD-08).** A stepping stair flushes `drawRun`'s held tops before it draws, and copies its own tread tops. `tonedCell` and `tonedBoxes` test each tread at its own lift, so the kept picture repaints a tread whose source crosses the ground canvas's edge.
- **The ground stage** leaves out the whole stair symbol under a stepping stair: its cream slab (`paths.stairs`, filled with `STAIR_SLAB`), treads, risers and chevron (builder/draw.ts). `buildPaths` filters stairs one by one, as `BuilderLayer` filters standing pillars, memoized by the stepping set's content, so a fog change that steps nothing new redraws nothing (ISOD-06).
- **Why steps, not a ramp:** a ramp reads as a slide, hides the squares' count and asks picking for a sloped surface. Steps keep level surfaces. D-261102-841 and D-261102-880.

This supersedes the "no ramp surface" part of D-261030-463 (iso hex relief 5.3) for drawing only. The owner saw the flat stairs and asked for this, and is told of the switch.

### 5.3 Sides wear their floor

- A stair's risers and sides take its square's terrain: the floor a stair mark is painted on, stone for a Stairs terrain square (stone under its symbol in Top-down, builder/geometry.ts `buildDrawing`), the map tint for a mark over a map image (looks.ts `cellLook`). Today they take the stairs swatch, `#bdb4a6`. D-261102-843.
- A generated run is stone corridor, so its treads, risers and landing all wear stone, and the landing reads as the staircase's head.
- Hexes keep the stairs swatch until lane D4.

### 5.4 Standing on steps

**One stand surface (D-261102-882).** `standSurface(heights, cells, center)` in client/lib/view.ts is, over a footprint's cells, the highest of each cell's surface: its drawn ground, or for a stepping stair the tread under the point of that cell nearest the footprint's center. A token stands on the ground when its lift is 0: its elevation equals its footprint's seen ground (`standing` is "ground", rules/heights.ts). With the detail flag on, the surface replaces `drawnFootprintGround` for such a token only. Every other lift keeps `drawnBase` (R2-05). So:

- **A Medium on a stair** stands on the tread under its center (tread 2 once snapped).
- **A Large straddling a stair and a higher landing** keeps the landing's support, as today's highest-ground rule does.
- **A flier** keeps `drawnBase`: its elevation, never a tread. **A token inside the ground** keeps its base. **A rider** stands on its holder as today, and its holder stands on the surface.
- Treads can lie below a stair's stored ground (sunk spans), so a token there stands lower than its stored ground. That is the drawn picture of the same rules' height.

**Every reader takes it (ISODEPTH-ASTRA-02, ASTRA-03, ISOD-07).** `drawnStandBase`, built on `standSurface`, replaces `drawnBase` wherever a drawn base is read: the standees and their culling (IsoBoard.tsx), `tokenBase` in canvas/boardPick.ts (anchors, `heldPoint`, pills, the action bar), the drag (canvas/isoDrag.ts `dragPlan`) and the dragged token's moving marks (canvas/DragMarks.tsx).

**The drag: rules decide, the surface places (ISODEPTH-ASTRA-10).** `dragGround.footGround` stays the footprint's drawn ground, the rules' ground as this viewer has seen it, and it alone decides every branch of `byRule` and `dragLanding` (canvas/isoDrag.ts): whether a flier stays up or meets higher ground, a buried token's fixed base, and a seat kept or left. A flier 1 ft over stored ground 0 stays a flier over a 2 ft tread. `dragGround` gains a second query, `surface`, the stand surface at a snapped spot, and only a result that stands on the ground uses it: the walk scan, and a flier's or rider's landing once the rules have decided it lands, cast the ray at each level of `levelsOf`, which gains the stepping stairs' tread heights, and keep the first spot whose surface is that level, failing one the first above, as the scan does today. So the ring a press grabs is where the scan finds it again, and a still pointer never moves the token. The drop's stored elevation is still the rules' (drop.ts `dropLanding`).

**Picks.** `pickWalk` (client/lib/view.ts) walks a stepping stair's treads as level tops along the trace, the near-face rule per tread, so a press on a tread or a riser lands on its stair. The point returned and the ruler's stored z are as today.

**Accepted, later work:** pins, pings, map labels and ruler ends on a stair read `heights.atPoint`, the stair's drawn ground, so they sit up to a span above or below the treads. Areas keep cutting against the stored ground, so an area's band crosses the treads. A flier just above a stair draws by its elevation, which can lie below the tread under it, so it draws below the visible tread (design review round 3). The drag's rule stays: the rules' ground decides, and a flier keeps its height.

### 5.5 Doors and windows

**One frame for one door (D-261102-885).** A door's frame comes from the whole door, never from a piece: a grid edge's own frame, or a free door's `freeFrame` and `freeSwingSide` (builder/draw.ts). `wallPieces` splits a door at fog gaps, squares, free-wall crossings and hex sides (relief/runs.ts `piecesOf`), so each piece now carries its door's segment and its own range of parameters along it, and draws the parts of the frame inside that range:

- **Posts:** the first and last 0.15 of the door's length (`stubOf`, at most 0.15 cell), 0.2 cell thick, full wall height, in the wall's stone.
- **Closed and locked leaf:** between the posts, 0.07 cell thick, 0.92 of the wall's height, in stained wood. The DM's lock mark stays on the ground.
- **Window pane:** between the posts, as today's pane.
- **Secret doors not found:** a wall, unchanged.

So lifting fog never adds posts or moves a hinge. Each piece stands on the higher drawn ground beside it, as today.

**The open leaf** is one item for its door, not a piece's:

- Hinged at the first post's inner end, swung a right angle to the side `swingSide` or `freeSwingSide` picks (into floor, never into rock), its length the opening's, `len - 2s`, which on a free door runs to almost the door's whole length. Its bounds come from that length.
- It stands at its hinge's base, the frame's, so opening a door never parts the leaf from its post. Over a lower floor in its swing square it clears that floor, as a hinged door does (ISODEPTH-ASTRA-11, which corrects draft 2's leaf on the swing square's ground).
- It sorts by its own midpoint, apart from the frame.
- It stands only where `boxStands` holds over its own footprint (relief/stand.ts), the stand rule for anything upright. Otherwise it lies flat on the ground stage, Top-down's leaf with its arc, as a pillar that fails the rule does (BuilderLayer.tsx `standing`). Judging it by the door's line would stand it over fog and show which side is floor.
- The ground stage leaves out Top-down's open leaf and arc for each door whose leaf stands, filtered one by one in the same memo as the stairs.

**Taps and pills (D-261102-886).**

- `doorPiece` (doors/tap.ts) returns the frame's standing stretches for an open door too, with the detail flag on, so `doorPieceStands` and the pill read the frame for open and closed doors alike. The pill hangs over the frame's top when the stretch at the door's middle stands, else over the line as today (ISODEPTH-ASTRA-05).
- A standing open leaf adds its own band, swept up its height, to `doorGap`, so a press on the leaf finds the door as a press on its line does: `tapDoor` (doors/tap.ts) opens the door's pill, and the pill's Close, with its reach check and opener (DoorPill.tsx), closes it (ISOD-10, the coordinator's answer, ISODEPTH-ASTRA-12). With the flag off, both are today's.

### 5.6 Walls

- A wall piece draws as a slab 0.14 cell thick, centered on its line and carried on past each end by half its thickness, so two walls meeting at an L leave no notch (ISOD-11), from its base to its top as today. It fills its sides facing the viewer and a lighter cap. The cut height stays `WALL_RISE` (ISO-D7), and automatic walls beside raised ground stand as today (D-261026-27).
- **Joints.** Collinear slabs of one wall with the same base and top stroke no line between them, by the rule of 5.1, so walls stop showing a seam every square.
- **Depth.** A slab reaches 0.07 cell into each square beside it. A nearer column at the same height draws its top after the wall and covers that sliver of the slab's foot. Negligible. Draft 1 cited the isometric design's corner error for this, which is about walls meeting at an end (ISOD-15).

### 5.7 Pits

Pits keep their opening clip, copied floor and far sides, each far side reading its neighbor's edge profile (5.2). Their far sides darken toward the floor with one gradient fill each, so depth reads. A near-rim lip is lane D5. Sunk stairs draw inside their region (5.2).

### 5.8 Terrain overlays

- **Pit terrain** (the builder's Pit square at 0 ft) has no depth in the rules: a creature on it stands at 0. It stays a flat black square.
- **Rubble, difficult ground, stamps** stay ground marks and pixels. **Water** set below its rim is lane D5, for the owner's word.

### 5.9 Hex scenes (lane D4)

Hex stairs step the same way along their facing ("0" to "5" from `stairAt`): runs along one facing, treads as strips across the hex at right angles to it, clipped to the hex polygon, sides in the stairs swatch. Hex walls are free walls and take 5.6's slab. Hex prisms take 5.1's outlines.

## 6. Depth order and bounds

- **Keys are unchanged.** A stepping stair sorts by its square's center with columns' rank, its treads inside its own piece. A standee draws after its own cells at or below its base (isometric design 5.6). A stepping stair counts there by the low end of its span, so a standee on its treads draws after it.
- **The head and the foot** are one square away along d, so the sort already draws them before or after the steps: when the run rises toward the viewer the head draws after and covers the last slab's back, and when it rises away the head draws first and the steps cover its side's foot.
- **The open leaf** sorts by its own midpoint (5.5), so a standee or a column in the square it swings into orders against it, not against the door's line.
- **Bounds do not depend on the detail flag** (ISOD-03). A cell piece's bounds take every height its steps or column could draw: a stair's whole span, at both levels. A wall's take half its thickness past every side and end. A door's take its open leaf's swept square from its actual length. A property test holds every drawn vertex inside the bounds at every turn, since a piece drawn past them is culled at a screen's edge and lost from a kept picture's strip.

## 7. Detail level, cost and phones

**One detail flag (D-261102-883).** `detail(scale, lowPower)` is true at 24 px a cell and above, 48 in Low power. ISO-D12's flat threshold (12, 24 in Low power) stays below it. The flag lives in `DrawnSource`, in `DrawnHeightsMemo`'s key and in the iso context (relief/context.ts), and every reader of steps, frames and leaves takes it from there: the relief's pieces (through `global`, so crossing it rebuilds every bucket, which a zoom does rarely), `pickWalk`, `standSurface` and the drag, the ground stage's filters (BuilderLayer.tsx), `doorPiece` and `doorGap`. With it off, today's pieces, picks, bases and ground draw together.

**Fill calls (ISOD-13, ISODEPTH-ASTRA-07).** `fillSide` makes up to three fills a face: the texture, a tint, the light. The design keeps that down by:

- baking each tint into its pattern once (stone with the wall tint, wood with the door stain), made per texture as `patternOf` makes patterns now, so a wall or leaf face is two fills, the pattern and the light,
- drawing posts in one flat blended tone, a fill a face, since a 0.15 cell post shows no texture.

| Piece, loaded textures | Faces | Fills today | Fills design |
|---|---|---|---|
| Column side | 1 | 2 | 2 |
| Wall piece | 2 sides and a cap | 3 (one plane) | 6 |
| Closed door | 2 posts and a leaf, each 2 sides and a cap | 2 | 12 |
| Open door, standing | as closed | 0 | 12 |
| Window | 2 posts and a pane | 1 | 7 |
| Stair rising away from the viewer | 5 tread copies, 4 risers, 4 outer sides | about 5 | about 21 |
| Stair rising toward the viewer | 5 tread copies, 4 outer sides | about 5 | about 13 |

With a texture not yet loaded, a face fills one blended tone, so the counts about halve. Strokes stay about as many as today.

**On the phone stand-in** (390 by 844 at 2x) at 40 px a cell, a square projects to half a view unit squared, 800 px², so the screen shows about 400 squares (R2-04). How many of them hold walls, doors and stairs depends on the map, so the bench's counters on the generated scene give the piece counts and fills, not this design.

**The bench (ISODEPTH-ASTRA-08, ISOD-13).** scripts/bench-iso.ts today has the typical (40 by 30), caps (200 by 200) and areas scenes. The lanes add:

- **a generated dungeon scene:** 50 by 50, Heights on, a fixed seed with raised and sunk rooms, in the gated squares rows,
- **rows** for a pan, a local drag up a run and a turn, at 40 and 24 px, and with Low power at 48 and 64 px, so Low power draws the detail,
- the caps scene at 24 px, and at 48 px with Low power.

The gates stay as the bench applies them today (scripts/bench-iso.ts, both run by `formatReport`). `gate` holds every row, caps included: a row at most max(16 ms, 1.75 times Top-down's), every frame of a build held to it, and a turn at most 150 ms whole. `largestGate` holds the largest single move to the same budget on the squares and hex fixtures, and only reports it on the caps (D-261030-538 and 541) (ISODEPTH-ASTRA-13). A miss is reported for review, never hidden by moving a threshold.

**Sight and memory.** Nothing reads or changes sight. Sides and walls keep no sight darkness, as today. Stepping stairs keep their tread polygons per turn beside their shape (drawRelief.ts `cellShapes`), five small arrays each, and the run index holds one entry a stepping stair.

## 8. Privacy

- A run steps only when its foot, head and stairs are seen and in the scene (5.2), so a sunk stair beside unseen ground, whose drawn ground reads 0, does not step toward it (ISOD-04, ISODEPTH-ASTRA-06).
- A player's stair direction is the projected `upDir` (shared/project.ts `shownUpDir`), which the server works out from real cells and which Top-down's chevron already shows. Steps add nothing to it.
- Tread tops copy the ground stage, fog included.
- A frame stands only along its door's standing stretches (`runStands`). An open leaf stands only where `boxStands` holds over its own footprint. A secret door not found is a wall.
- **The property test** holds a player's projected chunks fixed (`known`, `auto` and `upDir` included) and varies only cells the player has not seen: the player's pieces, picks, stand surfaces and pixels stay the same at every turn, with the detail flag on and off.

## 9. What does not change

- Stored data: heights in whole feet, stair marks, terrain, edge features, free walls. No op, no snapshot version, no server code. D-261102-848.
- The rules: moves, ledges, stairs, sight, elevation, the drop's landing, the ruler's z, the badge's number.
- Top-down, the map export, the table display's Top-down. `WALL_RISE`, ISO-D7, D-261026-27.

## 10. UI checklist

- **Words, keys, settings:** none new. Detail follows zoom and Low power.
- **Loading:** no new asset. Stone and wood load with the first Isometric view, behind the shared indicator.
- **Screen readers:** unchanged. A tap on an open leaf opens the door's pill, as a tap on its line does, and the pill's buttons say what they do.
- **Alignment:** no chrome change. The door pill's place over the frame is checked in the e2e.
- **Themes:** the board draws the same relief in dark and light.

## 11. Cases

| Case | Expected | Test |
|---|---|---|
| Generated runs to +5, +10, -5 and -10 ft rooms, each turn, both landings | even treads from foot to head, no cliff, the door's frame on the room floor | steps property, iso e2e |
| The faces those runs share with their landings, beside squares and each other | each face from one edge profile to the other: none across a sunk run's entrance, one step between two stairs, a column's side stepped down to a stair's low treads | faces unit, pixel check |
| A neighbor chunk's stair edited | the bucket whose side reads it rebuilds | buckets unit |
| A stair to equal ground, with no direction, at a corner, with its ground outside its span | today's look, floor sides | steps unit |
| A player's sunk stair whose head is unseen, or off the scene | no steps | security unit |
| The same, hidden cells changed with projected chunks fixed | the same pieces, picks and pixels | security property |
| An edit two chunks up a long run | the far stair's bucket rebuilds with its new span | buckets unit |
| A Medium on a stair, a Large on a stair and a landing, a flier over a stair, a rider on a mount on a stair | on its tread, on the landing, at its elevation, on its holder | stand surface unit |
| A flier 1 ft up dragged over raised and sunk spans, then released | stays a flier over every tread, lands only on rules ground above it, stored elevation the drop's | isoDrag unit |
| A press held still on a token on a stair, a drag onto and off a run, each turn, 23 and 24 px | no jump, the ring under the finger, the drop's elevation unchanged | isoDrag unit |
| A press on a tread, on a riser, beside the stair | that stair, that stair, the square behind or beside | pickWalk unit |
| A stair after a batch of tops at its lift, a pan where a tread's source crosses the ground canvas's edge | the treads over the tops, the tread toned and repainted | drawRun unit |
| Stairs terrain, a mark on wood, a mark on a map | stone, wood, the map tint | looks unit |
| A door split by fog into two stretches, a free door crossed by another, a long free door, a door on a hex side | one frame, posts only at its ends, the leaf's parts in the stretches | frame unit |
| An open door on a ledge swinging down, opened and closed, and with its swing square fogged | the leaf at its hinge's base, clear of the lower floor, the same base open and closed, then the leaf flat with its arc | leaf unit |
| A press on a standing open leaf, then the pill's Close | the door's pill opens, then the door closes, by its reach check and opener | doorGap unit, iso e2e |
| An open door closed, a closed door opened, at 23 and 24 px | the pill over the frame at 24, over the line at 23 | pill unit |
| A wall L corner, a long straight wall | no notch, no seam each square | wall unit, pixel check |
| A long raised side, a concave corner, a side whose foot changes | lines at the ends, the corner and the change only | outline unit |
| Every piece kind, random sizes, spans and heights, each turn | every drawn vertex inside its bounds, flag on and off | bounds property |
| 23 and 24 px, Low power at 47 and 48 | draw, pick, base, ground stage and door tap all today's, then all detailed | detail unit |
| The bench rows of section 7, a caps pan over budget, a 200 ms caps turn | inside the gate, then OVER from `gate` | bench, bench unit |

## 12. Tests

- **Geometry properties (fast-check):** spans tile a run from foot to head with no gap and no overlap, and treads rise strictly. A stair's five treads tile its square. Slabs and treads draw far to near at every turn. A slab draws exactly the faces facing the viewer. Every drawn vertex lies inside its bounds. Mutants: spans from each stair's own ground (draft 1's rule, the sunk case fails), no ends-seen test (the security property fails), no span check.
- **Index and signature:** an edit at a run's far end rebuilds the near stair's bucket, and a stair edit rebuilds the neighbor bucket whose side reads it. IsoBoard and `DrawnHeightsMemo` read one index, rebuilt when the detail flag or the direction reader changes. Mutants: a signature without the stairs' entries, without the neighbors' entries, an array of objects compared by identity.
- **Edge profiles:** the shared faces of generated raised and sunk runs at every turn, as faces and as pixels. Mutant: `facesOf` reading a stair's stored ground (the sunk entrance gets its full face).
- **Stand surface and drag:** the cases above. Mutants: a flier on a tread, `footGround` replaced by the surface (the 1 ft flier lands on a 2 ft tread), the highest-ground rule dropped, levels without tread heights (the still pointer moves the token).
- **Detail agreement:** at 23 and 24 px, draw, pick, stand surface, ground stage and door tap agree. Mutant: picking without the flag.
- **Doors:** one frame across split pieces, the leaf at its hinge's base, its stand rule, its tap opening the pill, the pill's Close. Mutants: a frame a piece, the leaf on the swing square's ground (it parts from its post), the leaf by the line's stretches, a leaf tap that toggles the door.
- **Batching and tone:** a stair after held tops, a toned tread. Mutant: no flush before steps.
- **e2e (iso.e2e.ts, ISOD steps):** a builder scene with raised and sunk runs and an open door. Through the test hook's layout the run's stairs carry steps with their spans, a tread's middle and a riser's sample different brightness, the open leaf shows wood above its hinge while the ground under the old flat leaf shows floor, a tap on the leaf opens the door's pill over the frame, and its Close closes the door. Mutation: stairs drawn flat fails the steps step.
- **Bench:** section 7's rows.

## 13. Lane plan

| Lane | What | Files | After |
|---|---|---|---|
| D1 | runs as steps with the index and signature, stair sides in their floor, the stair symbol left out, the stand surface in every reader, picks per tread, the detail flag | relief/pieces.ts, relief/drawRelief.ts, relief/buckets.ts, relief/IsoBoard.tsx, relief/context.ts, relief/standee.ts, client/lib/view.ts, canvas/boardPick.ts, canvas/isoDrag.ts, canvas/DragMarks.tsx, builder/draw.ts, builder/BuilderLayer.tsx, scripts/bench-iso.ts, tests | none |
| D2 | door frames from whole doors, the upright open leaf with its tap, pill and stand rule, windows in frames, the arc left out | relief/runs.ts (`wallKind` stops returning null for open doors, pieces carry their door's segment, `wallPieces` takes `isFloor`), relief/pieces.ts, relief/drawRelief.ts, relief/IsoBoard.tsx, doors/tap.ts, doors/DoorPill.tsx, builder/draw.ts, builder/BuilderLayer.tsx, tests | D1 |
| D3 | wall slabs with caps and joins, the outline rule, baked tinted patterns | relief/drawRelief.ts, relief/pieces.ts (bounds), relief/looks.ts, tests, bench rows | D1 |
| D4 | hexes: runs along facings, hex outlines | relief/drawRelief.ts, relief/pieces.ts, client/lib/view.ts hex walk, tests | D1, D3 |
| D5 (optional) | lips, pit depth shading, water inset | relief/drawRelief.ts | D3, the owner's word |
| Docs | FEATURES.md, the DM guide's Isometric section with new shots | docs lane | D1 to D3 |

D1 also edits relief/pieces.ts `facesOf` for edge profiles. D1, D2 and D3 all edit relief/drawRelief.ts, so they run in that order, each rebased on the last. D-261102-849.

**Stale text each lane amends (ISOD-14):** docs/design/design-v1-isometric-view.md 5.5 (the stair swatch, stairs as columns, "an open door lies flat") and its As built line on the pill over an open door's line, docs/design/design-v1-iso-hex-relief.md 5.3 (D4), the comments on relief/runs.ts's wall kinds and `wallKind`, doors/tap.ts `doorPiece`, builder/draw.ts `DrawBuildOptions.standing` (which says open doors still draw), and relief/pieces.ts `CellPiece` ("a raised cell or a pit").

**FEATURES.md sentences** for the docs lane, in its Isometric view subsection:

- "Stairs with a direction climb in steps from the ground below them to the ground above, and their sides show the floor they are on. Creatures stand on the steps."
- "Doors stand in a stone frame. An open door stands swung back into the room, and tapping it opens the door's buttons, as tapping its doorway does."
- "Walls have thickness, and raised floors read as one surface rather than a stack of squares."

## 14. Decisions

Draft 1, kept unless a draft 2 decision says otherwise:

- **D-261102-840 Run tops:** no door placement fix (section 3). Rejected: flat doors on raised edges, walls on raised rooms, changing the generator's landing.
- **D-261102-841 Stairs:** level treads, no ramp, overriding D-261030-463 for drawing only. Draft 1's local rule is replaced by D-261102-880.
- **D-261102-842 Standees on treads:** replaced by D-261102-882.
- **D-261102-843 Stair sides:** the stair's floor. Rejected: the cream swatch, new art.
- **D-261102-844 Doors:** leaf in a frame, open leaf upright, the arc left out where it stands. Refined by D-261102-885 and 886.
- **D-261102-845 Walls:** 0.14 cell slabs with a cap. Joins and ends by D-261102-888.
- **D-261102-846 Outlines:** replaced by D-261102-888.
- **D-261102-847 Detail level:** 24 px, 48 in Low power. One flag for every reader by D-261102-883.
- **D-261102-848 Data:** nothing new stored.
- **D-261102-849 Delivery:** lanes D1 to D5 and docs, D1 to D3 in order.

Draft 2, seven amended in draft 3 (no new ids were free, so each amendment is logged under its own id with its rejected options):

- **D-261102-880 Spans per run:** a straight run of stairs climbs evenly from its foot's ground to its head's, five treads a stair, treads allowed below a stair's stored ground, a span below 0 drawn as an opening in its pit region. Rejected: draft 1's local rule (sunk runs keep a flat stair and a 5 ft cliff), changing `runFor` to put sunk stairs at the low end (moves golden plans and leaves stored dungeons as they are), steps for generated runs only (a builder run of the same shape would differ). Amended in draft 3 (ISODEPTH-ASTRA-09, R2-03): every face between two cells reads both cells' edge profiles, a stepping stair's being its treads along that edge. Rejected: faces from stored stair grounds (a full face across a sunk run's entrance, a hole above a stair's low treads), each stair drawing its neighbors' faces itself (two owners for one face).
- **D-261102-881 Seen ends:** a run steps only when its foot, head and stairs are seen and in the scene, its head is higher, and each stair's ground lies in its span. The privacy property holds projected chunks fixed. Rejected: drawn ground alone (unseen ground reads 0, above a sunk stair), a property that varies hidden cells through the projection (`upDir` moves with them, as Top-down's chevron does).
- **D-261102-882 One stand surface:** for a token standing on the ground, the highest over its footprint of each cell's surface, a stepping stair's being the tread nearest the footprint's center, read by drawing, `tokenBase`, rings, pills, drag levels and `footGround`. Fliers, buried tokens and riders keep their rules. Rejected: the tread under the center alone (a Large loses a higher landing's support), fliers on treads, a drawing-only change (a still drag jumps to the old ground). Amended in draft 3 (ISODEPTH-ASTRA-10, R2-05): standing on the ground is lift 0, the rules' seen ground alone decides flight, burial, landing and seats, and the surface only places a result that stands. Rejected: `footGround` replaced by the surface (a flier 1 ft up lands on a 2 ft tread).
- **D-261102-883 One detail flag:** in `DrawnSource` and the iso context, read by every reader, crossing it rebuilding every bucket, bounds the same with it on and off. Rejected: a threshold per reader (picks and bases out of step with the drawing between 12 and 24 px), bounds that change with the flag (stale culling across a zoom). Amended in draft 3 (R2-01): the flag keys `DrawnHeightsMemo` too.
- **D-261102-884 Stair runs in the signature:** a run index per sync, each bucket's signature holding its own stairs' spans by value. Rejected: a wider ring of neighbor chunks (a run can be longer), rebuilding every bucket on any stair edit. Amended in draft 3 (R2-01 to 03): one `stairRuns` function built with `drawnHeights` and carried on `DrawnHeights`, read by the relief, picks and drag, the memo keyed on the direction reader, and each signature one string of its own and its four neighbor chunks' entries. Rejected: an index the relief builds alone (picks and drags would read another), an array of entries (`sameSig` compares by identity).
- **D-261102-885 Frames from whole doors:** pieces carry their door's segment and range and draw their share of one frame. The open leaf is one item a door, at its hinge's base (amended in draft 3, ISODEPTH-ASTRA-11), keyed at its own midpoint, standing by `boxStands` over its footprint, else flat with its arc. Rejected: a frame a piece (extra posts, a hinge that moves as fog lifts), the leaf on the swing square's ground (draft 2's, it parts from its post across a ledge), the leaf judged by the line's stretches (stands over fog and shows the floor side).
- **D-261102-886 Open door tap and pill:** a standing leaf takes a tap like its line's, which opens the door's pill, whose Close closes it (amended in draft 3, ISODEPTH-ASTRA-12), the coordinator's answer, and the pill hangs over the frame's top for open and closed doors with the detail flag on. Rejected: a leaf that ignores presses (the visible door misses them), a leaf tap that toggles the door at once (skips the pill's reach check and opener), the open door's pill left at ground height under a standing frame.
- **D-261102-887 The ground stage under steps:** the whole symbol, its cream slab included, left out stair by stair, memoized by the stepping set's content. Rejected: leaving the slab (cream squares copied onto the treads, the owner's complaint), a memo by fog identity (a ground redraw on every fog change).
- **D-261102-888 Outlines and joins:** every vertical end of a side or slab is stroked except between collinear neighbors with the same top, foot and look. Slabs run on half a thickness past their ends. Tops keep faint square lines with the grid off, the coordinator's answer. Rejected: verticals at corners only (silhouette ends and changes vanish on a matching floor), a stroke round every wall piece (a seam each square, the cubes look on walls), mitred joins, square lines only with the grid on.
- **D-261102-889 Cost and bench:** counts in fill calls, tints baked into patterns, posts in a flat tone, a generated 50 by 50 dungeon scene, Low power rows at 48 and 64 px, the bench's gates as they are. Amended in draft 3 (ISODEPTH-ASTRA-13): `gate` holds every row, caps included, and only `largestGate` reports rather than gates the caps. Rejected: counting faces as fills, draft 2's caps exemption from every gate, Low power rows below its detail level.

## 15. Later

Sight darkness on sides and walls. Pins, pings, labels and ruler ends on treads. Areas cut per tread. Mounds for rubble, water ripples, cave slopes, a foot shadow under tall sides: each for the owner's word after the preview.

## 16. The preview

A throwaway prototype drew draft 1's stairs, doors, walls and outlines, then was abandoned. Its shots, shown to the owner and not kept in the repository, set main at `073ab104` beside the prototype: four side by side, then whole boards on a computer and a phone, dark and light, at two turns. Nothing in drafts 2 and 3 changes what those shots show: raised runs step the same under spans, the open leaf stood at its hinge's base on flat ground, and taps are not pictured. Not in it: spans (sunk runs were not shot), edge profiles, the stand surface, picks, the detail flag, frames from whole doors, the leaf's stand rule and tap, the slab ends and joins, baked patterns, the lip, pit shading and hexes.

## 17. Review dispositions

### Changes in draft 2

- Steps follow spans per run from foot to head, sunk runs included, a sunk span drawn as an opening (5.2, D-880).
- A run steps only with its ends and stairs seen and in the scene and its stairs' grounds inside their spans, and the privacy property holds projected chunks fixed (5.2, 8, D-881).
- One stand surface for every reader, the drag's levels and footing included, fliers, buried tokens and riders unchanged (5.4, D-882).
- One detail flag read by drawing, picks, standing, the drag, the ground stage and door taps, with bounds the same either way (6, 7, D-883).
- A stair run index in each bucket's signature (5.2, D-884).
- Door frames from the whole door, the open leaf one item on its swing square's ground with its own stand rule and depth key, a tap on it, and the pill over the frame (5.5, D-885, D-886).
- The ground stage leaves out the stair slab too (5.2, D-887).
- The outline rule strokes ends and changes, and walls lose their per-square seams and their corner notch (5.1, 5.6, D-888).
- Tread batching and tones, wasted faces skipped, the `steps` piece kind (5.2).
- Costs in fill calls with baked patterns, the bench's real scenes and gates, Low power rows that draw detail (7, D-889).
- File references, stale text per lane, and the slab's depth note corrected (5.6, 13).

### Design review round 1

| Finding | Disposition |
|---|---|
| ISOD-01 P1, ISODEPTH-ASTRA-01 sunk runs | adopted: spans per run (5.2, D-880). The `runFor` change is the rejected option. |
| ISODEPTH-ASTRA-02 P1 drag and rings | adopted: one stand surface in drawing, `tokenBase`, rings, levels and `footGround` (5.4, D-882) |
| ISOD-02 stale steps | adopted: the run index in the signature (5.2, D-884) |
| ISOD-03 one detail flag | adopted (6, 7, D-883) |
| ISOD-04, ISODEPTH-ASTRA-06 privacy | adopted: seen and in-scene ends, the property with projected chunks fixed (5.2, 8, D-881) |
| ISOD-05 the open leaf | adopted: `boxStands`, own key, and a base on the swing square's ground that round 2 corrected to the hinge's (5.5, D-885) |
| ISOD-06 the slab | adopted (5.2, D-887) |
| ISOD-07, ISODEPTH-ASTRA-03 one base | adopted: `drawnStandBase` for every draw-side reader, pins, pings, labels and ruler ends listed as later (5.4, 15) |
| ISOD-08 batching and tones | adopted (5.2) |
| ISOD-09 outline rule, wall seams | adopted (5.1, 5.6, D-888) |
| ISOD-10 leaf tap | adopted, the coordinator's answer (5.5, D-886) |
| ISOD-11 corner notch | adopted (5.6) |
| ISOD-12 file references, 0 ft kind | adopted (5.2, 13) |
| ISOD-13, ISODEPTH-ASTRA-07 counts | adopted: fill calls, baked patterns, flat posts, phone counts named as estimates (7, D-889) |
| ISOD-13, ISODEPTH-ASTRA-08 bench | adopted: the generated scene, Low power at 48 and 64 px, gates as the bench applies them (7, D-889) |
| ISOD-14 stale text | adopted (13) |
| ISOD-15 citation | adopted (5.6) |
| ISOD-16 wasted faces | adopted (5.2) |
| ISODEPTH-ASTRA-04 frames on split pieces | adopted (5.5, D-885) |
| ISODEPTH-ASTRA-05 open door pill | adopted (5.5, D-886) |
| Question: leaf tap | the coordinator: yes (5.5) |
| Question: square lines with the grid off | the coordinator: keep them (5.1) |

None declined.

### Changes in draft 3

- Faces between two cells read both cells' edge profiles, so a sunk run's entrance has no full face and a column's side steps down to a stair's low treads (5.2, 5.7, D-880).
- The rules' ground decides flight, burial, landing and seats in the drag, and the stand surface only places a token that stands. Standing on the ground means lift 0 (5.4, D-882).
- The open leaf stands at its hinge's base (5.5, D-885).
- A tap on the leaf opens the door's pill, and Close closes the door, in the summary, checklist, cases, e2e and FEATURES.md text (5.5, D-886).
- `stairRuns` is built with `drawnHeights` and carried on `DrawnHeights`, the memo keyed on the detail flag and the direction reader, and each signature holds one string of its own and its neighbors' stair entries (5.2, 7, D-883, D-884).
- The caps gate is stated as the bench applies it, and the phone estimate is about 400 squares, the pieces left to the bench (7, D-889).

### Design review round 2

| Finding | Disposition |
|---|---|
| ISODEPTH-ASTRA-09 P1 faces from stored stair heights | adopted: edge profiles, one rule with R2-03, checked against `facesOf` at pieces.ts (5.2, 5.7, D-880) |
| ISODEPTH-ASTRA-10 P1 `footGround` and fliers | adopted: rules decide, the surface places, checked against `byRule` in isoDrag.ts (5.4, D-882) |
| ISODEPTH-ASTRA-11 leaf parts from its hinge | adopted: the leaf at its hinge's base (5.5, D-885) |
| ISODEPTH-ASTRA-12 leaf tap toggles | adopted: `tapDoor` opens the pill and DoorPill's Close closes it, checked at doors/tap.ts and DoorPill.tsx (5.5, 10, 11, 12, 13, D-886) |
| ISODEPTH-ASTRA-13 caps gate | adopted: `gate` holds caps, only `largestGate` reports them, checked at bench-iso.ts (7, D-889) |
| R2-01 where `StairRuns` lives | adopted: on `DrawnHeights`, the memo keyed on the flag and direction reader, checked at boardPick.ts (5.2, 7, D-883, D-884) |
| R2-02 signature by identity | adopted: one string, checked at buckets.ts `sameSig` (5.2, D-884) |
| R2-03 the gap above low treads | adopted with ASTRA-09: edge profiles and neighbor chunks' entries in the signature (5.2) |
| R2-04 phone estimate | adopted: about 400 squares, piece counts left to the bench (7) |
| R2-05 standing on the ground | adopted: lift 0 (5.4) |

None declined.

## As built

(Filled by each lane's docs commit.)

### Lane D1: stairs as steps and the stand surface

Built: 5.2's runs, steps, signatures and edge profiles, 5.3's floor sides, 5.4's stand surface in every reader and the picks per tread, 6's bounds, 7's detail flag and bench rows, and 8's property test.

- **The run index** is client/lib/stairRuns.ts `stairRuns(cells, stairAt, ground, seen)`. Its first argument is the scene's stair cells, read from its chunks and cached per chunk (`stairCandidates`), so it walks stairs only. A run whose foot or head is itself a stair, a turn in the stairs, keeps today's look, as 5.2's corner case says.
- **The detail flag** is `heightsDetail` in client/lib/view.ts (24 px a cell, 48 in Low power). It does not decide which runs step: the index is found at every zoom, so a piece's bounds hold at both levels (6), and every reader asks `stepAt`, which gives nothing while the flag is off. The flag rides on `DrawnSource.detail`, `DrawnHeights.detail`, `IsoGround.detail` and `DrawnHeightsMemo`'s key.
- **The stand surface** is `standSurface(heights, cells)`. It takes the middle of the footprint cells' box rather than a separate center, since the rules' footprint cells are what every reader holds. `drawnStandBase` uses it only for a token whose elevation equals its footprint's seen ground, lift 0. Flat creatures are unchanged.
- **Signatures** on squares carry one string for the bucket's own chunk and its four neighbors. Hex scenes keep their own chunk and eight neighbors (buckets.ts), and no hex stair steps until lane D4 (round 3).
- **Picks.** `boardPickFor` (canvas/boardPick.ts) reads `sceneWalls(scene, room.buildChunks)` as the stairs' reader, and its scene Pick gains `autoWalls` (round 3). `displaySeen`'s drawn heights take no reader, so the table display's seen ground has no steps.
- **The drag.** `dragGround.surface` places a standing token and `footGround` decides every rule (canvas/isoDrag.ts). `levelsOf` adds the tread heights. canvas/Stage.tsx passes the pick's heights to `dragPlan`, its only change in this lane.
- **The ground stage** takes `standing.stairs`, the symbols of the stairs that do not step (builder/draw.ts `stairSymbols`). BuilderLayer.tsx memoizes them by the stepping cells' string, so a fog change that steps nothing new keeps them.
- **Looks.** On squares a Stairs terrain square's steps wear stone, a stair mark wears the floor under it, and a mark over a map image its map tint. Hexes keep the stairs swatch.
- **Below 0** a tread is an opening drawn in its pit region's clip and darkened as a pit's floor is.
- **Tests.** client/lib/stairRuns.test.ts and client/canvas/relief/steps.test.ts (profiles, signatures, the flush, tread tones, a bounds property at every turn with the detail on and off, the privacy property, looks, the detail at 23 and 24 px), with additions to canvas/isoDrag.test.ts and builder/draw.test.ts. Each new rule was put back wrong once and a test failed, 18 in all. e2e/iso.e2e.ts ISOD-1 checks the spans of a raised and a sunk run, a tread against its riser, a creature on its tread, and plain stairs below 24 px.
- **Bench** (scripts/bench-iso.ts, its whole run before and after). The generated dungeon is a 50 by 50 seed with rooms raised and sunk 10 ft. Its rows (a pan, a drag up a run and a turn, at 40 and 24 px and in Low power at 48 and 64 px) and the caps at 24 px and at 48 px in Low power are inside their gates, and no square row newly went over. The hex relief rows ran slower in the after run while other work loaded the machine, with the same fill and stroke counts. Rerun back to back, the base and this lane, this lane's medians there were at or below the base's, and their largest-move marks changed both ways between the two.

### Lane D2: doors and windows in frames, the upright open leaf

Built: 5.5's frames from whole doors, the open leaf with its stand rule, tap and pill, windows in frames and the arc left out, with 6's bounds and depth key, 7's detail flag in every reader of frames and leaves, and 8's leaf rule.

- **Pieces.** relief/runs.ts `wallKind` gives every door a kind: `door` (closed or locked), `open`, or a wall for a secret door not yet found. Each door or window piece carries `frame`, its whole segment and its own range along it, and `wallPieces` takes an `isFloor` reader (`floorOf`) and adds one `leaf` piece for each open door whose leaf stands. relief/pieces.ts `frameParts` cuts the posts, the leaf and the pane to a piece's range, so fog, crossings and hex sides never add posts.
- **Geometry from Top-down.** builder/draw.ts exports `freeFrame`, `stubOf` and `openLeaf`, the leaf Top-down lays flat, and `doorLeaf` stands that same leaf, so both views agree on its hinge, side and length. An edge door uses `freeFrame` and `freeSwingSide` too, which give exactly `edgeFrame` and `swingSide` for a cell edge.
- **The leaf's base** is its hinge's: the higher ground beside an edge door, a free door's cell just past its hinge. It sorts by its own middle, from hinge to far end, and has no hosts on hexes. It is 0.08 cell thick along its door, Top-down's flat leaf, and the stand rule reads that same box (D-261102-921).
- **Bounds** grow by every frame part's corners, drawn or not, so they hold with the detail on and off. An open leaf's bounds are its own box, not the swept square 6 names: the box holds every vertex the leaf draws, and a square would mark standees in the swing square as covered (D-261102-920).
- **Looks.** Posts fill one flat tone a face, stone pulled toward the wall color and lit or shaded, and their caps the lit tone. A leaf wears the wood texture and the light, its cap a lit wood tone. The door stain is left to lane D3's baked patterns (D-261102-922). A closed door draws 11 fills with textures loaded, an open frame 6, a window 7.
- **Below the detail level** an open door stands nothing and its leaf lies flat with its arc, and a closed door or a window stands as one plane, as before. `wallItems` reads `PieceSource.detail` and marks the rest `framed`.
- **The ground stage.** `BoardPaths.openList` names each open door by the relief's key (`edgeDoorKey`, `freeDoorKey`), and BuilderLayer.tsx builds `standing.doors` from the doors whose leaf does not stand (`IsoGround.standingLeaves`, one set kept while the same leaves stand).
- **Taps.** `doorPiece` returns an open door's standing stretches with the detail on, so the pill hangs over the frame's top for open and closed doors alike. `standingLeaf` stands the leaf as the relief does, and `doorGap` adds its band, `LEAF_RISE` of the wall's height, on the hinge's ground. The search round a press grows by 8 cells, a free wall's longest, while the detail shows. Nothing in DoorPill.tsx changed but its comments: Close already closes through the reach check and opener.
- **A player's free door** that the server cut to what they know is framed from that cut piece, as Top-down stubs it (D-261102-923).
- **Outside the file list:** relief/context.ts (`IsoGround.standingLeaves`), relief/buckets.ts (`groupWalls` compares pieces through `samePiece`, so a frame's change rebuilds its bucket), relief/isoTest.ts (`BoardLayout.leaves`), and scripts/bench-iso.ts, whose dungeon seed no longer had a run up to a raised room once the generator's heights became percents (D-261102-924).
- **Tests.** client/canvas/relief/frames.test.ts (one frame across fog, crossings, long and hex doors, the leaf's side, base, stand rule and key, the detail, groupWalls, a bounds property at every turn with the detail on and off, and fill counts), additions to relief/runs.test.ts, features/doors/tap.test.ts and builder/draw.test.ts, and e2e/iso.e2e.ts ISOD-2. Each new rule was put back wrong once and a test failed, 13 in all.
- **Bench** (scripts/bench-iso.ts, its whole run before and after). The generated dungeon's rows and the caps at 24 px and at 48 px in Low power are inside their gates on both runs. The after run ran on a quieter machine and was faster nearly everywhere. Its new largest-move marks fell on three hex relief rows, whose scenes hold no doors and whose fill and stroke counts are the same before and after. Rerun back to back, the base and this lane, those marks changed both ways between the two.

### Lane D3: wall slabs with caps and joins, the outline rule, baked tinted patterns

Built: 5.1's outline rule, 5.6's wall slabs with their ends and joins, 6's slab bounds, 7's baked patterns with the door stain D2 left (D-261102-922), and counted bench rows.

- **The outline rule** is `CellPiece.joins` (relief/pieces.ts `sideJoins`): for each side, whether each end meets the same side of the square beside it along that line with the same ground, the same ground beyond and the same look. A joined end strokes no upright line, so a side draws its top edge, its foot and the uprights at its ends (drawRelief.ts `faceLines`). It holds at every zoom on squares, below the detail level too, since it adds no fill (D-261102-925). A side beside a stepping stair, or whose line meets one, joins nothing.
- **Tops.** A top strokes every square in `theme.relief.squareLine` (black at 16%), grid or no grid, then its rim, each side whose neighbor's edge profile is lower, in the edge's color. Hexes keep today's outlines until lane D4.
- **What a bucket reads.** A side's ends and a slab's read the squares and walls diagonally beside them, so on squares a bucket's signature now holds its own chunk and the eight around it, their fog tiles, their stair spans and their wall groups, as hexes already did. An edit rebuilds up to nine buckets, where it rebuilt five. relief/buckets.ts is outside this lane's file list.
- **Slabs** (`WallItem.slab`, `slabOf`) stand for wall pieces from 24 px a cell, 48 in Low power, on squares only: hex walls are lane D4's. Each end goes by what meets it: the next slab of the wall along the line with the same base and top joins with no end face and no line, a frame along the line stops it at the post, a slab of another height stops it with its end face showing, two slabs through the end across it (a T) stop it half a thickness short, one slab across it (an L) is covered by the taller or the first by id while the other stops at its side, and nothing carries it on half a thickness. 5.6 carries both slabs of an L past the corner. Where both did, each slab's inner face drew over the other's cap at some turns, so one slab owns the corner and they never overlap (D-261102-926). A slab that stops short leans its depth key 1e-7 toward its own side, which breaks the exact ties two corner slabs' middles have on squares.
- **Looks and fills.** A slab's long sides wear stone with the wall tint baked in and the light, two fills each. Its narrow ends and its cap fill one flat tone each, as posts do, since 0.14 cell shows no texture: 4 fills a slab at one turn, 3 at a joined end, where 7 names 6 (D-261102-927). One stroke outlines it.
- **Baked patterns** are relief/looks.ts `tintedPatternOf`: the image drawn once on a canvas of its own size with the tint filled over it, kept per image and tint, made only once the image has decoded. Walls, pillars and door leaves use it. Where no canvas can be made the tint is laid over the texture as before.
- **The door stain** is `theme.relief.doorStain`. A leaf, standing or below the detail, wears the stained wood and its light, and its cap the stained tone, so a closed door still draws 11 fills (D-261102-928).
- **Texture seams.** A side's texture now runs on from the world's origin along its line, not from the side's own end, so neighboring sides and slabs on one line show no seam in their stone once their line goes (D-261102-929).
- **Bounds** of every wall piece but a pillar take a slab's half thickness past each side and end, drawn or not.
- **Tests.** client/canvas/relief/slabs.test.ts (a long side's uprights at every turn, a concave corner, a foot and a look change, a join property against the faces at every turn, tops' rims, slabs' joins, corners, T, posts and heights, depth keys at every turn, a bounds property with the detail on and off, fill counts, texture origins, baking, the stain, and buckets reading diagonal chunks and neighbors' walls), with updates to runs.test.ts, buckets.test.ts and frames.test.ts. Each new rule was put back wrong once and a test failed, 25 in all. e2e/iso.e2e.ts ISOD-3 finds no line at a wall's joint or between two squares of a raised side, a line where the side's foot changes, and the wall planes' line below 24 px.
- **Bench.** The generated dungeon's pans are counted too, in Isometric: fills and strokes, patterns made and whole repaints a frame.

