# raccoon-vtt v1: hex grids beside squares

Status: design, not yet reviewed. Code is cited from main at `cf98b4be`. Nothing is built.

The project owner, 2026-10-25, after hearing that per-player sight was never added: "Once done with your current scope of work I'd like you to add support for per player vision (toggleable between whole party and per player by the dm) and also hex grids (keep square as the default though)." Right after: "Any designs these can be done ahead of time should be".

Decided as D-261025-7 and its amendment: hex grids are a scene's grid shape, square by default for new and existing scenes. The design starts now. Its build waits for the current scope and follows the per-player vision run. Asking the owner is off, so every open choice below is a guess at the owner's likely answer, listed with the options it rejects (section 5).

## 1. The answer in short

- **A scene's grid is Squares, Hex rows or Hex columns.** Squares stays the default everywhere. The DM picks the shape for a new Battle mat or Map image, or changes it in the scene's Grid settings. Builder scenes stay squares.
- **The world stays measured in cells.** One cell is the distance between two neighboring hex centers, 5 ft at the room's default, so a hex is one cell across its flat sides. Positions, the fog's bitmap, sight, lights, light and sense radii, area shapes and free walls keep their units and their code. Only what reads the grid's cells changes.
- **Every hex is 5 ft.** Hexes have no diagonals, so the room's diagonal rule only combines a distance with height on a hex scene.
- **Sizes follow the DMG's hex table:** Tiny, Small and Medium 1 hex, Large 3, Huge 7, Gargantuan 12.
- **Areas keep their true shapes.** A hex is in an area when the room's rule says so, at least half of it by default, as the 2024 DMG says for "squares or hexes". Origins snap to hex corners or centers.
- **Walls on hexes are free walls**, drawn as lines. No hex edge keys.
- **Three phases.** H1 runs a fight on a hex map: place, move, measure, areas, fog and party vision. H2 adds walls, ways around them, difficult ground, riding and carrying, and traps. H3 adds heights and stairs, Reveal room and Find the grid for hexes. Painted ground, pillars, squeezing, Count the squares and the Universal VTT import stay square, each saying so in plain words.
- **The shape changes only while nothing stands on the scene's cells** (painted ground, edge walls, heights, stairs, difficult ground, trap zones). Tokens, areas, fog, free walls, lights, stamps, labels, drawings and pins stay as they are.

## 2. What the 2024 rules say

- **Areas of effect, 2024 DMG ("Running the Game", Areas of Effect),** as quoted in a public rules forum and not checked against the book: "An area of effect must be translated onto squares or hexes to determine which potential targets are in the area", "choose an intersection of squares or hexes to be the point of origin", and "If an area of effect covers at least half a square or hex, the entire square or hex is affected." So the app's `half` rule and its snapped origins apply to hexes as written.
- **Creature space on hexes.** The 2014 DMG's table "Creature Size on Squares and Hexes" gives Tiny 4 per hex, Small and Medium 1 hex, Large 3 hexes, Huge 7 and Gargantuan 12 or more, and says a miniature of another footprint still uses the creature's real size for every other rule. No 2024 text on hex footprints could be found or checked, so this note follows the 2014 table, the last printed one.
- **Movement and distance.** The 2024 Player's Handbook counts a grid in 5 ft squares with its diagonal rule. Nothing found in the 2024 books covers moving on hexes. This note counts 5 ft per hex, as a grid of 5 ft cells implies, and a hex has no diagonal to rule on.
- **No rule covers** height on a hex grid, hex walls, hex fog or hex cones. Those follow the app's square rules, carried over as below.

## 3. The audit

Every feature that reads the grid, from four read-only sweeps of the code. "Cell" means a world unit square, "rect" a footprint rectangle. The phase column says when hexes reach it (section 6), or "square" when it stays square only.

