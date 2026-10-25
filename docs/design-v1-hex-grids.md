# raccoon-vtt v1: hex grids beside squares

Status: draft 2, revised for design review round 1 (HX-ASTRA-01 to 07 and HO-1 to HO-11, all adopted, decided as D-261025-11) and the owner's room default (D-261025-10). Code is cited from main at `cf98b4be`. Nothing is built.

The project owner, 2026-10-25, after hearing that per-player sight was never added: "Once done with your current scope of work I'd like you to add support for per player vision (toggleable between whole party and per player by the dm) and also hex grids (keep square as the default though)." Right after: "Any designs these can be done ahead of time should be". Then: "DMs should also be able to set their preferred default for scenes so that when they create a new scene it's square or hex rather than having to change each time".

Decided as D-261025-7 and its amendment: hex grids are a scene's grid shape, square by default for new and existing scenes. The design starts now, and its build waits for the current scope and follows the per-player vision run. D-261025-10 adds the room's default for new scenes. D-261025-11 settles the review's questions. Asking the owner is off, so every other open choice below is a guess at the owner's likely answer, listed with the options it rejects (section 5).

## 1. The answer in short

- **A scene's grid is Squares, Hex rows or Hex columns.** A room setting, "New scenes", picks the shape every new scene starts with, Squares by default. The new scene form shows it and changes it for that one scene. The scene's Grid settings change it later.
- **The world stays measured in cells.** One cell is the distance between two neighboring hex centers, the room's feet per cell, so a hex is one cell across its flat sides. Positions, the fog's bitmap, sight, lights, radii, area shapes and free walls keep their units and their code. Only what reads the grid's cells changes.
- **Every hex is one step.** Hexes have no diagonals, so the room's diagonal rule only combines a distance with height.
- **Sizes follow the DMG's hex table:** Tiny, Small and Medium 1 hex, Large 3, Huge 7, Gargantuan 12.
- **Areas keep their true shapes**, graded per hex by the room's rule, at least half by default, as the 2024 DMG says for "squares or hexes". An emanation is the exception: it covers the hexes within its size in steps of its creature's hexes, so it agrees with the ruler.
- **Walls on hexes are free walls**, drawn as lines from H2. No hex edge keys.
- **Three phases.** H1 runs a fight on a hex map without walls: place, move, measure, areas, fog and party vision. H2 adds walls, ways around them, difficult ground, riding and carrying, and traps other than pits. H3 adds heights, stairs, pits, Reveal room and Find the grid for hexes. Painted ground, pillars, squeezing, Count the squares and the Universal VTT import stay square, each saying so in plain words.
- **The server holds each phase's line.** On a hex scene it refuses every op whose rules are not hex yet, and the shape switch, an undo and a redo all refuse to leave square-only data on a hex scene or hex data on a square one.

## 2. What the 2024 rules say

- **Areas of effect, 2024 DMG ("Running the Game", Areas of Effect),** as quoted in a public rules forum and not checked against the book, which neither review could open: "An area of effect must be translated onto squares or hexes to determine which potential targets are in the area", "choose an intersection of squares or hexes to be the point of origin", and "If an area of effect covers at least half a square or hex, the entire square or hex is affected."
- **Emanation, 2024 rules glossary:** an emanation extends from the creature or object it comes from in every direction. On hexes that reads as steps from the creature's hexes (HX-D11).
- **Creature space on hexes.** The 2014 DMG's table "Creature Size on Squares and Hexes" gives Tiny 4 per hex, Small and Medium 1 hex, Large 3 hexes, Huge 7 and Gargantuan 12 or more, and says a miniature of another footprint still uses the creature's real size for every other rule. No 2024 text on hex footprints was found, so this note follows the 2014 table.
- **Movement.** The 2024 Player's Handbook counts a grid in 5 ft squares with its diagonal rule. Nothing found in the 2024 books covers moving on hexes. This note counts one step per hex, and a hex has no diagonal to rule on.
- **No rule covers** height on a hex grid, hex walls, hex fog or squeezing on hexes. Those follow the app's square rules where they carry over, as below.

## 3. The audit

Every feature that reads the grid, from four read-only sweeps of the code and the review's additions. "Cell" means a world unit square, "rect" a footprint rectangle. The phase says when hexes reach it (section 6), or "square" when it stays square only. Making the grid a required parameter of `footprint.ts`, `distance.ts` and `client/lib/scene.ts`'s `footprint` and `snapPosition` lets the typecheck list every caller, so none is missed.

