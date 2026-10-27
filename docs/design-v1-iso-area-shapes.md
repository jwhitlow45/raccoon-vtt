# raccoon-vtt v1: areas as their real shapes in Isometric

Status: draft 3, revised for design review rounds 1 and 2 (section 12), D-261026-30 and D-261026-31. Code is cited from main at `fbced312`. Nothing is built. It builds on the isometric view (docs/design-v1-isometric-view.md, "the iso design" below) and keeps every rule of it that this note does not name.

## 1. The owner's words

The project owner, 2026-10-26: "Also areas should display as their actual shape in isometric (so as an example sphere as a sphere to make it easier to see what flying monsters will get caught in it)".

D-261026-28 sets the direction: in Isometric every area draws as its 3D shape at its real height and aim, translucent with an outline, over the ground shading it draws today, and Top-down stays flat. No switch. The design settles depth order, the fog rule, level of detail and phone cost. D-261026-30 keeps an area visible inside a pit down to its floor, and D-261026-31 draws a caught creature's ring at its standee's base. Asking the owner is off, so every other open choice below is a guess at the owner's likely answer, listed with the options it rejects.

## 2. The answer in short

- **The rules' own solid.** What stands is the shape the rules catch with (`resolveArea`, shared/rules/aoe.ts:552), cut by its own wall polygons for every viewer, the scene's edges and the drawn ground, and inside a pit's opening down to its floor. A creature the area may catch whose cells lie inside it through their height is caught, and one whose cells miss it is not, by a property test.
- **A mesh in depth bands.** The solid is a closed, translucent surface mesh, its faces split at the band planes so each lies in one band, one cell deep, at every turn. Bands join the relief's depth list (iso design 5.6), so a flier inside a sphere draws between its far and near faces and reads inside.
- **The stand rule.** For a player a volume stands only where every fog sub-cell under its wall-clipped plan is revealed, else the area lies flat under the fog exactly as today.
- **Caught rings** draw at a standing creature's base, at its drawn height, while its area's volume stands (D-261026-31). Otherwise they stay on the ground as today.
- **Unchanged:** Top-down, the ground shading and outline, the name pill, trap hit areas and the grips. Volumes stand where heights stand (12 px a cell, 24 in Low power).
- **Cost.** In the prototype, four large areas add 4 to 9 ms to a 40 px pan frame on the 4x CPU phone stand-in. The gate stays the bench's: at most 1.75 times Top-down's same frame. Building is lazy, in view, sliced, and shows that it is loading.

## 3. Decisions, with rejected options