| Feature | Code | Assumes today | On hexes | Phase |
|---|---|---|---|---|
| Grid lines | `canvas/layers/MapLayer.tsx:118`, `builder/draw.ts:534`, `mapexport/render.ts:70`, `grid/GridLayer.tsx:44` | one path of lines x = 0..w, y = 0..h | one path of hex sides, culled to the view | H1 |
| Map placement | `model.ts` SceneMap and PhaseGrid, `lib/scene.ts:39`, `reducer/phases.ts:31` | one cellPx on both axes, origin on an intersection | unchanged: cellPx is px across a hex's flats, origin reduced into the hex lattice | H1 |
| Line up grid | `grid/calibrate.ts`, `tool.tsx`, `GridLayer.tsx`, `Options.tsx`, `outcome.ts` | a 3 by 3 square box, 4 corners, origin mod cellPx | a box 3 hexes across holding 7 hexes | H1 |
| Count the squares | `SceneSettings.tsx:242`, `calibrate.ts:163` | squares across and down | none | square |
| Find the grid, name hints | `grid/detect.ts`, `findGrid.ts`, `server/assets/kinds.ts:136` | axis-aligned lines, `NxM` names | squares only until a hex detector | H3 |
| Snapping | `lib/scene.ts:28`, `footprint.ts:95-118`, `Stage.tsx:1127` | per-axis round to 1 or 0.5 | nearest anchor (section 4.2) | H1 |
| Footprints | `footprint.ts:126-170` (24 files call it), `model.ts:632` | N by N rect of cells, top-left at x, y | sets of 1, 3, 7 or 12 hexes | H1 |
| Token drawing | `TokenNode.tsx:127-140`, `Stage.tsx:1483` | w by h box | the size's box around the anchor, a hex outline when selected | H1 |
| Placement spread, duplicate | `tokens/factory.ts:230-318` | Chebyshev rings of squares | hex rings | H1 |
| Size and resize | `rules/resize.ts`, `tokens/resize.ts:124` | per-axis spots, custom w by h | size categories only, nearest anchor | H1 |
| Distance between creatures | `distance.ts:27-85` | per-axis steps between boxes, three diagonal rules | fewest hex steps between the two sets, rule only with height | H1 |
| Ruler, Straight | `measure/ruler.ts:41-102`, `RulerLayer.tsx` | free stop at a cell's center, rect exit | hex center, hex outline | H1 |
| Range rings | `measure/rings.ts:33-100` | outline along square sides | outline along hex sides | H1 |
| Drag, legs, path | `movement/drop.ts:248`, `route.ts:158-327`, `reducer/tokens.ts:602` | Chebyshev steps of the top-left corner | hex steps between anchors, the leg's hex line | H1 |
| Arrow keys | `state/shortcuts.ts:297`, `Stage.tsx:819` | four directions, one square | one hex, zigzag across rows or columns | H1 |
| Routes around walls and costs | `walk.ts`, `walkWorld.ts`, `route.ts` | 8 neighbors on a half lattice, 5-10-5 residues | 6 neighbors on the anchor lattice | H2 |
| Walking ruler | `measure/walkRuler.ts` | the square walk | the hex walk | H2 |
| Movement blocking | `movement.ts:91-155, 892` | square core of side - 1 - 1/32, 9 half-cell shifts | a smaller core (D8), no shifts | H2 |
| Squeezing | `movement.ts:209-247, 809-848`, `footprint.ts:63` | footprints shrink on cell lines | none | square |
| Area shapes | `aoe.ts` predicates | none, continuous 3D | unchanged | H1 |
| Area coverage and shading | `aoe.ts:30, 661-808`, `areas/draw.tsx:26` | 16 by 16 samples per cell, half diagonal shortcut | a fixed sample pattern per hex, circumradius shortcut | H1 |
| Area placement | `areas/placement.ts:215-322, 606`, `caster.ts:356` | intersections or centers, 8 rect points, whole-cell moves, 45° snap | hex corners or centers, outline corners and side midpoints, lattice moves, 30° snap | H1 |
| Who an area catches, reminders | `aoe.ts:870-996`, `reducer/areaTriggers.ts` | occupied rect, half-cell sweep | footprint hexes, the leg's hex line | H1 |
| Areas that slow movement | `walkWorld.ts:160` | square cells from coverage | hex cells | H2 |
| Fog bitmap and shapes | `fog.ts:16, 215-307, 361` | world raster, 4 by 4 per cell | unchanged | H1 |
| Tokens under fog, in sight | `fog.ts:120-140`, `project.ts:223, 367`, `vision.ts:71, 322` | a cell's 4 by 4 block, the rect's sub-cells | sub-cells whose centers lie in the footprint's hexes | H1 |
| Labels, stamps, pins under fog | `fog.ts:148`, `project.ts:910, 1131` | world cells of the raster | unchanged: they read the raster, not the grid | H1 |
| Sight, lights, explored ground | `vision.ts` sweep and circles, `server/rooms/explore.ts` | world units | unchanged | H1 |
| Reveal room | `walls.ts:1434`, `fog/shapes.ts:113-141` | painted squares, 4 neighbors, edge walls only | hexes flooded up to free walls | H3 |
| Edge walls, automatic walls | `walls.ts:34-129, 479-609, 694`, `autoWalls.ts` | n and w edges, 4 neighbors | none (D6) | square |
| Free walls | `segments.ts`, `walls.ts:1100` | ends on the 1/64 lattice | unchanged, hex corners rounded onto it | H2 |
| Painted ground, rooms, pillars | `builder/cells.ts`, `geometry.ts`, `draw.ts:228-336`, `walls.ts:525` | square cells and insets | none | square |
| Builder walls and doors | `builder/cells.ts:192-251`, `tool.tsx` | nearest n or w edge, axis runs | Wall line: free walls, doors and windows | H2 |
| Difficult ground marks | `model.ts:476` `rough`, `walk.ts:598` | per square, row-major per chunk | per hex, same storage under hex keys | H2 |
| Heights, ledges, stairs | `heights.ts`, `walls.ts:539-605`, `heights/relief.ts` | 4 neighbors, n e s w | 6 neighbors and directions | H3 |
| Doors and their reach | `permissions.ts:1922`, `doors/doors.ts:72` | the squares beside an edge | the hexes beside a free door | H2 |
| Traps | `rules/traps.ts`, `client/features/traps/rules.ts`, `protocol.ts:1572-1589` | integer rects, wires on the half lattice, edge doors | rects of hex keys, wires on the 1/64 lattice, free doors | H2 |
| Riding, carrying, dragging | `attach.ts:45-298`, `dismount.ts`, `moveLeg.ts:169` | rects, Chebyshev rings | hex sets and rings, world offsets | H2 |
| Universal VTT import | `uvtt/*` | the format is square | none | square |
| Export as image | `mapexport/size.ts:45`, `fileName.ts:14`, `MapExport.tsx:163` | px per square, `-30x20-70px` | px per hex, hex lines, `-hex-70px` | H1 |
| Starter maps | `shared/starter.ts:72`, `starterArt.ts` | measured square grids | unchanged, square scenes | square |
| New scene, settings | `scenes/create.ts`, `NewScene.tsx`, `SceneSettings.tsx:92, 208` | square words and defaults | the shape choice | H1 |
| Words | about 200 strings in 33 client files | "square" | "hex" on hex scenes | H1 |
| Drawings, pings | `drawings/`, `pings/` | no snap | unchanged | H1 |