| Feature | Code | Assumes today | On hexes | Phase |
|---|---|---|---|---|
| Grid lines | `canvas/layers/MapLayer.tsx:118`, `builder/draw.ts:534`, `mapexport/render.ts:70`, `grid/GridLayer.tsx:44` | one path of lines x = 0..w, y = 0..h | hex sides in view (HX-D18) | H1 |
| Map placement | `model.ts` SceneMap and PhaseGrid, `lib/scene.ts:39`, `reducer/phases.ts:31` | one cellPx on both axes | unchanged: cellPx is px across a hex's flats, origin reduced into the lattice | H1 |
| Line up grid | `grid/calibrate.ts`, `tool.tsx`, `GridLayer.tsx`, `Options.tsx`, `outcome.ts` | a 3 by 3 square box | a box 3 by 2.89 cells holding 7 hexes | H1 |
| Count the squares | `SceneSettings.tsx:242`, `calibrate.ts:163` | squares across and down | none | square |
| Find the grid, name hints | `grid/detect.ts`, `findGrid.ts:89`, `server/assets/kinds.ts:136` | axis-aligned lines, `NxM` names, a negative origin marks an import | squares only until a hex detector | H3 |
| Snapping, group drops | `lib/scene.ts:28`, `footprint.ts:95-118`, `Stage.tsx:1127`, `lib/group.ts:58` | per-axis round to 1 or 0.5 | nearest anchor (4.2) | H1 |
| Footprints | `footprint.ts:126-170` (24 files call it), `model.ts:632` | N by N rect of cells | sets of 1, 3, 7 or 12 hexes | H1 |
| Token drawing | `TokenNode.tsx:127-140`, `Stage.tsx:1483` | w by h box | the size's box around the anchor, a hex outline when selected | H1 |
| Placement, duplicate, companions | `tokens/factory.ts:230-318`, `tokens/companions.ts:225`, `permissions.ts:2059`, `reducer/duplicate.ts:168` | Chebyshev rings, square boxes | hex rings, hex distance | H1 |
| Size and resize | `rules/resize.ts`, `tokens/resize.ts:124` | per-axis spots, custom w by h | size categories, the reference hex kept (4.2) | H1 |
| Distance between creatures | `distance.ts:27-85` | per-axis steps, three diagonal rules | hex steps between the sets, the rule only with height | H1 |
| Ruler, Straight | `measure/ruler.ts:41-102`, `RulerLayer.tsx` | a cell's center, rect exit | hex center, hex outline | H1 |
| Range rings | `measure/rings.ts:33-100` | outline along square sides | outline along hex sides | H1 |
| Drag, legs, path, labels | `movement/drop.ts:248`, `stageHooks.ts:398`, `dragTesting.ts:135`, `preview.ts:88`, `route.ts:158-327`, `reducer/tokens.ts:602` | Chebyshev steps of the top-left | hex steps between reference hexes | H1 |
| Walk spots | `route.ts:395-422` `routeWalk`, `reducer/tokens.ts:627` `routeSeen`, `server/rooms/ephemeral.ts:126-140` | Chebyshev samples on the square lattice | the hex line (4.4) | H1 |
| Area sweeps | `reducer/areaTriggers.ts:300-348` | half-cell samples, height included | the hex line, height included (4.4) | H1 |
| Arrow keys | `state/shortcuts.ts:297`, `Stage.tsx:819` | four directions, one square | one hex, zigzag | H1 |
| Routes, walking ruler | `walk.ts`, `walkWorld.ts`, `route.ts`, `measure/walkRuler.ts` | 8 neighbors on a half lattice | 6 neighbors on the anchor lattice | H2 |
| Movement blocking | `movement.ts:91-155, 892` | square core, 9 half-cell shifts | each hex center's step (HX-D8) | H2 |
| Squeezing | `movement.ts:209-247, 809-848`, `footprint.ts:63` | footprints shrink on cell lines | none | square |
| Area shapes | `aoe.ts` predicates | continuous 3D | unchanged, except emanations | H1 |
| Emanations | `aoe.ts:211, 436, 615-635`, `model.ts` AreaFootprint | a rounded box from the rect, 5 probes | steps from the footprint's hexes, stored as hexes | H1 |
| Area coverage and shading | `aoe.ts:30, 661-808`, `areas/draw.tsx:26` | 16 by 16 samples per cell | a fixed sample pattern per hex | H1 |
| Area placement and range | `areas/placement.ts:215-322, 606`, `caster.ts:356`, `AreaOptions.tsx:462`, `AreaPreviewLayer.tsx:112` | intersections or centers, 8 rect points, 45° | hex corners or centers, outline corners and side midpoints, 30° | H1 |
| Who an area catches | `aoe.ts:870-996` | occupied rect | footprint hexes | H1 |
| Areas that slow movement | `walkWorld.ts:160` | square cells | hex cells | H2 |
| Fog bitmap and shapes | `fog.ts:16, 215-307, 361` | world raster | unchanged | H1 |
| Tokens under fog, in sight | `fog.ts:120-140`, `project.ts:223, 367, 2294`, `vision.ts:71, 322` | a cell's 4 by 4 block, the rect | sub-cells inside the footprint's hexes | H1 |
| Labels, stamps, pins under fog | `fog.ts:148`, `project.ts:910, 1131` | world cells of the raster | unchanged | H1 |
| Sight, lights, explored ground | `vision.ts`, `server/rooms/explore.ts` | world units | unchanged, no walls in H1 | H1 |
| Reprojection | `reducer/tx.ts:748` | a scene's fog, walls rule and vision | its shape too (HX-D21) | H1 |
| Player scene copy | `project.ts:999-1020` | a field allowlist | adds `gridShape` | H1 |
| Undo and redo | `reducer/misc.ts:95-130`, `reducer/tx.ts:525` | hash guards only | the shape's invariant (HX-D14) | H1 |
| Reveal room | `walls.ts:1434`, `fog/shapes.ts:113-141` | painted squares, edge walls | hexes flooded up to free walls | H3 |
| Edge walls, automatic walls | `walls.ts:34-129, 479-609, 694`, `autoWalls.ts` | n and w edges | none (HX-D7) | square |
| Free walls | `segments.ts`, `walls.ts:1100` | ends on the 1/64 lattice | unchanged, hex corners rounded onto it | H2 |
| Painted ground, rooms, pillars | `builder/cells.ts`, `geometry.ts`, `draw.ts:228-336`, `walls.ts:525` | square cells | none | square |
| Builder walls and doors | `builder/cells.ts:192-251`, `tool.tsx` | nearest n or w edge | Wall lines | H2 |
| Cell bounds | `reducer/map.ts:140`, `walls.ts:557, 1441`, `builder/cells.ts`, `walk.ts:690-740` | x < w, y < h, W by H grids | the scene's hexes (4.3) | H2 |
| Difficult ground marks | `model.ts:476` `rough`, `walk.ts:598`, `reducer/map.ts:265` | per square | per hex under hex keys | H2 |
| Heights, ledges, stairs, pits | `heights.ts`, `walls.ts:539-605`, `heights/relief.ts`, `reducer/traps.ts:233` | 4 neighbors, n e s w | 6 neighbors and directions | H3 |
| Doors and their reach | `permissions.ts:1922`, `doors/doors.ts:72` | the squares beside an edge | the hexes beside a free door | H2 |
| Traps | `rules/traps.ts:85`, `project.ts:958, 2315`, `client/features/traps/rules.ts`, `protocol.ts:1572-1589` | rects read as raster cells, half-lattice wires | hex rects read by their sub-cells, wires on the 1/64 lattice | H2 |
| Riding, carrying, dragging | `attach.ts:45-298`, `dismount.ts`, `moveLeg.ts:127-250` | rects, Chebyshev rings | hex sets and rings | H2 |
| Universal VTT import | `uvtt/*` | the format is square | none | square |
| Export as image | `mapexport/size.ts:45`, `fileName.ts:14`, `MapExport.tsx:163` | px per square, `-30x20-70px` | px per hex, `-hex-70px` | H1 |
| Starter maps | `shared/starter.ts:72`, `starter/mapScene.ts` | measured square grids | the room's default, Line up grid on hexes | H1 |
| New scene, settings | `scenes/create.ts`, `NewScene.tsx:258`, `SceneSettings.tsx:92, 208`, `settings/form.ts:167` | square words and defaults | the shape row, the room default | H1 |
| Words | about 200 strings in 33 client files, `server/rooms/undoLabels.ts:234, 669`, `permissions.ts:363`, `reducer/traps.ts:46-60` | "square" | the scene's cell word | H1 |