- **ISOA-D1 One solid, the rules':** the resolved shape, cut by `ResolvedArea.polygons`, the scene's edges and the drawn ground (D5, D6). Rejected: a look-alike drawn per shape (two geometries that can disagree with who is caught), the covered cells raised as columns (stepped, not "a sphere as a sphere").
- **ISOA-D2 A closed surface mesh, split at the band planes:** every face is cut where it crosses a band plane of either family, so a face lies in one band at every turn. Rejected: a face's band by its middle alone (review: 1.77 cells off at a radius of 20, 6.9 at 100), slabs of the volume at constant depth (the prototype's upward cone lost about a third of its fill), a back half before and a front half after the whole volume (a creature in front of a sphere but within its depth range reads inside), sorting each standee against each volume (a pairwise order the depth list cannot hold), WebGL (a second renderer for one feature).
- **ISOA-D3 Bands one cell deep, merged into runs:** consecutive bands with nothing between them in the depth list draw as one run, one fill for its far faces and one for its near faces, each the boundary loops of the run's faces. Rejected: half-cell bands (twice the cost for an order finer than the relief's own), a fill per triangle or per band (2 to 4 times the cost, section 6).
- **ISOA-D4 Fog by the stand rule (D-261026-5),** read on the wall-clipped plan before the ground cut, so a cell whose column hides the solid still counts: a volume stands only when every fog sub-cell of that plan is revealed to the viewer, else lies flat as today. Rejected: cutting the volume at the fog's edge (a capped cut reads as a wall and an open one as a broken shell, prototype screenshots), standing over fog (draws the area over ground Top-down hides), the plan after the ground cut (it skips fogged sub-cells of a partly seen column).
- **ISOA-D5 One clip for every viewer:** `ResolvedArea.polygons`. Under D4 a wall that cuts a standing volume always stands for that player (4.4). Rejected: the walls standing for each player (a second geometry with its own cache, equal wherever the volume stands), no walls (a volume through a wall makes creatures behind it look caught).
- **ISOA-D6 Cut at the drawn ground, and inside a pit's opening down to its floor (D-261026-30),** those bands under the pit clip standees take. Rejected: cut at 0 over a pit (a flier caught in a pit would draw outside the solid), through the ground (the lower half of a sphere shows over the floor).
- **ISOA-D7 Volumes stand where heights stand (ISO-D12):** from 12 px a cell, 24 in Low power, else flat as today. Rejected: always (the 200-area cap at the fit), a budget of standing volumes (volumes pop up and lie down as a pan crosses it).
- **ISOA-D8 Moving volumes draw whole in the drag layer:** an area being aimed (coarse, unsplit, while the finger moves), an aura whose token is dragged, and other members' previews. An aimed area joins the depth list at rest, when its coverage refines (`samplesNow`, areas/store.ts:132). Rejected: in the depth list while moving (each pointer move redraws the relief and splits the mesh again), flat while aiming (aiming is when the owner wants to see who is caught).
- **ISOA-D9 Guides:** a sphere's equator and an emanation's middle, a ring at the shape's widest, so the origin's height reads. Rejected: none (a sphere's height does not read), contour rings every 5 ft (clutter on a phone).
- **ISOA-D10 What stays:** grips on the drawn ground, with a dashed line up to a raised origin. The name pill at its Top-down spot by its stand rule (ISO-3). Rejected: grips at the origin's height (a press reads the ground, ISO34-ASTRA-5), the name over the volume's top (its keep-off and stand boxes are Top-down's world boxes).
- **ISOA-D11 Caught rings at the base (D-261026-31):** a ring at the standee's base, at its drawn height, when the creature stands by the stand rule and its area's volume stands. Rejected: the ring at the footprint on the ground (it reads as the shadow being caught).
- **ISOA-D12 Bands meet a standee at its natural key,** its footprint's middle, not the key the own-cells and holder rules raise it to: a band draws after the last placed standee whose natural key is at or below the band's key (4.3). Rejected: the raised key, astra's final keys (a lone Gargantuan flier over a platform reads up to 2.12 cells late, so inside can read outside).

## 4. The model

### 4.1 The solid

- **`Solid3`** extends `Shape3` (aoe.ts) with `span(x, y)`: the vertical interval over a map point in cells, or null. Every shape is convex, so it is one interval: a sphere `oz ± √(r² − d²)`, a cylinder its two ends inside its circle, a level box its two faces, a cone and an aimed box their linear constraints in z with the cone's quadratic, a rounded box its box's ends grown by `√(D² − d²)`. A property test holds `inside(x, y, z)` to `lo ≤ z ≤ hi`. `ResolvedArea.shape` becomes a `Solid3`. `shade`, the pitched top view (`prismShape`), stays a `Shape3` whose `inside` ignores height, and nothing asks it for a span.
- **`ResolvedArea.solid`** names the shape's parameters in cells, so the drawing reads the rules' numbers: `sphere {c, r}`, `cylinder {c, r, z0, z1}`, `cone {apex, a, n, m, L}` (`aimFrame`), `box {c, axes, half}` for cubes and lines level or aimed, `rounded {box, D}` for an emanation (a point emanation is a box of no size), and on hexes `hexStack` (4.6).
- **The clip** is the union of `ResolvedArea.polygons` inside the scene's rectangle, above the drawn ground (`drawnGround`, iso design 4.3), which over a pit's opening is its floor.
- **What it promises,** for a body above the drawn ground under its cells, a pit's floor included. A creature the area may catch (not its origin creature when `includeOrigin` is false, aoe.ts:999, and on hexes 1417) whose cells, the ones the rules read, lie inside the DM's solid through its height is caught under every coverage and inclusion rule. One whose cells miss it is caught under none. Between, the room's rule grades it, as Top-down's shaded squares do. The solid stays whole around an origin creature, and the missing ring shows the exception. Parts under the drawn ground are outside this promise: the rules clip nothing by terrain (aoe.ts:989-1015), so a creature buried in a column can be caught where no solid draws, and its own cells hide it anyway (iso design 5.6).

### 4.2 The mesh (`client/features/areas/volume.ts`)

1. **Tessellate** the solid, closed and wound outward: around a circle `4⌈π√(r·px)/4⌉` segments, 16 to 64, so a chord strays about a pixel at this zoom, along a length about a cell a step. Rebuilt when the zoom crosses a factor of 2. Coarse (16 around) while it moves.
2. **Clip by whole lines.** Every face straddling a polygon edge's line or a scene edge is cut by it, each new vertex computed from its edge's ends in a fixed order, so both faces beside an edge get the same point. Keep the pieces whose middle lies in the clip.
3. **Caps from the cut loops.** The clip leaves open edges along each clip line. Close each chain with the upright edge at the corners where it meets the next line, unroll it along its line into length and height, and triangulate it from those same vertices, wound out of the solid. Shell and caps then share every vertex.
4. **Ground.** Cut by the whole cell lines where the drawn ground steps and the whole level planes at each ground height under the shape, then drop the pieces below their cell's ground and the faces lying on it. Over a pit's opening the ground is its floor (D-261026-30). The edges left open lie on the drawn ground, or up a cell's side where the ground steps, between its two heights. These are the **ground omissions**. Everything else is closed and wound outward.
5. **Bands.** Cut every face by the band planes it crosses, `x + y = m√2` and `x − y = m√2` (view.ts:62-67: turns 0 and 2 read the first family, 1 and 3 the second), so each piece lies in one band at every turn. Edges and guide pieces take the same cuts.
6. **Buckets.** Faces are filed in the relief's 16 by 16 buckets by their middles. Step 5 runs on a bucket when it first comes into view, and a turn sorts only the buckets in view, as 5.6 does for pieces.
7. **Edges** once per geometry, each with the faces beside it. **Per turn**, a face is **near** when `n · (K·s, K·c, ½) > 0`, else **far**, in band `⌊depth(middle)⌋`. An edge is a **silhouette** where a near face meets a far one, a **crease** where faces meet at more than 35°, a wall cap's rim, or a **ground rim** (an open edge on the ground), drawn solid beside a near face and dashed beside a far one.
8. **Per run, at layout:** the boundary loops of its near faces and of its far faces, by a walk of the edges with one side in the set, kept by area, turn and band range.
9. **Footprint:** the sub-cells the plan of the capped shell covers after step 3 and before step 4, by its faces' boxes, for the stand rule.

The prototype checks all of it. Its capped sphere cut at x = 5.31 has no open edge, where the review counted 210 with caps built from `span`. With a wall stub beside a 10 ft platform, in a closed room, and in a pit, every open edge is a ground omission. After step 5, no vertex lies more than 5e-14 cells outside its face's band at any turn. Splitting multiplies faces: 760 to 1,760 at a radius of 4 cells (40 px a cell), 1,984 to 7,600 at 10, to 14,960 at 20, and to 118,944 at 100, about 3.8 a cell of plan. A giant area costs what its buckets in view hold, about 1,000 faces each.

| Shape | Outline at every turn (orthographic from 30° up, so a sphere's outline is a circle of its radius) |
|---|---|
| Sphere | the circle, its ground rim, its equator as a guide |
| Cylinder | the top rim whole, the bottom rim's near half solid and far half dashed, two upright sides |
| Cone | its base rim, an ellipse turned with its aim, and two lines from the apex |
| Cube, line | its visible edges solid and its hidden ones dashed, a line aimed up or down as a long box |
| Emanation | the creature's box grown by its distance, round at the corners, its middle as a guide. On hexes the stack's edges |

### 4.3 Depth

- **Entries.** `ReliefIndex.layout` (relief/buckets.ts:191) takes volumes beside standees: each area's bands, sorted per turn, keyed at the band's middle, merged with the buckets. Ties draw column, pit, wall, volume, standee, then id. Consecutive entries of one area with nothing else between them make one run: far loops filled, near loops filled, then its hidden lines, then its outline. Runs draw in `ReliefRun` like other pieces, so no Konva node is added.
- **Why a flier reads inside.** A standee is an upright at one depth. Inside a convex volume the far faces under its art lie deeper and draw before it, and the near faces draw after it: tinted once, with the far outline behind it. A creature in front draws after every face under its art and stays clear. One behind draws before both and takes both tints. With step 5 the order is right to within one band.
- **Natural keys.** A standee's natural key is `sortKey(center)`. Its placed key is raised to the largest `keyOf(cell)` of its own cells at or below its base (buckets.ts:303-310), then for a rider to the largest own key along its holder chain (buckets.ts:318-326). Standees draw in placed order (buckets.ts:339). Its **raise** is placed key minus natural key, exactly as the code computes it. For whole-cell footprints aligned to the grid that is at most `(w + h − 2)/(2√2)` cells (0.71 for a Large, 2.12 for a Gargantuan). A Tiny or a fractional custom size takes its whole cells (footprint.ts:149-153), so its raise comes from those cells' keys: a Tiny's is up to 0.35, where the formula would go below 0.
- **The precedence rule.** A band draws after the last placed standee whose natural key is at or below the band's key, and before every standee placed after that one. So a band is never before a standee it lies behind. It may follow that standee past pieces nearer than itself: a column, a wall, or a standee placed before that one, which then takes the band's tint. The error is at most that standee's raise. Astra's case: A natural 14.142, raised to 16.263, B at 15.556 placed before A, a band at 15.5. The band draws after A, so after B too, and B, nearer by 0.056, takes its tint, within A's raise of 2.121. Accepted.
- **Pits.** Bands inside a pit's opening take the clip standees take there (buckets.ts:54-55, iso design 5.5), the openings swept upward past the canvas top, so the near rim hides what lies below it.
- **Columns and walls** sort with bands the same way, and a volume never draws inside a column, being cut at its top. **Two volumes** interleave band by band, and their low tints blend in either order.
- **Silhouettes** (5.6): a band never gives a standee one, being translucent.
- **Accepted:** a flier whose lift is capped (5.4) draws lower than it is, so it can draw among a tall volume's bands, its badge and dashed stem saying its height. Where a wall cuts a volume, its cap and the half-height stone wall share a depth, and the cap may tint the stone's near side.

### 4.4 What stands and what lies flat

- For a player on a scene with fog, a volume stands only when every fog sub-cell of its footprint (4.2 step 9) is revealed to that player. Otherwise the area lies flat on the ground stage under the fog, as it draws today. The DM's and a fogless scene's volumes always stand. View as a player reads the player's fog, and a table display its own, as a player who owns nothing.
- **Why one clip is safe.** Every shape's plan is convex and holds its visibility probes. If a wall cuts a standing volume between a probe and a point of its plan, the sub-cell beside that wall on the probe's side lies in the footprint, so it is revealed and the wall's run stands (runs.ts:12-15). So the rules' polygons cut a standing volume exactly where the walls standing for that player would. A wall hidden inside a partly seen column cannot cut a standing volume, since that column's fogged sub-cells are in the footprint and the volume lies flat. An equivalence property test holds this on random scenes.
- **Its cache key** is the coverage key (`coverageCacheKey`, aoe.ts:897, which carries `ctx.walls.version`), the viewer's fog tiles, the scene, its bounds, the drawn heights object, the zoom octave and coarse or fine. A door opened or closed in sight, with no fog change, rebuilds it.
- So a player's volume reads its template as received, the walls the client holds, and the drawn ground under its revealed footprint. Its name stays where ISO-3 stands it.
- **Caught rings (D-261026-31).** `TemplateLayer`'s ground shapes keep the shading and outline. Each placed area publishes the creatures it catches with its color, through a slot like the pills'. A creature that stands by the stand rule draws a ring per catching area at its base, at its drawn height, beside its selected and active outlines (TokenNode.tsx's `Standee`), while that area's volume stands. A creature lying flat keeps its ring on the ground at its footprint, under the fog with the flat creature. An area lying flat keeps its rings on the ground with it, as today. Which rings a player gets at all stays D-261026-29 (5)'s, and this lane changes only where they draw.

### 4.5 Each state

| State | Isometric |
|---|---|
| Placed area | ground shading and outline as today. The volume in the depth list, rings at the caught creatures' bases, its name pill as ISO-3 stands it |
| Area being aimed (this device) | while the finger moves: a coarse, unsplit volume, whole in the drag layer, far faces then near faces. At rest: the fine volume joins the depth list, as the coverage refines. The flat shading and range line as today, and its rings at the bases |
| Other members' previews | whole in the drag layer, coarse, fill and dashed outline as Top-down's remote preview. Never in the depth list |
| Selected placed area, Area tool | as an aimed area, its outline 2.5 px. Grips on the drawn ground as today, and a dashed 1 px line from the origin grip up to a raised origin |
| Aura at rest | a placed area. An attached area follows its token's stored spot |
| Aura, token dragged here | `DragMarks` draws in two passes around the `DRAG_GROUND` group (IsoBoard.tsx:466-469): the bands behind the dragged standee's key before it, the bands at or in front of it after, so the creature reads inside its own aura. Rebuilt at each cell the drop crosses, coarse. Standees on the relief under it take its whole tint. Its catches publish to the ring slot from where the drag would drop |
| Aura, token dragged elsewhere | whole on the overlay with the other moving marks, coarse |
| Moving aura over fog | the stand rule at each crossing, else today's flat moving mark clipped to revealed sub-cells (5.1) with its rings on it |
| Trap hit areas | unchanged: drawn only for the open trap with the Trap tool (TrapLayer.tsx:68-74), which shows Top-down (ISO-D9). Trap zones are squares, wires and doors with no height, and stay flat |
| DM-only area, area on a hidden token | the DM's volume, a DM-only one at 60% with a dashed outline, as Top-down. Players never receive either |
| Below the threshold, Low power | flat as today, rings on the ground (ISOA-D7) |

### 4.6 Hex scenes

True shapes stand as on squares. A hex emanation (HX-D11) stands as `hexStack`: each hex its reach covers, from the lowest to the highest layer `withinReach` passes, as one prism, sides only where a neighbor's interval does not cover. So the drawn solid is exactly the hexes and layers it catches. The client passes squares on hex scenes until HX-3 (docs/design-v1-hex-grids.md, As built), and a volume reads whatever `resolveArea` reads, so it follows HX-3 with no change. Hex walls clip by their polygons, and hex heights cut by their drawn ground (H3).

## 5. Look

- **Fill:** the area's color at 16% on far faces and again on near faces. What lies behind a volume takes about 30%, what lies inside it 16%, and what lies in front nothing.
- **Outline:** silhouette, near creases, wall cap rims and near ground rims 2 px in the area's color at 95%. Hidden creases and far ground rims 1 px dashed 4 4 at 55%. Guides 1 px, near at 80%, far dashed as hidden lines. A wall cap has an outline, so it reads as the wall stopping the area.
- **Caught rings** keep Top-down's width and gap (`CAUGHT_RING`), as an ellipse round the standee's ring at its base.
- **DM-only** 60% with the outline dashed 6 4. **Selected** outline 2.5 px. **Other members' previews** fill 10%, outline dashed 8 5.
- The ground shading (26%) and its outline stay where they are, so the volume's foot and the squares it covers read as today.
- **Against maps.** The outline carries the shape on parchment, light art and the builder's textures. The fill is the area's own color, as Top-down's shading is.
- **Phones.** Line widths are screen pixels. From 12 to 20 px a cell the outline does most of the work and the fill stays.
- Rejected: faces lit and shaded (a fill per shade per run, seams), a dark halo under the outline (it breaks where runs join, prototype), fills alone or outlines alone (D-261026-28).
- **Screenshots** of the prototype are in the screenshots folder `iso-area-shapes`: a sphere over fliers at turns 0 and 2, a cone aimed up at turns 0 and 1, a cylinder at turns 0 and 3 and an emanation on a creature at turns 0 and 1 on parchment, a sphere cut by a wall beside a platform at turns 0 and 1, a player's sphere in a room under fog, a player's sphere touching fog lying flat, a cube and a line aimed up, and a phone at 40 px a cell. They draw the caught rings on the ground, as before D-261026-31. The cylinder's dark top past the parchment's edge is its two 16% fills over the dark background.
- **Tokens:** a new `area` block in `theme.ts`: `volumeFill`, `volumeLine`, `volumeHidden`, `volumeGuide`.

## 6. Cost

Draw-call medians from a throwaway prototype outside the repository (canvas 2D, headless Chrome, 390 by 844 at 2x, CPU 4x through the DevTools protocol, 30 frames of a pan, 1-cell bands, meshes split as 4.2 says). The typical scene holds a 20 ft sphere 10 ft up, a 30 ft cone aimed 40° up, a 10 by 40 ft cylinder and a 15 ft emanation, all large on a phone, and 16 tokens. "Without" draws the ground with every area's shading and the standees.

| Frame | Without | With |
|---|---|---|
| typical, 40 px, each volume one run | 14.8 | 18.7 |
| typical, 40 px, each band its own run (the worst split) | 14.8 | 23.3 |
| typical, 20 px, one run each (unsplit) | 17.0 | 21.3 |
| 200 areas on an 80 by 80 scene, 40 px (unsplit) | 35.0 | 47.4 |
| 200 areas, 12 px (unsplit) | 83.4 | 121.2 |

- **Why loops.** In the typical scene at 40 px, filled triangle by triangle, the fills alone cost 24 ms over the ground, against 9.5 ms as each band's loops. As one run each, fills and outlines cost 3 to 4 ms. The split does not change a frame's cost, since loops follow the run, not the faces.
- **Per area,** in the prototype at 4x with string keys: a build (mesh, clip, caps, ground, split, edges) of 16 ms (a cylinder) to 41 ms (the sphere) and 75 ms beside a wall and a platform, 9 ms unsplit. A turn's bands take 3 to 12 ms. The lane keys vertices by number in typed arrays, and its bench reports the build.
- **Lazy and sliced.** Only areas whose box meets the view, grown by a screen, are built, nearest the middle first, in slices of at most 6 ms an animation frame: the mesh, clip and caps, then the split and edges bucket by bucket. A turn bands the volumes in view in the same slices. A volume not yet built or banded lies flat. At the cap, about 60 areas fall in view at 12 px, so at the prototype's rates the last stands after about 7 s on the stand-in, the middle within a few frames. A pan's new areas stand a moment after they arrive flat, accepted. A turn's first visit at the cap shows up to about 60 volumes flat for up to about 2 s (3 to 12 ms each, in 6 ms slices) under the same indicator. That is a prototype estimate, pending ISOA-2's turn gate. Each turn's bands, once made, are kept, so a later visit to that turn stands at once.
- **Kept, never per frame:** meshes by the key in 4.4, bands per turn, loops per run. A pan that crosses no 128 px step lays nothing out again. Nothing animates at rest.
- **Gates,** in `TaskDuration` at 4x on scripts/bench-iso.ts, unchanged in kind (`gate`, bench-iso.ts:755-761): every frame at most max(16 ms, 1.75 times Top-down's same frame on the same scene), and a turn at the caps at most 150 ms whole. ISOA-2 adds the rows and measures them integrated: a pan of a typical scene with the four areas above, aiming a sphere (each move, and the frame at rest), a drag of a token with an aura, a turn and a first view at the 200-area cap. The prototype's numbers are estimates from a canvas harness, not that gate.
- **If a gate misses,** the lane tries first far faces as hidden lines with no fill, and shows screenshots of that look before switching to it. Then coarser meshes (`4⌈π√(r·px/2)/4⌉`), then volumes from 20 px a cell. Each is measured before it is claimed.
- **Risks.** Software raster may overstate path work and understate a phone's fill. A dungeon full of columns splits volumes into many runs, toward the worst row.

## 7. UI checklist

- **Words shown:** "Building area shapes" in the shared loading indicator (after about 200 ms) while an area in view waits to stand. No setting (D-261026-28).
- **Loading:** areas stand nearest the middle first, flat until then (6).
- **Keys, focus and touch:** unchanged. The drop line takes no presses. Grips keep their sizes.
- **Screen readers:** unchanged. The Areas panel and "In area" lists read the rules as before.
- **Large interface sizes:** no DOM changes beyond the indicator's words, so no alignment root. Line widths follow Top-down's.
- **FEATURES.md,** Isometric: "Areas stand as their real shapes: a sphere as a sphere, a cone aimed up or down as stored, a cylinder, a cube, a line, an emanation round its creature, each see-through with an outline, down into a pit, so a flier inside one shows inside it, its caught ring round its feet. On ground a player has not wholly revealed, an area lies flat as in Top-down." Areas of effect, Height counts: "In Isometric each area stands as the shape it measures."

## 8. Cases

| Case | Expected | Test |
|---|---|---|
| Every shape, both cylinder anchors, cones and lines level and aimed ±90°, cubes with face offsets, emanations attached, stationary and from a point, random points | `inside` holds exactly when `span` holds the height | aoe unit, property |
| Each shape after wall, scene, ground and band cuts, random clips | closed and wound outward but for ground omissions, every vertex within its chord tolerance of the surface | volume unit, property |
| Every face after the split, radii 1 to 100 cells, every turn | inside one band | volume unit |
| **The owner's case:** random creatures, every size, elevations −30 to 60 ft, round each shape, with walls, platforms and pits, every coverage and inclusion rule, the origin creature left out where `includeOrigin` is false, kept when the body is above the drawn ground under its cells (a pit's floor included) | cells inside the DM's solid through their height: caught. Cells missing it: not caught | volume unit, seeded property |
| A creature at 0 ft under a 10 ft column, in a 5 ft sphere | caught by the rules, no solid over it, hidden by its own cells: outside the promise | volume unit |
| A caster inside its own Spirit Guardians | the solid whole round it, no ring on it | volume unit, iso e2e |
| A 30 ft cone aimed 40° up from a caster, a goblin on the ground under its far half | outside the drawn cone and not caught, though the flat shading covers its square | volume unit, iso e2e |
| A 5 ft sphere at −10 ft over a 20 ft pit, a flier in the pit inside it | the solid inside the opening down to the floor, clipped at the near rim, the flier between its bands | volume unit, buckets unit |
| A 20 ft sphere 10 ft up: a flier inside, one above, one in front outside, one behind outside, at each turn | inside between its far and near bands, the one in front after every band under its art, the one behind before them | buckets unit, iso e2e |
| A Gargantuan, a 6 by 6 custom, a Tiny and a 1.5 by 1.5 custom flier over a 10 ft platform, inside a sphere and just outside it | read as inside and outside by their natural keys, any tint on the platform within each one's raise as the code computes it | buckets unit, iso e2e |
| Two fliers over a platform: A natural 14.142 raised to 16.263, B at 15.556, a band at 15.5 | the band after A and so after B, B tinted, nearer by 0.056, within A's raise of 2.121 | buckets unit |
| A creature carried by a flying mount inside an aura | after its holder, between the aura's bands by its own natural key, its raise taken from its holder chain's keys | buckets unit |
| A volume with no standee in its depth range, then a flier inside it | one run, then two | buckets unit |
| Two overlapping volumes, a volume and a column, ties | bands interleave by key, column, pit, wall, volume, standee | buckets unit |
| A standee inside a volume | no silhouette from its bands | buckets unit |
| Caught rings: a standing flier, a creature lying flat, an area lying flat, Top-down | at the flier's base, on the ground, on the ground, as before | template unit, iso e2e |
| Below 12 px, and below 24 in Low power | every area flat, rings on the ground | iso e2e |
| Aiming a sphere, moving then resting | coarse and whole in the drag layer, then fine in the depth list | areas unit, iso e2e |
| A token with an aura dragged here and elsewhere | bands behind its key before it and the rest after, rebuilt per cell, whole on the overlay for the other device | drag marks unit, iso e2e |
| A door in sight opened and closed, no fog change | the volume rebuilt each time | volume unit |
| 60 areas in view at the cap | the middle stands first, "Building area shapes" while any waits past 200 ms | iso e2e |
| A hex emanation | one prism per hex and layer it catches | volume unit |
| DM-only area | DM: dashed at 60%. Player: nothing | iso e2e |
| **Security:** random scenes, a standing player volume | the rules' polygons inside its plan cut it exactly as the player's standing runs would | volume unit, property |
| **Security:** a player's area with one fogged sub-cell under its plan, including under a column that hides the solid | flat under the fog, the same pixels as before this lane | stand unit, iso e2e screenshot |
| **Security:** two rooms differing only in walls wholly under a player's fog | the same stand decision and volume for that player | volume unit |
| **Security:** the same rooms differing only in heights on cells that player has not seen | the same stand decision and volume | volume unit |
| **Security:** a moving aura entering fog | today's flat clipped mark | stand unit |
| **Security:** a flier partly over fog, standing by `drawsAboveFog`, caught | its ring on the ground under the fog, as Top-down | template unit |
| **Security:** View as a player | the player's fog and stand rule | iso e2e |
| Top-down, any area | pixel for pixel as before | bench parity |

## 9. Security

- **Nothing new is sent.** No op, field or event. The volume is drawn from what the device holds.
- **A player's volume reads only** its template as received (the server withholds DM-only areas and areas on unseen tokens, and drops an unseen caster, shared/project.ts:1139), the walls the client holds, and the drawn ground. Never real heights.
- **It stands only over wholly revealed ground** (ISOA-D4), judged on the wall-clipped plan before the ground cut, else the area lies flat under the fog as Top-down draws it. Moving, it is today's clipped mark. So a player's Isometric never shows an area where Top-down's fog hides it, and a standing volume's wall cuts are walls standing on that player's screen (4.4).
- **Pixels over fog.** A standing volume rises into the air, so on screen it may cover fogged ground behind it, as a standee does. Fogged sub-cells are opaque, so it covers fog and shows nothing under it.
- **Rings** move to a base only for a creature standing by the stand rule itself, never by `drawsAboveFog` alone, and only while the volume stands. Otherwise they stay under the fog with the flat area or creature.
- **Depth order** reads only geometry already drawn. Previews follow the same stand rule, whatever Top-down's overlay shows.

## 10. Lane plan

Order: after the map discovery lanes, HX-3 (IsoBoard.tsx, stand.ts, the hex area code) and the iso walls lane (relief/pieces.ts, runs.ts). ISOA-1, then ISOA-2.

| Lane | Owns | After |
|---|---|---|
| ISOA-1 The solid | `shared/rules/aoe.ts` (`Solid3` and `span`, `ResolvedArea.solid`, the hex stack), new `client/features/areas/volume.ts` (mesh, whole-line clip, caps, ground, band split by bucket, edges, bands, loops, footprint) and their tests. No drawing | HX-3 |
| ISOA-2 The board | `relief/buckets.ts` (volume entries, natural keys, runs, pit clips, silhouettes), `drawRelief.ts` (volume runs), `relief/IsoBoard.tsx` (the slices, stand split, volumes into layout, `DragMarks`' two passes), `relief/stand.ts` (`volumeStands`), `relief/isoTest.ts` (the layout for e2e), `areas/TemplateLayer.tsx` (rings off the ground shapes, the ring slot), `areas/AreaPreviewLayer.tsx`, `canvas/DragMarks.tsx`, `canvas/TokenNode.tsx` (rings at the base), `lib/theme.ts`, `scripts/bench-iso.ts`, `e2e/iso.e2e.ts` (prefix ISOA), then FEATURES.md, docs/dm-guide.md (Areas in Isometric, a screenshot) and the iso design's 5.3 row | ISOA-1, the iso walls lane |

- **Tests:** every unit case above, seeded. **Mutation checks:** `span`'s sign and bounds, the near test's sign, a face banded by its middle without the split, a band keyed at its far end, a run merged across a standee, a band against a raised key, a band after the first rather than the last standee its natural key passes, the closed formula for a Tiny's raise, the pit clip left off a band, the ground at 0 over a pit, the stand rule's every-sub-cell test, the footprint after the ground cut, real heights for the cut, the cache key without the walls version, caps from `span` rather than the cut loops, a ring at the base for a creature standing by `drawsAboveFog` alone, an origin creature counted, the coarse mesh at rest, an aura's bands at or in front of the dragged standee drawn before it.
- **e2e:** iso.e2e.ts (the cases marked), areas.e2e.ts unchanged as the Top-down check, and `reach`.

## 11. As built

Filled by ISOA-2's docs commit, with every place the build went its own way and the bench's rows.

**ISOA-1, the solid** (`shared/rules/aoe.ts`, `client/features/areas/volume.ts`):

- **The build in three steps.** `buildVolume` makes the mesh, clips it and caps it, the one slice that cannot stop part way. `prepare` reads the footprint, finds the ground's planes, and cuts each face by the bucket lines across it, filing each piece by its middle. `ensure` then cuts one bucket by the ground and the bands and links its edges. Both stop at a deadline and carry on at the next call. Each face takes every bucket line across it when it is filed, since a line one face took and its neighbor skipped would part their shared edge differently. So the ground cut (4.2 step 4) runs per bucket, after the filing, as the bands do.
- **No lengthwise steps.** A segment runs the solid's whole length. The bucket, ground and band cuts already split every long face.
- **The footprint** (step 9) is read from the plans of the faces that look up, as a span per row of sub-cells, not from faces' boxes. A face's box beside a diagonal wall would reach past it, and the faces that look up cover a closed solid's plan.
- **Caps.** On a convex shell each cap is one polygon of the shell's own vertices. A hex stack's caps, which need not be convex, are cut into triangles. Where a sliver corner leaves two chain ends a hair apart, the upright edge joins each end to the nearest start.
- **Pinches.** The clip can leave a sliver touching the rest of the mesh along an upright line. The edges there are used twice each way, and each pair links up.
- **Hex ground** is cut by square cells. Hexes have no heights until H3, which will need hex step lines.
- **The center rule off the scene.** On squares the center inclusion rule reads no scene bounds (`Sampler.pointInside`), so a creature whose center lies off the scene can be caught where no solid stands. The promise test skips creatures off the scene. Left as a follow-up.
- **Bench** (`VOLUME_BENCH=1`, this machine with other work running, a slice here standing for the stand-in's 6 ms at a quarter of it): the 100-cell sphere, 63,229 faces, builds its first slice in 1.75 ms (median, 0.87 ms with no other garbage about), about 7 ms on the stand-in, over the 6 ms slice. The emanation's takes 1.30 ms and the cylinder's 0.19 ms. Later slices keep a 1.5 ms deadline but for one unit of work past it: prepare's p99 2.9 ms, a bucket's p99 1.6 to 1.7 ms, the largest unit about 0.8 ms.

## 12. Review dispositions

### Round 1 (astra and Fable)

| Finding | Where it went |
|---|---|
| ISOA-ASTRA-01 | the band split (ISOA-D2, 4.2 steps 5 and 6), face counts for giant areas, the every-turn band case, cost remeasured |
| ISOA-ASTRA-02, ISOAD-F-9 | caps from the cut loops (4.2 step 3), ground omissions and faces on the ground (step 4), ground rims (step 7, 5), the closed case after every cut |
| ISOA-ASTRA-03 | natural keys and the raise's bound (ISOA-D12, 4.3), platform and carried cases |
| ISOA-ASTRA-04 | origin eligibility in the promise (4.1) and the property case, the caster case |
| ISOA-ASTRA-05, ISOAD-F-4, ISOAD-F-13 | D-261026-30: inside pits down to the floor under the pit clip (ISOA-D6, 4.1, 4.3), the pit case |
| ISOAD-F-5, ISOAD-F-1, ISOA-ASTRA-06, ISOAD-F-11 | the plan before the ground cut (ISOA-D4, 4.2 step 9), one clip (ISOA-D5, 4.4), the cache key and door case, equivalence and column security cases |
| ISOAD-F-2 | the bench's matched gate kept, the integrated rows, the first fallback shown before switching (6) |
| ISOAD-F-14 | D-261026-31: rings at the base (ISOA-D11, 4.4, 4.5, 5), the ring cases |
| ISOAD-F-3, F-6, F-7, F-10, F-12 | trap hit areas (4.5), passes round `DRAG_GROUND` (4.5), the loading bound and words (6, 7), the new `area` block (5), `Solid3` (4.1) |
| ISOAD-F-8 | (a) declined: two 16% fills over the background (5). (b) the screenshots' note and D-261026-31 |

### Round 2 (astra and Fable)

| Finding | Where it went |
|---|---|
| ISOA-ASTRA-07, ISOAD-F-15 | the precedence rule (ISOA-D12, 4.3): after the last placed standee whose natural key is at or below the band's, the tint on a column, wall or standee within the raise, astra's two-flier case. Rejected: final keys (the lone Gargantuan flier reads outside) |
| ISOA-ASTRA-08 | the raise as the code's quantity, the closed formula as the whole-cell case, holder chains by their keys (4.3), Tiny and 1.5 by 1.5 in the platform case |
| ISOA-ASTRA-09 | the promise for bodies above the drawn ground under their cells, a pit's floor included (4.1), the property case and a buried case |
| ISOAD-F-16 | a turn's first visit at the cap, a prototype estimate pending ISOA-2's turn gate, bands kept per turn (6) |