## 4. The hex grid

### 4.1 Geometry

- **Two orientations.** Hex rows have pointed tops, so a row runs straight across and a column zigzags. Hex columns have flat tops, the same grid turned a quarter. Every hex rule is written for rows and reads columns by swapping x and y, so one set of tests covers both.
- **Constants.** `HEX_S = 0.8660254037844386` (√3/2, the spacing of rows) and `HEX_R = 0.5773502691896258` (1/√3, center to corner), written as literals.
- **Keys.** A hex is `"col,row"`, offset coordinates, odd rows shifted half a cell right. The center of hex (c, r) is `(c + 0.5 + 0.5 * (r % 2), HEX_R + r * HEX_S)`, so hex (0, 0) touches the scene's top and left edges. Distance, lines and rounding go through cube coordinates inside `hex.ts` and never leak into stored data.
- **The scene's hexes** are those lying wholly inside its rectangle. Bounds stay in cells (at most 200 by 200), so a 30 by 20 scene holds 30 hexes in even rows, 29 in odd rows and 22 rows.
- **Which hex holds a point:** cube rounding, ties to the lower key. A fog sub-cell's center is an odd multiple of 1/8, so the upright sides of hex rows (at multiples of 1/2) never split one, and the rounding settles the sloped sides the same way on every device. So every sub-cell belongs to one hex.
- **Exactness.** `hex.ts` uses only `+`, `-`, `*`, `/`, `Math.floor`, `Math.round`, `Math.abs`, min and max, and joins the test that bans `sqrt`, `hypot`, trigonometry and powers in what vision and segments import. The reducer reads it on replay, so every device must agree bit for bit.
- **Hex corners as wall ends** are rounded to the 1/64 lattice, each corner computed once from its own index, so two sides that share it share the identical point.

### 4.2 Footprints

| Size | Hexes | Anchor | Box side (cells) |
|---|---|---|---|
| Tiny | 1 | its hex's center | 0.5 |
| Small, Medium | 1 | its hex's center | 1 |
| Large | 3: a hex and the two below it | the corner the three share | 2 |
| Huge | 7: a hex and its six neighbors | its center hex's center | 3 |
| Gargantuan | 12: the Large three and the nine around them | the same corner | 4 |