## 4. The hex grid

### 4.1 Geometry

- **Two orientations.** Hex rows have pointed tops, so a row runs straight across. Hex columns have flat tops. Every rule is written for rows and reads columns by swapping x and y. That swap is a mirror, not a turn: the neighbor order, clockwise from east on rows, reads counterclockwise from south on columns, and so does every rule with a handedness (rings, stair facings, rotation steps). A chirality test pins it.
- **Constants.** `HEX_S = 0.8660254037844386` (√3/2, the spacing of rows) and `HEX_R = 0.5773502691896258` (1/√3, center to corner), written as literals. In doubles `1.5 * HEX_R !== HEX_S`, so a corner computed from the hex above differs from the same corner computed from the hex below. One function, `cornerAt(g, index)`, gives every corner by its own index, rounded to the 1/64 lattice, for Large anchors, area origins and wall ends alike. Nothing derives a corner from a center.
- **Keys.** A hex is `"col,row"`, offset coordinates, odd rows shifted half a cell right. The center of hex (c, r) is `(c + 0.5 + 0.5 * (r % 2), HEX_R + r * HEX_S)`. Distance, lines and rounding go through cube coordinates inside `hex.ts` and never reach stored data.
- **The scene's hexes** lie wholly inside its rectangle. Bounds stay in cells (at most 200 by 200), so a 30 by 20 scene holds 30 hexes in even rows, 29 in odd rows and 22 rows, and a 200 by 200 one 230 rows.
- **Which hex holds a point:** cube rounding, ties to the smaller row, then the smaller column. A fog sub-cell's center is an odd multiple of 1/8, so the upright sides of hex rows never split one, and the rounding settles the sloped sides the same way everywhere. A scene hex holds 12 to 16 sub-cells.
- **Exactness.** `hex.ts` uses only `+`, `-`, `*`, `/`, `Math.floor`, `Math.round`, `Math.abs`, min and max, and joins the test that bans `sqrt`, `hypot`, trigonometry and powers in what vision and segments import. The reducer reads it on replay, so every device must agree bit for bit.
- **The map's origin** is reduced into the lattice's period at or after the image's top-left, never negative, so a hex scene never reads as an older import (`cameWithGrid`).

### 4.2 Footprints

| Size | Hexes | Anchor | Reference hex | Box side |
|---|---|---|---|---|
| Tiny | 1 | its hex's center | its hex | 0.5 |
| Small, Medium | 1 | its hex's center | its hex | 1 |
| Large | 3: a hex and the two below it | the corner the three share | the top hex | 2 |
| Huge | 7: a hex and its six neighbors | the center hex's center | the center hex | 3 |
| Gargantuan | 12: the Large three and the nine around them | the same corner | the top hex | 4 |

- **Position.** A token's `x, y` stays the top-left of its size's box, whose center is the anchor. Drawing, hit areas, the action bar, drag frames, tethers and labels work unchanged. Only rules that read occupied cells branch on the grid.
- **Anchors** for Tiny, Small, Medium and Huge are hex centers. For Large and Gargantuan they are corners (`cornerAt`), one lattice the same shape as the centers, so every size moves in the same six steps.
- **Ties.** A snap ties to the smaller row, then the smaller column. A resize keeps the reference hex where it was: a Medium growing Large keeps its hex as the top one, and a Large shrinking Medium keeps its top hex.
- **A leg's steps** are the hex steps between its start and end reference hexes, so a leg whose stops differ in size still counts.
- **A custom size** reads as its size category (`sizeCategory`, longer side), anchored at the center of its stored box as drawn. The size picker offers categories only on a hex scene.
- **Inside the scene.** Wherever a rule keeps a footprint inside the scene today (placement, a player's teleport, landings), its hexes must be the scene's hexes.
- **Height** keeps its default, the box side times the feet per cell.

### 4.3 Distance, movement and chunks

- **Between two creatures:** the fewest hex steps between any hex of one and any hex of the other. Adjacent hexes are 1 step, shared hexes 0.
- **With height:** vertical steps as today. `five` takes `max(h, v)`, `euclid` `hypot(h, v)` rounded to the foot, and `fiveTen` `max + floor(min / 2)` with the path's vertical counter carried across legs as `legFeet` carries it (`distance.ts:68-85`). The horizontal counter stays 0, since a hex has no diagonal.
- **Chunks.** Hex cell data lives in chunks of 16 by 16 hexes by key, so a 200 by 200 hex rows scene reaches chunk row 14. Free walls keep the world chunk of their midpoint. Every bound check on cell data goes through one `inScene(grid, bounds, key)`: `reducer/map.ts:140` and its callers, `walls.ts:557` and `1441`, `builder/cells.ts`, and the per-cell grids of `walk.ts` and `heights.ts`, sized by the scene's hex columns and rows. Chunk indices up to 14 fit the room import's schema (-100 to 100). `protocol.ts`'s `chunkIndex` names only world chunks (free walls, fog tiles) and stays. A test marks the last row of a 200 by 200 hex rows scene and the last column of a hex columns one.

### 4.4 Walk spots and sweeps

- **The hex line** of a leg runs from its start reference hex to its end one, by cube interpolation from a start nudged by 1e-6. On a hex scene `routeWalk` gives it, so every reader of walk spots reads the same hexes: `routeSeen`, the area sweep, the trap sweep from H2, and the drag preview's corners (`ephemeral.ts`). A leg through one fogged hex is not `routeSeen`.
- **Area sweeps keep height.** A leg takes `max(hex steps, vertical steps) / SWEEP_STEP` samples, as `areaTriggers.ts:348` counts elevation today. Each sample stands on the hex line's hex at its fraction, with its elevation interpolated. So a creature rising from 0 to 50 ft through a 5 ft sphere at 25 ft enters it.

## 5. Decisions, with rejected options

- **HX-D1 Orientation:** both, Hex rows first in every list. Hex map art comes either way, and one swap covers both. Rejected: one orientation (half the hex maps could not line up), Hex columns first.
- **HX-D2 World unit:** one cell is the spacing of hex centers. Rejected: a hex coordinate world (fog, sight, lights, areas and free walls would all change). Rejected: one cell across a hex's corners.
- **HX-D3 Distance:** one step per hex, the room's rule only for height. Rejected: Euclidean horizontal distance under true distance (a ruler would disagree with the hexes the table counts).
- **HX-D4 Footprints:** the DMG table, 1, 3, 7, 12. Rejected: Large as a 4-hex diamond (no center), Gargantuan as 19 (far beyond 20 ft), custom boxes on hexes.
- **HX-D5 Tiny:** one hex, at its center. Rejected: four spots per hex (no even split).
- **HX-D6 Large's triangle** points one way, two hexes below one. Rejected: both ways (two lattices, and the creature would turn as it moves).
- **HX-D7 Walls:** free walls only. In H2 a hex scene's Walls and doors draws Wall lines: tap or drag point to point, each line a free wall, door or window, split past 8 cells. Points snap to hex corners while Snap to hex corners is on (the default), else to the 1/64 lattice, for tracing art. Rejected: hex edge keys (three sides per cell, a new derive and new automatic walls, for walls that seldom follow hex sides on map art). Rejected: Wall lines on squares too (not asked for).
- **HX-D8 Blocking on hexes (H2):** a step is allowed when every footprint hex's center-to-center step crosses no movement wall, touching counting as today, and at its end no movement wall crosses the line between two neighboring hexes of the footprint. So a creature passes only where its whole footprint fits: a Large creature needs two rows, not one. A player's creature too big for a gap stops at it with "Too narrow for a Large creature. Squeezing through works on squares only." The DM's moves are never stopped. Rejected: a square core around the anchor (a Large anchor in a one-row corridor lies on the corridor's wall). Rejected: passing where the footprint one size smaller is clear (the footprint pokes through the walls, and its position cannot say which part stands inside).
- **HX-D9 The builder on hexes:** Builder scenes may be hexes (D-261025-11), and the builder offers what each phase supports, saying so for the rest: H1 lights, stamps, labels and Clear build, H2 Wall lines, Remove, door states, Difficult ground and Erase by hexes, H3 Heights and stairs. Painted ground, rooms, pillars and automatic walls stay square. Rejected: the whole builder on hexes (textured hex floors and hex automatic walls are a large build for dungeons people draw on squares). Rejected: refusing hexes for Builder scenes.
- **HX-D10 Fog and sight:** the world raster as it is. Tokens under fog and in sight read the sub-cells inside their hexes. A creature the DM drops across a wall (H2) is read only on the hexes joined to its reference hex by center steps that cross no sight wall, for sight, fog and its drag preview alike. Reveal room on hexes (H3) floods hexes, a step blocked where a movement wall crosses the line between two centers. Rejected: a hex fog raster.
- **HX-D11 Areas:** true shapes graded per hex, except emanations (D-261025-11). An emanation covers every hex within `floor(size / feetPerCell)` steps of its creature's hexes, height counted by the room's rule from the footprint's vertical extent, and clipped by walls through probes at each footprint hex's center, a hex counting when the room's rule passes on its visible part. An emanation that stays put stores its hexes (`AreaFootprint.hexes`). A free origin snaps to the nearest hex corner or center. A cone, line or cube cast from a token starts at the corner or side midpoint of its footprint's outline where the aim leaves it. The 45° step reads 30°. A placed area moves by whole lattice steps. Rejected: true-shape emanations (a 15 ft one catches 10 of the 24 hexes the ruler puts at 20 ft). Rejected: corners only (an eastward cone from a hex rows creature would start off center). Rejected: hex stencils per spell.
- **HX-D12 Line up grid:** a box 3 hexes across, holding its 7 hexes, 3 by 2.89 cells on hex rows (2.89 by 3 on columns), kept to that shape as it is dragged, resized by its corners and nudged. Count the squares stays square. Find the grid stays square until H3. Rejected: placing two hex centers (a worse fit on a small screen).
- **HX-D13 Imports and exports:** a Universal VTT import makes a square scene whatever the room's default, and says so. A scene that came with its grid (`cameWithGrid`: `gridFromFile` or a negative origin) cannot change shape. Export as image draws hexes at a whole number of px per hex and names the file `crypt-hex-70px.png`, which the upload's size hint already ignores. Rejected: the `WxH` name for hexes (other VTTs would read squares).
- **HX-D14 The shape's invariant:** a hex scene holds only what its phase supports, and a square scene no hex data. The switch is refused while the scene holds anything that breaks it, naming what: in H1 painted ground, edge walls and "no wall" marks, heights, stair marks, difficult ground, free walls, any trap, any attach link, a squeezed token, or a fog draft shape of kind `cells`. A restore (undo or redo) that would break it is refused with the same words, checked on the scenes, chunks, traps and tokens it writes, so two DMs cannot sneak square data onto a hex scene. H2 tags every chunk it writes on a hex scene (`BuildChunk.grid`), so a restore can tell square marks from hex ones. Tokens keep their spots, and every rule reads them at their nearest anchor at once. A map scene keeps its cellPx and origin and opens Line up grid. Rejected: converting square data to hexes, refusing while tokens are on the scene, snapping every token in the same op.
- **HX-D15 Arrow keys:** Left and Right move along a row on hex rows. Up and Down go right of straight from an even row and left of it from an odd row, so presses zigzag and keep to one column. Hex columns mirror it. Rejected: six keys.
- **HX-D16 Size row:** a hex scene's size reads in the room's feet-per-cell steps, with a line saying how many hexes it holds. Rejected: sizes typed in hexes and rows (rows do not fit whole cells).
- **HX-D17 Squeezing:** square only (HX-D8).
- **HX-D18 Hex lines:** drawn in the board's own redraws, as square lines are, but only the hexes in view and only while a hex is at least 6 px across, so a pan costs the hexes on screen. Rejected: every hex on every redraw (46,000 on the largest scene).
- **HX-D19 The room's default (D-261025-10):** "New scenes" in Room settings, Grid and distance, last in the group. Battle mat, Map image (pasted ones included), Builder and a starter map all start with it, and the form's Grid row changes it for that scene. A starter map with a measured square grid, made as hexes, opens Line up grid instead of using that grid. A duplicate keeps its source's shape. Rejected: a per-device preference (scenes would differ by device), remembering the last shape used (surprising).
- **HX-D20 Phase refusals (D-261025-11):** the server refuses on a hex scene every op whose rules are not hex yet (section 6), so no stored op on a hex scene ever needs a later phase's rule gated. Rejected: gating each later rule by op version (more replay paths to test for ops nobody could make).
- **HX-D21 A shape change reprojects** the room, as a change of fog or vision does, and so do its undo and redo, since tokens can fall under fog or out of sight without moving (HX-ASTRA-01).