- **Position.** A token's `x, y` is still the top-left of its size's box, whose center is the anchor. So drawing, hit areas, the action bar, drag frames, tethers, labels and every reader of `x + w / 2` work unchanged. Only the rules that read the occupied cells branch on the grid.
- **Anchors** for Tiny, Small, Medium and Huge are hex centers. For Large and Gargantuan they are the centers moved down by `HEX_R` (right, on hex columns): one lattice the same shape as the centers, so every size moves in the same six steps of one cell.
- **A custom size** reads as its size category (`sizeCategory`, longer side). The size picker offers categories only on a hex scene.
- **Inside the scene.** A footprint's hexes must be the scene's hexes wherever a rule today keeps a footprint inside the scene (placement, a player's teleport, landings), so the slivers at the edge hold nothing.
- **Height** keeps its default, the box side times the feet per cell.

### 4.3 Distance and movement

- **Between two creatures:** the fewest hex steps between any hex of one and any hex of the other, at most 144 pairs. Adjacent hexes are 1 step (5 ft), shared hexes 0.
- **With height:** vertical steps as today, from each creature's elevation range. `five` takes `max(h, v)`, `fiveTen` takes `max + floor(min / 2)`, `euclid` takes `hypot(h, v)` rounded to the foot. So the room's rule still decides height, and horizontal distance is always the hex count.
- **A leg's steps** are the hex steps between its start and end anchors. `moved` and `cost` are written as today. H1 has no extra costs on hexes.
- **The leg's hex line** (cube interpolation from a start nudged by 1e-6, then rounding) gives the spots area reminders and, from H2, traps read, one per hex step.

## 5. Decisions, with rejected options

- **HX-D1 Orientation:** both, as Hex rows and Hex columns, with Hex rows first. Hex map art comes either way, and one transpose covers both. Rows first, since a row runs straight across like the square grid's rows. Rejected: one orientation (half the hex maps could not line up), Hex columns first.
- **HX-D2 World unit:** one cell is the spacing of hex centers, one hex across its flats. Rejected: a hex coordinate world (every continuous rule would change: fog, sight, lights, areas, free walls). Rejected: one cell across a hex's corners (5 ft would not be center to center).
- **HX-D3 Distance:** every hex 5 ft, the room's rule only for height. Rejected: Euclidean horizontal distance under true distance (the DMG counts hexes, and a ruler would disagree with the hexes the table counts).
- **HX-D4 Footprints:** the DMG table, 1, 3, 7, 12. Rejected: Large as 4 hexes in a diamond (no center, the creature leans one way), Gargantuan as 19 (a hex of radius 2, much larger than 20 ft), keeping custom boxes on hexes.
- **HX-D5 Tiny:** one hex, snapped to its center, so two Tiny creatures in one hex overlap on screen. Rejected: four spots per hex (a hex has no even split into four, and the spots would be guesses).
- **HX-D6 Large's triangle** points one way, two hexes below one. Rejected: both ways (two anchor lattices, and a Large creature would turn as it moves).
- **HX-D7 Walls:** free walls only. On a hex scene the builder's Walls and doors draws Wall lines: tap or drag from point to point, each line a free wall, door or window of at most 8 cells, split where longer. Points snap to hex corners while Snap to hex corners is on (the default), else to the 1/64 lattice, for tracing the art. Rejected: hex edge keys (three sides per cell, a new derive, new automatic walls, for walls that rarely follow hex sides on map art). Rejected: Wall lines on square scenes too (no one asked, and it changes a shipped tool).
- **HX-D8 Blocking core on hexes:** a square around the anchor, sized so that a creature fits a corridor sized for one size smaller, as on squares: Large one hex wide, Huge two, Gargantuan three, along each of the three hex directions, and none narrower. A corridor one hex wide along a row is only one hex side (0.58 cells) wide where two of its hexes meet, so the sides are not today's. HX-5 sets them by measuring those corridors in a unit test (along a row, two rows wide is 1.73 cells and three is 2.31). Medium and smaller stay a point. No shifted paths, since the anchor lattice has no half steps. Rejected: today's core of side - 1 - 1/32, which keeps a Large creature out of every one-hex corridor.
- **HX-D9 The builder on hexes:** H1 places lights, stamps and labels and clears the build. H2 adds Wall lines, Remove, Door states, Difficult ground and Erase by hexes. H3 adds Heights and stairs. Painted ground, rooms, pillars and automatic walls stay square, and New scene's Builder scene has no shape choice. Rejected: the whole builder on hexes (textured hex floors and hex automatic walls are a large build for dungeons people draw on squares). Rejected: no builder on hexes (lights and difficult ground matter in an outdoor fight).
- **HX-D10 Fog and sight:** the world raster as it is. Tokens under fog and in sight read the sub-cells inside their hexes. Reveal room on hexes (H3) floods hexes, a step blocked where a wall that blocks movement crosses the line between the two centers. Rejected: a hex fog raster (a second format for no gain in what players see).
- **HX-D11 Areas:** true shapes, hexes by the room's rule. A free origin snaps to the nearest hex corner or center. A cone, line or cube cast from a token starts at the corner or side midpoint of its footprint's outline where the aim leaves it, as squares use corners and edge midpoints. The 45° step reads 30° on hex scenes. A placed area moves by whole lattice steps. Rejected: corners only (an eastward cone from a hex row creature would start off center). Rejected: hex-shaped stencils for each spell (Xanathar's token method, not built for squares either).
- **HX-D12 Line up grid:** a box 3 hexes across, drawn with its 7 hexes, dragged, resized by its corners and nudged as today. Count the squares stays square. Find the grid stays square until H3. Rejected: placing two hex centers (a far worse fit on a small screen than a box).
- **HX-D13 Imports and exports:** a Universal VTT import makes a square scene, and a scene marked `gridFromFile` cannot change shape. Export as image draws hexes at a whole number of px per hex and names the file `crypt-hex-70px.png`. The upload's size hint ignores such a name. Rejected: `crypt-30x20-70px.png` for hexes (other VTTs would read it as squares).
- **HX-D14 Switching the shape:** allowed while the scene holds no cell data: painted ground, edge walls and "no wall" marks, heights, stair marks, difficult ground, trap zones, traps on edge doors, and fog draft shapes of kind `cells`. Otherwise refused, naming what is there. Tokens keep their spots, and every rule reads them at their nearest anchor at once, so a token drawn off center snaps when next moved. A map scene keeps its cellPx and origin and opens Line up grid. One op and one undo step. Rejected: converting square data to hexes (no faithful mapping). Rejected: refusing while tokens are on the scene (a DM sets up first and fixes the grid later). Rejected: snapping every token in the same op (a mass move nobody made, through walls and traps).
- **HX-D15 Arrow keys:** Left and Right move along a row on hex rows. Up and Down go right of straight from an even row and left of it from an odd row, so a run of presses zigzags and keeps to one column. Hex columns turn it a quarter. Rejected: six keys (no spare keys on the sheet, none on a phone).
- **HX-D16 Size row:** a hex scene's size reads in grid steps of the room's feet per cell, with a line saying how many hexes it holds. Rejected: sizes in hexes and rows (rows do not fit whole cells, so typed counts would change).
- **HX-D17 Squeezing:** square only. On hexes a creature too big for a gap stops at it. Rejected: a hex squeeze (no cell lines to shrink a footprint onto).
- **HX-D18 Hex lines when zoomed out:** drawn only while a hex is at least 6 px across, and only those in view. Rejected: always every hex (46,000 hexes on the largest scene).

## 6. Phases

### H1: a fight on a hex map

The shape field, `hex.ts`, grid lines on the board and in the export, Line up grid's hex box, the shape choice, snapping, footprints, the selected token's hex outline, placement spread, sizes, distance, the Straight ruler, drag labels and speed colors, legs and the path, range rings, arrow keys, areas (placing, shading, catching, reminders and their sweep), fog and party vision with their footprint test, and the word pass. A new hex Map image skips the upload's grid search, which finds squares only. Every limit says so where it shows:

| Where | Words shown on a hex scene |
|---|---|
| The builder's hint | "On hexes the builder places lights, stamps and labels. Walls, painted ground, heights and difficult ground need squares." |
| The ruler's Measure chip | Walking is off, with "Walking needs squares." |
| An area's Movement inside | "Counted on squares only." |
| Attach, in the action bar and the token panel | off, with "Riding and carrying need squares." |
| The Trap tool's options | "Traps need squares." and nothing to place |
| Line up grid's options | "Counting works on squares. Use the box." and "Find the grid finds square grids only. Line up the hexes with the box." |
| The size picker | "On hexes a creature takes its size's hexes: Large 3, Huge 7, Gargantuan 12." |
| Room settings, while the room holds a hex scene | Diagonal moves adds "On hex scenes every hex is 5 ft. This rule counts only height there." The area rules read "Which squares or hexes an area covers", "At least half the square or hex" and so on. |

Ops that write cell data (`build.paint`, `build.erase`, `build.rect`, `build.poly`, `build.edge`, `build.height`, `build.stairs`, `build.rough`, a `trap.create` or `trap.update` with a zone or an edge door, a fog `cells` shape) are refused on a hex scene with `invalid`, "this scene's grid is hexes", until their phase. No such op was ever stored, so lifting a refusal later changes no replay.

### H2: walls, ways and terrain

Wall lines, Remove and door states on free walls (design.md 12's free wall code), movement blocking with the hex core, routes on the six-neighbor anchor lattice for drags, the walking ruler and arrow keys, difficult ground marks by hex (`rough` under hex keys), areas that slow movement, door reach from the hexes beside a free door, Erase by hexes (free walls whose midpoint, and lights, stamps and labels whose center, lie in an erased hex), riding, carrying and dragging, and traps (zones as rects of hex keys, wires with ends on the 1/64 lattice, free doors). The builder's hint becomes "On hexes the builder draws wall lines, marks difficult ground, and places lights, stamps and labels. Painted ground and heights need squares." The other H1 lines go.

### H3: heights, rooms and found grids

Heights, ledges and stairs by hex with six stair directions, light heights from the hex under a light, Reveal room on hexes (HX-D10), and a hex detector for Find the grid, measured on the evaluation's code-drawn hexes and its three real hex maps before it may apply anything. The hint loses "and heights".

### Square only, for good

Painted ground and rooms, pillars, automatic walls, squeezing, Count the squares, the Universal VTT import, the export's `WxH` name and the starter maps' measured grids. Builder scenes are squares. Each shows its words where the DM would reach for it, as above, and FEATURES.md lists them.

## 7. Model and versions

```ts
type GridShape = "hexRows" | "hexColumns";
// Scene: absent reads as squares, the shape of every scene before it.
gridShape?: GridShape;
```

- **Ops.** `scene.create` takes `gridShape`. `scene.update`'s patch takes `gridShape: "squares" | GridShape`, where "squares" removes the field, so a square scene's stored form and its undo hash never change. The reducer refuses a change of shape while the scene holds cell data (HX-D14) or `gridFromFile`, with `invalid` naming it ("this scene has difficult ground and 2 traps on its hexes: remove them to change its grid"). DM only, as every scene edit is. `scene.duplicate` and the room export copy it. Players receive it, since they snap and draw by it.
- **Meanings on a hex scene.** `map.cellPx` and `phaseGrid.cellPx` are px across a hex's flats. `originPx` is the canonical pixel of world (0, 0), reduced into the hex lattice next to the image's top-left. `bounds` are cells. Cell and chunk keys name hexes: chunk (cx, cy) holds hexes with `col` from 16 cx and `row` from 16 cy, while its free walls stay where their midpoint's cell is, as today. The two never need to agree, since nothing reads one by the other's key.
- **Versions.** H1 takes the next free op and snapshot pair at build time, each an identity step (shared/migrate.ts practice), so an older build refuses a room that may hold a hex scene instead of reading it as squares. H2 and H3 each take their own pair, since a build of the phase before would read their hex data as square data. A rule that changes what the reducer does with an op already stored on a hex scene is gated below its phase's op version, as `walksRoutes` is today. The plan avoids any: H1's straight legs, sweeps and costs on hexes stay H2's for ops without a route.
- **Schemas.** `shared/protocol.ts` and `server/rooms/stateSchema.ts` take the field. H2 loosens a trap wire's ends from the half lattice to the 1/64 lattice on every scene, with its own op version. Permissions check that a hex scene's wire ends lie on hex corners or side midpoints rounded to the lattice, and a square scene's on the half lattice as today.
- **Code contract** (`shared/rules/hex.ts`, `shared/rules/grid.ts`, built first):

```ts
type Grid = { shape: "squares" } | { shape: "hex"; orient: "rows" | "columns" };
gridOf(scene): Grid
hexCenter(g, hex), hexAt(g, point), hexDistance(g, a, b), hexNeighbors(g, hex) // six, clockwise from east
hexLine(g, a, b)            // distance + 1 hexes, each next to the last
hexCorners(g, hex)          // exact, and cornerOnLattice for walls
footprintHexes(g, size, anchor), snapAnchor(g, size, center)
sceneHexes(g, bounds), hexSubcells(g, hex)   // the fog sub-cells whose centers it holds
```

Rule functions take the grid beside the token. Their square path is today's code, untouched, and every existing test passes unchanged.

## 8. UI checklist

- **Words shown.** Scene settings, Grid: "Grid shape", a choice of "Squares", "Hex rows" and "Hex columns", help "Hex rows have pointed tops and run straight across. Hex columns have flat tops and run straight down." Refused: the choice is disabled and the line says what blocks it, as the reducer does, or "This scene came with its own square grid from its file." After a change on a map scene, Line up grid opens with "Drag a box over 3 hexes across. Fine-tune it by its corners." and "px per hex" in its options. New scene, Battle mat and Map image: a "Grid" row with the same three choices, Squares chosen. Size on a hex scene: "Size in 5 ft steps", its fields "Across" and "Down", and "Holds 30 hexes across and 22 rows down." Export: "hexes at 70 px", its switch "Hex lines". A token's panel: "Large (3 hexes)". Every string that names the grid's cell says hex on a hex scene, through one helper (`cellWord`). H1's limit lines are in section 6.
- **Loading.** Nothing new is slow. A shape change is one op with the usual pending state. Hex lines draw on change only, culled to the view.
- **Keys and focus.** The shape choice is a radio group, arrow keys move within it, and a refusal keeps focus on the group with the reason linked by `aria-describedby`. Arrow keys move a token one hex (HX-D15). The shortcut sheet's line becomes "Arrow keys: move a token one square, or one hex on a hex scene", in its registry and FEATURES.md together.
- **Screen readers.** The grid shape is announced with its options. Readings stay in feet, so what a reader hears changes only where it named squares. Disabled Walking, Attach and Trap name their reason.
- **Large interface sizes.** At 130% on a 320 px phone the three choices wrap onto two lines rather than cut a word. The size line wraps under its fields.
- **Touch.** The hex box's corner handles keep their 44 px reach. Wall lines (H2) take a tap per point and a drag for a run, with Done to finish, as the builder's polygon room does.
- **Alignment.** Each changed screen (Grid settings, New scene's form, Line up grid's options and strip on a hex scene, the builder's hint, the ruler's chip, Export) is measured with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px. The lane says which roots `e2e/alignment.e2e.ts` already covers and adds a hex scene's roots.

## 9. Cases

| Case | Expected | Test |
|---|---|---|
| An existing scene after the deploy | Squares, nothing moved, every square test unchanged | migrate, all units |
| New Battle mat, Hex rows, 30 by 20 | 22 rows, 30 hexes in even rows and 29 in odd, lines drawn | hex unit, hex e2e |
| A Medium token dropped between hexes | lands on the nearest hex center | hex e2e |
| A Large token | covers the 3 hexes around its corner, box of 2 cells | footprint unit |
| A Gargantuan token next to a Medium one | 5 ft apart when a hex of each touches | distance unit |
| A drag of 4 hexes on the active creature's turn | "20 ft", a leg of 20 ft on the path, speed colors by it | hex e2e |
| A flier 10 ft up, 2 hexes away, rule `five` | 10 ft | distance unit |
| The ruler from a token to a hex 6 steps off | "30 ft" | hex e2e |
| A 20 ft sphere on a hex corner | the hexes at least half inside, the same count as a brute-force sample | aoe unit |
| A 15 ft cone cast east from a hex rows token | starts at the east side's midpoint, 30° steps on its handle | placement unit |
| A goblin in one hex of a Large creature's area | caught under `anyCell`, by that hex alone | aoe unit |
| Spirit Guardians, a goblin walking in | the reminder fires at the first hex inside | areaTriggers unit |
| A goblin wholly under fog | withheld from players, and back when one of its hexes is revealed | project unit, hex e2e |
| A Large creature half in the party's sight | seen by players | vision unit |
| Switching a scene with tokens and fog to Hex rows | allowed, one undo puts squares back, fog unchanged | room reducer unit |
| Switching a scene with difficult ground | refused, naming difficult ground | room reducer unit, settings unit |
| A Universal VTT scene | the choice disabled, "came with its own square grid" | settings unit |
| `build.paint` sent to a hex scene in H1 | refused, "this scene's grid is hexes" | permissions unit |
| A player sees a hex scene | hex lines, snapping and the outline, no shape control | hex e2e |
| Line up grid on a hex map | the 7-hex box, Apply sets cellPx to a third of its width | calibrate unit |
| Find the grid on a hex scene (H1) | not run, the line says why | grid unit |
| Arrow Up five times on hex rows | the token keeps to one column, zigzagging | shortcuts unit |
| Export as image | hex lines, `crypt-hex-70px.png` | mapexport unit |
| No "square" on a hex scene's DM and player screens | none, except the "Squares" choice | hex e2e |
| A 200 by 200 hex scene zoomed out on a phone | lines skip below 6 px a hex, a redraw within the board's budget | bench |
| Wall line through a hex (H2) | blocks sight and moves, a Large creature passes a one-hex gap | movement unit |
| A route around a wall (H2) | six-neighbor walk, its cost on the drag | walk unit |
| A trap zone of hexes (H2) | goes off at the first hex step onto it | traps unit |

## 10. Tests

- **Hex math, with property tests** (seeded `rng`, `shared/testutil.ts`, a few thousand cases a run, on both orientations):
  - Distance is symmetric, zero only for one hex, keeps the triangle inequality, and equals a breadth-first search on random small boards.
  - The six neighbors are distinct and at distance 1. `hexAt(hexCenter(h))` is `h`.
  - A line from a to b has distance + 1 hexes, each next to the last.
  - A footprint has 1, 3, 7 or 12 distinct, connected hexes around its anchor.
  - Snapping is idempotent and moves a point at most the lattice's covering radius.
  - Every sub-cell of a scene belongs to exactly one hex, or to none in the slivers at its edge.
  - Hex rows and hex columns agree under the transpose.
- **Determinism.** `hex.ts` joins the banned-function test. A golden test pins the bits of a hex scene's sight tiles and withheld tokens.
- **Rules.** Distance by size pair on hexes, height under each rule, area counts per shape against a brute-force sampler, coverage rules and inclusion rules on hexes, the area sweep, fog withholding and the sight test against a brute-force sub-cell scan, the reducer's leg on hexes, the switch refused for each kind of cell data, H1's refused ops, the migration steps.
- **Square stays square.** Every existing unit, integration and e2e test passes with no change to its file. The lane's report shows the diff touches no square test.
- **Mutation checks.** Each new test fails with its rule removed: drop the line's nudge, swap the Large lattice offset, compare only the two anchors' hexes for distance, use the rect in the sight test.
- **e2e.** A new `e2e/hex.e2e.ts` (prefix HX): the DM makes a Hex rows mat, places a goblin and a Large ogre, moves the goblin 4 hexes on its turn, measures, places a fireball and reads who it catches, reveals fog, and a player sees the same. Plus the alignment roots, `maps.e2e.ts` for the shape choice and Line up grid, and `reach`.
- **Bench.** `scripts/bench-grid.ts`: hex lines on the largest scene at fit and at 100%, area coverage for a 1,000 ft line on hexes, against the square budgets of design 9.3.

## 11. Lane plan

Order: after the per-player vision run lands, since both touch `vision.ts`. H1's lanes, then a review, a deploy, live play, then H2, then H3.

| Lane | Owns | After |
|---|---|---|
| HX-1 Contract | `shared/rules/hex.ts`, `shared/rules/grid.ts`, their tests, `shared/model.ts`, `shared/protocol.ts`, `shared/migrate.ts`, `server/rooms/stateSchema.ts`, `shared/reducer/room.ts` (the shape patch and its refusal), `shared/permissions.ts` (H1's refused ops) | none |
| HX-2 Rules | `shared/rules/footprint.ts`, `distance.ts`, `route.ts` (straight legs), `aoe.ts`, `fog.ts`, `vision.ts` (the footprint test), `shared/project.ts` (withheld), `shared/reducer/tokens.ts`, `shared/reducer/areaTriggers.ts` | HX-1 |
| HX-3 Board | `client/lib/scene.ts`, `client/canvas/layers/MapLayer.tsx`, `TokenNode.tsx`, `Stage.tsx` (snapping and keys), `client/state/shortcuts.ts`, `client/features/movement/drop.ts`, `measure/*` (the ruler's chip included), `areas/placement.ts`, `AreaTool.tsx`, `AreaPreviewLayer.tsx`, `draw.tsx`, `caster.ts`, `store.ts`, `tokens/factory.ts`, `placeInputs.ts`, `tokens/resize.ts`, `mapexport/*` | HX-1, beside HX-2 |
| HX-4 Settings and words | `client/features/grid/*`, `scenes/SceneSettings.tsx`, `NewScene.tsx`, `create.ts`, `settings/form.ts`, the word helper and pass, the limit lines (`builder/Options.tsx`, `attach/AttachButton.tsx`, `traps/TrapTool.tsx`, the size picker), `e2e/hex.e2e.ts`, alignment roots, then FEATURES.md, docs/dm-guide.md and the docs in its last commit | HX-2 and HX-3 |

HX-2 and HX-3 work beside each other on HX-1's contract. The word pass is mechanical and suits a lighter model. H2 runs as HX-5 (routes, blocking, the walking ruler: `walk.ts`, `walkWorld.ts`, `movement.ts`, `route.ts`, `measure/walkRuler.ts`), HX-6 (Wall lines, Erase and Difficult ground on hexes, door reach: `client/features/builder/*`, `shared/reducer/map.ts`, `client/features/doors/*`) and HX-7 (attach and traps: `attach.ts`, `dismount.ts`, `moveLeg.ts`, `rules/traps.ts`, `client/features/attach/*`, `client/features/traps/*`), each designed in more detail in its own brief from this note. H3 runs as HX-8 (heights and stairs) and HX-9 (Reveal room and the hex detector).

**Docs to update:** FEATURES.md (its opening "on a square grid", Scenes and maps, Measuring and movement, Areas of effect, Fog and vision, Shortcuts, and a list of what stays square), docs/features.md (section 4, and section 19 loses "Hex and isometric grids" but keeps isometric), docs/design.md (5 Coordinates and units, 9.1 to 9.3, 12, 13.4), docs/dm-guide.md (Making a scene, Lining up the grid, a short Hex grids section with a screenshot), and docs/design-v1-grid-detect.md (section 5's "the app has none").

## As built

Filled by each lane's docs commit, with every place the build went its own way.