## 6. Phases

### H1: a fight on a hex map, without walls

The shape field and the room default, `hex.ts`, hex lines, Line up grid's box, snapping and group drops, footprints, the selected token's outline, placement and companions, sizes, distance, the Straight ruler, drag labels and speed colors, legs and walk spots, range rings, arrow keys, areas with step-count emanations, area sweeps, fog and party vision with their footprint test, the reprojection, the invariant, export, and the word pass. A hex scene has no walls in H1, so party vision there is light and senses only, and Block movement has nothing to stop until H2. A new hex Map image skips the upload's grid search, which finds squares only.

The server refuses on a hex scene, with `invalid`: `build.paint`, `build.erase`, `build.rect`, `build.poly`, `build.edge`, `build.walls`, `build.height`, `build.stairs`, `build.rough`, every `trap.create` and `trap.update`, `token.attach`, a `token.move` or `token.moveMany` that carries `route` or `squeeze`, a `token.update` that brings an attach link onto it, and a fog `cells` shape. No such op was ever stored, so lifting a refusal later changes no replay. Every op H1 accepts on a hex scene gets a replay test.

| Where | Words shown on a hex scene |
|---|---|
| The builder's hint | "On hexes the builder places lights, stamps and labels. Walls, painted ground, heights and difficult ground need squares." |
| The ruler's Measure chip | Walking is off, with "Walking needs squares." |
| An area's Movement inside | "Counted on squares only." |
| Attach, in the action bar and the token panel | off, with "Riding and carrying need squares." |
| The Trap tool | "Traps need squares." and nothing to place |
| The Fog tool's Reveal room | off, with "Reveal room needs a room built on squares." |
| Doors | none: a hex scene has no walls or doors until H2 |
| Line up grid's options | "Counting works on squares. Use the box." and "Find the grid finds square grids only. Line up the hexes with the box." |
| The size picker | "On hexes a creature takes its size's hexes: Large 3, Huge 7, Gargantuan 12." |
| Room settings, while the room holds a hex scene or its default is hexes | "Feet per square or hex", Diagonal moves adds "On hex scenes every hex is one step. This rule counts only height there.", and the area rules read "Which squares or hexes an area covers", "At least half the square or hex" and so on |

### H2: walls, ways and terrain

Wall lines, Remove and door states on free walls (design.md 12), blocking by HX-D8, routes on the six-neighbor anchor lattice, the walking ruler, difficult ground by hex under hex keys, areas that slow movement, door reach from the hexes beside a free door, Erase by hexes, riding, carrying and dragging, and traps other than pits. Trap zones are rects of hex keys, read for fog and `tileDependents` by their hexes' sub-cells, so revealing other ground never shows a found trap. Wires end on the 1/64 lattice. The chunk tag of HX-D14 comes in. Pits are refused with "A pit needs heights, which hex scenes get later.", since opening one writes ground (`reducer/traps.ts:233`). The builder's hint becomes "On hexes the builder draws wall lines, marks difficult ground, and places lights, stamps and labels. Painted ground and heights need squares."

### H3: heights, pits, rooms and found grids

Heights, ledges and stairs by hex with six facings, light heights from the hex under a light, pits, Reveal room on hexes, and a hex detector for Find the grid, measured on the evaluation's code-drawn hexes and its three real hex maps before it may apply anything.

### Square only, for good

Painted ground and rooms, pillars, automatic walls, squeezing, Count the squares, the Universal VTT import and the export's `WxH` name. Each says so where the DM would reach for it, and FEATURES.md lists them.

## 7. Model and versions

```ts
type GridShape = "hexRows" | "hexColumns";
// Scene: absent reads as squares, the shape of every scene before it.
gridShape?: GridShape;
// RoomSettings: the shape new scenes start with, absent reads as squares.
newScenes?: GridShape;
// AreaFootprint: an emanation that stays put on a hex scene keeps its hex keys, at most 12.
hexes?: string[];
// BuildChunk, from H2: written on a hex scene, so a restore can tell hex data from square data.
grid?: "hex";
```

- **Ops.** `scene.create` takes `gridShape`. `scene.update`'s patch takes `gridShape: "squares" | GridShape`, "squares" removing the field, so a square scene's stored form and its undo hash never change. `room.update`'s settings patch takes `newScenes` the same way. The reducer refuses a switch or a restore that breaks HX-D14, naming the data in the scene's own cell word: "This scene has difficult ground and 2 traps on its squares, which can't stand on hexes. Remove them to change the grid." and "Can't undo that: difficult ground on squares can't stand on this scene's hexes." DM only. `scene.duplicate` and the room export copy the shape.
- **Players** receive `gridShape` in their scene copy (`project.ts:999`), since they snap and draw by it. `tx.ts:748` counts it in a scene's change of visibility (HX-D21). A change of `newScenes` reprojects as every settings change does today, which is rare and cheap enough.
- **Meanings on a hex scene.** `map.cellPx` and `phaseGrid.cellPx` are px across a hex's flats. `originPx` is the canonical pixel of world (0, 0), reduced as 4.1 says. `bounds` are cells. Cell keys name hexes, in chunks of 16 by 16 hexes (4.3).
- **Versions.** H1 takes the next free op and snapshot pair at build time, identity steps as shared/migrate.ts practice, so an older build refuses a room that may hold a hex scene. H2 and H3 take their own pairs, since a build of the phase before would misread their data. HX-D20's refusals mean no rule needs a gate below a phase's op version, and a test replays every op H1 accepts on a hex scene under H2's rules to prove it.
- **Schemas.** `shared/protocol.ts` and `server/rooms/stateSchema.ts` take the new fields. H2 loosens a trap wire's ends to the 1/64 lattice with its op version, and permissions keep a square scene's on the half lattice.
- **Code contract** (`shared/rules/hex.ts` and `shared/rules/grid.ts`, built first):

```ts
type Grid = { shape: "squares" } | { shape: "hex"; orient: "rows" | "columns" };
sceneGrid(scene): Grid      // not gridOf, which reducer/phases.ts already names
hexCenter(g, hex), hexAt(g, point), hexDistance(g, a, b), hexNeighbors(g, hex) // clockwise from east on rows
hexLine(g, a, b), cornerAt(g, index), inScene(g, bounds, key)
footprintHexes(g, size, anchor), referenceHex(g, size, anchor), snapAnchor(g, size, center)
sceneHexes(g, bounds), hexSubcells(g, hex)   // the fog sub-cells whose centers it holds
```

Rule functions take the grid as a required parameter. Their square path is today's code, and every existing test passes unchanged.

## 8. UI checklist

- **Words shown.** Room settings, Grid and distance: "New scenes", "Squares", "Hex rows" and "Hex columns", help "The grid a new scene starts with. Each new scene can pick its own." Scene settings, Grid: "Grid shape" with the same three choices, help "Hex rows have pointed tops and run straight across. Hex columns have flat tops and run straight down." A refusal disables the choice and shows the reducer's words, or "This scene came with its own square grid from its file." New scene, every kind: a "Grid" row on the room's default, and for a starter map with a measured grid made as hexes, "This map is drawn with squares." A Universal VTT import's summary, when the room's default is hexes: "Universal VTT files make square scenes." Line up grid on hexes: "Drag a box over 3 hexes across. Fine-tune it by its corners." and "px per hex". Size on a hex scene: "Size in 5 ft steps" with the room's feet per cell, fields "Across" and "Down", and "Holds 30 hexes across and 22 rows down." Export: "hexes at 70 px", its switch "Hex lines". A token's panel: "Large (3 hexes)". Every string that names the grid's cell, the server's undo labels and refusals included, says the scene's cell word through one helper (`cellWord`). H1's limit lines are in section 6.
- **Loading.** Nothing new is slow. A shape change is one op with the usual pending state.
- **Keys and focus.** Each shape choice is a radio group, arrow keys move within it, and a refusal keeps focus on it with the reason linked by `aria-describedby`. Arrow keys move a token one hex (HX-D15). The shortcut sheet's line becomes "Arrow keys: move a token one square, or one hex on a hex scene", in its registry and FEATURES.md together.
- **Screen readers.** Each choice is announced with its options. Readings stay in feet. Disabled Walking, Attach, Trap and Reveal room name their reason.
- **Large interface sizes.** At 130% on a 320 px phone the three choices wrap onto two lines rather than cut a word.
- **Touch.** The hex box's corner handles keep their 44 px reach. Wall lines (H2) take a tap per point and a drag for a run, with Done to finish, as the polygon room does.
- **Alignment.** Each changed screen (Room settings' Grid and distance, Grid settings, the New scene form, Line up grid on a hex scene, the builder's hint, the ruler's chip, Export) is measured with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px. The lane says which roots `e2e/alignment.e2e.ts` covers and adds a hex scene's.

## 9. Cases

| Case | Expected | Test |
|---|---|---|
| An existing scene after the deploy | Squares, nothing moved, every square test unchanged | migrate, all units |
| A room with New scenes on Hex rows | Battle mat, Map image, Builder and a starter map all start as Hex rows, the form can pick Squares | create unit, maps e2e |
| A Universal VTT import in that room | a square scene, the summary says why | uvtt unit |
| New Battle mat, Hex rows, 30 by 20 | 22 rows, 30 hexes in even rows and 29 in odd | hex unit, hex e2e |
| The last row of a 200 by 200 hex rows scene | row 229 exists and takes a mark (H2) | map reducer unit |
| A Medium token dropped between hexes | the nearest hex center, ties by row then column | hex unit, hex e2e |
| A Medium grows Large, then shrinks | its hex is the Large's top hex, and back | resize unit |
| A party of four group-dragged | each lands on its own anchor | group unit |
| A companion two hexes from its character | 10 ft, outside 5 ft reach | permissions unit |
| A Gargantuan next to a Medium | 5 ft apart when a hex of each touches | distance unit |
| A drag of 4 hexes on the active creature's turn | "20 ft" on the label and the path | hex e2e |
| A flier rising 10 ft a leg for two legs under `fiveTen` | the vertical counter carries | distance unit |
| A leg through one fogged hex | not `routeSeen`, and fails with the hex line removed | reducer unit |
| A 15 ft emanation on a Medium, attached and stationary | 37 hexes, 3 steps out (Large 48, Huge 61, Gargantuan 75) | aoe unit |
| A 10 ft emanation on each size | Medium 19, Large 27, Huge 37, Gargantuan 48 | aoe unit |
| A 20 ft sphere on a hex corner | the hexes at least half inside, as a brute-force sampler counts | aoe unit |
| A 15 ft cone cast east from a hex rows token | starts at the east side's midpoint, 30° steps | placement unit |
| A creature rising 0 to 50 ft through a 5 ft sphere at 25 ft | enters it, and on a steep diagonal too | areaTriggers unit |
| A goblin wholly under fog | withheld, back when one of its hexes is revealed | project unit, hex e2e |
| A switch under a token half in a revealed corner | its visibility follows the hexes without a move, with fog, party vision and per-player vision, and again on undo and redo | project unit |
| Switching with difficult ground, a trap, a link, a squeezed token or a free wall | refused, naming it | room reducer unit |
| Two DMs: A erases difficult ground, B switches to hexes, A undoes | refused, "can't stand on this scene's hexes" | restore unit |
| A trap, an attach, a routed or squeezed move on a hex scene (H1) | each refused | permissions unit |
| A holder with a rider sent to a hex scene (H1) | refused | permissions unit |
| A scene with a negative origin | the shape choice disabled | settings unit |
| Arrow Up five times on hex rows, then on hex columns | keeps to one column, mirrored on columns | shortcuts unit |
| A hex columns ring and neighbor order | counterclockwise from south | hex unit |
| Export as image | hex lines, `crypt-hex-70px.png` | mapexport unit |
| No "square" on a hex scene's DM and player screens | none but the Squares choices | hex e2e |
| A 200 by 200 hex scene zoomed out on a phone | lines skip below 6 px a hex | bench |
| A Large creature at a one-row corridor (H2) | stops, "Too narrow for a Large creature." | movement unit |
| A Large creature the DM drops across a wall (H2) | seen only on its reference hex's side, its preview too | vision unit, ephemeral unit |
| Revealing ground beside a fogged trap of hexes (H2) | the trap stays withheld | project unit |
| A pit on a hex scene (H2) | refused, "A pit needs heights" | permissions unit |

## 10. Tests

- **Hex math, with property tests** (seeded `rng`, `shared/testutil.ts`, a few thousand cases a run, both orientations):
  - Distance is symmetric, zero only for one hex, keeps the triangle inequality, and equals a breadth-first search on random boards.
  - The six neighbors are distinct and at distance 1. `hexAt(hexCenter(h))` is `h`. `cornerAt` gives one point per corner whichever hex asks.
  - A line from a to b has distance + 1 hexes, each next to the last.
  - A footprint has 1, 3, 7 or 12 distinct, connected hexes, and its reference hex is one of them.
  - Snapping is idempotent and ties the same way on every run.
  - Every sub-cell of a scene belongs to exactly one hex, or to none at its edge.
  - Rows and columns agree under the mirror, chirality included.
- **Determinism.** `hex.ts` joins the banned-function test. A golden test pins a hex scene's sight tiles and withheld tokens.
- **Rules.** Every case of section 9 marked unit. The square path stays untouched: every existing test passes with no change to its file.
- **Mutation checks.** Each new test fails with its rule removed: the line's nudge, the Large lattice offset, the reference hex kept on a resize, the vertical samples of a sweep, the shape in `tx.ts`'s visibility check, a restore's invariant, the trap zone's sub-cells, distance by the two anchors' hexes only, the rect in the sight test.
- **e2e.** A new `e2e/hex.e2e.ts` (prefix HX): the room's default set to Hex rows, a mat made, a goblin and a Large ogre placed, the goblin moved 4 hexes on its turn, measured, a fireball and Spirit Guardians read for who they catch, fog revealed, and a player seeing the same. Plus the alignment roots, `maps.e2e.ts` for the Grid rows and Line up grid, and `reach`.
- **Bench.** `scripts/bench-grid.ts`: hex lines at fit and at 100% on the largest scene, area coverage for a 1,000 ft line, against design 9.3's budgets.

## 11. Lane plan

Order: after the per-player vision run lands, since both touch `vision.ts`. H1's lanes, a review, a deploy and live play, then H2, then H3.

| Lane | Owns | After |
|---|---|---|
| HX-1 Contract | `shared/rules/hex.ts`, `shared/rules/grid.ts` and their tests, `shared/model.ts`, `shared/protocol.ts`, `shared/migrate.ts`, `server/rooms/stateSchema.ts`, `shared/reducer/room.ts` (the switch), `shared/reducer/misc.ts` and `tx.ts` (the restore invariant, the reprojection), `shared/permissions.ts` (H1's refusals, companion reach, the refusal words) | none |
| HX-2 Rules | `shared/rules/footprint.ts` and `distance.ts` (the grid required), `route.ts` (straight legs, `routeWalk`), `aoe.ts`, `fog.ts`, `vision.ts` (the footprint test), `shared/project.ts` (the scene copy, withheld, `tileDependents`), `shared/reducer/tokens.ts`, `areaTriggers.ts`, `duplicate.ts`, `server/rooms/ephemeral.ts`, `server/rooms/undoLabels.ts` | HX-1 |
| HX-3 Board | `client/lib/scene.ts`, `client/lib/group.ts`, `client/canvas/layers/MapLayer.tsx`, `TokenNode.tsx`, `Stage.tsx`, `client/state/shortcuts.ts`, `movement/drop.ts`, `stageHooks.ts`, `dragTesting.ts`, `preview.ts`, `measure/*`, `areas/placement.ts`, `AreaTool.tsx`, `AreaPreviewLayer.tsx`, `AreaOptions.tsx`, `draw.tsx`, `caster.ts`, `store.ts`, `tokens/factory.ts`, `placeInputs.ts`, `resize.ts`, `companions.ts`, `mapexport/*` | HX-1, beside HX-2 |
| HX-4 Settings and words | `client/features/grid/*`, `scenes/SceneSettings.tsx`, `NewScene.tsx`, `create.ts`, `starter/mapScene.ts`, `uvtt/ImportDialog.tsx` and `summary.ts`, `settings/form.ts`, the word helper and pass, the limit lines (`builder/Options.tsx`, `attach/AttachButton.tsx`, `traps/TrapTool.tsx`, `fog/Options.tsx`, the size picker), `e2e/hex.e2e.ts`, alignment roots, then FEATURES.md, README.md and the docs in its last commit | HX-2 and HX-3 |

HX-2 and HX-3 work beside each other on HX-1's contract. The word pass is mechanical and suits a lighter model. H2 runs as HX-5 (routes, blocking, the walking ruler), HX-6 (Wall lines, Erase and Difficult ground on hexes, door reach, the cell bounds, the chunk tag) and HX-7 (attach, and traps without pits), each from a brief of its own. H3 runs as HX-8 (heights, stairs, pits) and HX-9 (Reveal room, the hex detector).

**Docs to update:** FEATURES.md (its opening "on a square grid", Scenes and maps, Measuring and movement, Areas of effect, Fog and vision, Shortcuts, and what stays square), docs/features.md (section 4, and section 19 keeps only isometric), docs/design.md (5, 9.1 to 9.3, 12, 13.4), docs/dm-guide.md (Making a scene, Lining up the grid, a short Hex grids section with a screenshot), docs/design-v1-grid-detect.md (section 5), and README.md's update notes for each phase: back up first, and reload every page left open, since there is no client version check and an old page would treat a hex scene as squares.

## 12. Review round 1

| Finding | Where it went |
|---|---|
| HX-ASTRA-01 a switch must reproject | HX-D21, section 7, cases |
| HX-ASTRA-02 trap fog by hex sub-cells | H2, cases |
| HO-1, HX-ASTRA-03 emanations | HX-D11, section 7 (`AreaFootprint.hexes`), counts in cases |
| HO-2, HX-ASTRA-06 H1's refusals and the switch's list | H1, HX-D14, HX-D20 |
| HO-3 restores | HX-D14, section 7, the two-DM case |
| HO-4 walk spots | 4.4 |
| HX-ASTRA-05 sweeps keep height | 4.4, cases |
| HO-5 missed readers | audit, required grid parameter, lane plan |
| HO-6, HX-ASTRA-04 blocking | HX-D8 rewritten, the one-row corridor promise dropped |
| HO-7 chunk bounds | 4.3 |
| HO-8 footprints across walls | HX-D10 |
| HX-ASTRA-07 pits | H2 refuses them, H3 builds them |
| HO-9 import marks, no walls in H1 | 4.1, HX-D13, H1 |
| HO-10 smaller fixes | 4.1, 4.2, 4.3, HX-D9, HX-D12, HX-D18, section 7, docs |
| HO-11 tests | sections 9 and 10 |
| D-261025-10 the room's default | HX-D19, sections 7 to 9 |

## As built

Filled by each lane's docs commit, with every place the build went its own way.
