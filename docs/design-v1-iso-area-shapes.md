# raccoon-vtt v1: areas as their real shapes in Isometric

Status: draft 1, for design review. Code is cited from main at `fbced312`. Nothing is built. It builds on the isometric view (docs/design-v1-isometric-view.md, "the iso design" below) and keeps every rule of it that this note does not name.

## 1. The owner's words

The project owner, 2026-10-26: "Also areas should display as their actual shape in isometric (so as an example sphere as a sphere to make it easier to see what flying monsters will get caught in it)".

D-261026-28 sets the direction: in Isometric every area draws as its 3D shape at its real height and aim, translucent with an outline, over the ground shading it draws today, and Top-down stays flat. No switch. The design settles depth order, the fog rule, level of detail and phone cost. Asking the owner is off, so every open choice below is a guess at the owner's likely answer, listed with the options it rejects.

## 2. The answer in short

- **The rules' own solid.** What stands is the shape the rules catch with (`resolveArea`, shared/rules/aoe.ts:552), cut by the walls that clip it, the scene's edges and the drawn ground. A creature whose cells lie inside it through their height is caught, and one whose cells miss it is not, by a property test.
- **A mesh in depth bands.** The solid is a closed, translucent surface mesh. Its faces fall into bands one cell deep along the view, which join the relief's depth list (iso design 5.6), so a flier inside a sphere draws between its far and near faces and reads inside.
- **The stand rule.** For a player a volume stands only where every fog sub-cell under it is revealed, else the area lies flat under the fog exactly as today. A player's volume is cut by the walls that player sees standing.
- **Unchanged:** Top-down, the ground shading, its outline, the caught rings, the name pill, trap areas and the grips. Volumes stand where heights stand (12 px a cell, 24 in Low power).
- **Cost**, from the prototype on the 4x CPU phone stand-in: four large areas add 3 ms to a 40 px pan frame when nothing stands between their bands, and up to 9 ms when every band is split. Building is lazy, in view and sliced.

## 3. Decisions, with rejected options

- **ISOA-D1 One solid, the rules':** the resolved shape, cut by its wall polygons, the scene's edges and the drawn ground (ISOA-D5, D6). Rejected: a look-alike drawn per shape (two geometries that can disagree with who is caught), the covered cells raised as columns (stepped, not "a sphere as a sphere").
- **ISOA-D2 A closed surface mesh, drawn in depth bands:** Rejected: slabs of the volume at constant depth (the prototype's upward cone lost about a third of its fill where the solid is thin along the view), a back half before and a front half after the whole volume (a creature in front of a sphere but inside its depth range reads inside), sorting each standee against each volume (a pairwise order the depth list cannot hold), WebGL (a second renderer for one feature).
- **ISOA-D3 Bands one cell deep, merged into runs:** consecutive bands with nothing between them in the depth list draw as one run, one fill for its far faces and one for its near faces, each the boundary loops of the run's faces. Rejected: half-cell bands (twice the cost for an order finer than the relief's own), a fill per triangle or per band (2 to 4 times the cost, section 6).
- **ISOA-D4 Fog by the stand rule (D-261026-5):** a volume stands only when every fog sub-cell its solid stands over is revealed to the viewer, else lies flat as today. Rejected: cutting the volume at the fog's edge (a capped cut reads as a wall and an open one as a broken shell, prototype screenshots), standing over fog (draws the area over ground Top-down hides).
- **ISOA-D5 A player's walls are the ones standing for that player** (the iso design's run rule, 5.5). The DM's are the rules' walls. Rejected: the rules' walls for everyone (a wall under the fog would cut a volume over revealed ground more finely than Top-down's shaded cells show its shadow), no walls (a volume through a wall makes creatures behind it look caught).
- **ISOA-D6 Cut at the drawn ground, at 0 over a pit:** Rejected: through the ground (the lower half of a sphere shows over the floor), down into pits (a pit clip per band).
- **ISOA-D7 Volumes stand where heights stand (ISO-D12):** from 12 px a cell, 24 in Low power, else flat as today. Rejected: always (the 200-area cap at the fit), a budget of standing volumes (volumes pop up and lie down as a pan crosses it).
- **ISOA-D8 Moving volumes draw whole in the drag layer:** an area being aimed (coarse mesh while the finger moves), an aura whose token is dragged, and other members' previews. An aimed area joins the depth list at rest, when its coverage refines (`samplesNow`, areas/store.ts:132). Rejected: in the depth list while moving (each pointer move redraws the relief), flat while aiming (aiming is when the owner wants to see who is caught).
- **ISOA-D9 Guides:** a sphere's equator and an emanation's middle, a ring at the shape's widest, so the origin's height reads. Rejected: none (a sphere's height does not read), contour rings every 5 ft (clutter on a phone).
- **ISOA-D10 What stays:** grips on the drawn ground, with a dashed line up to a raised origin. The name pill at its Top-down spot by its stand rule (ISO-3). Rejected: grips at the origin's height (a press reads the ground, ISO34-ASTRA-5), the name over the volume's top (its keep-off and stand boxes are Top-down's world boxes).

## 4. The model

### 4.1 The solid

- **`Shape3.span(x, y)`** (aoe.ts) gives the shape's vertical interval over a map point in cells, or null. Every shape is convex, so it is one interval: a sphere `oz ± √(r² − d²)`, a cylinder its two ends inside its circle, a level box its two faces, a cone and an aimed box their linear constraints in z with the cone's quadratic, a rounded box its box's ends grown by `√(D² − d²)`. A property test holds `inside(x, y, z)` to `lo ≤ z ≤ hi`.
- **`ResolvedArea.solid`** names the shape's parameters in cells, so the drawing reads the rules' numbers: `sphere {c, r}`, `cylinder {c, r, z0, z1}`, `cone {apex, a, n, m, L}` (`aimFrame`), `box {c, axes, half}` for cubes and lines level or aimed, `rounded {box, D}` for an emanation (a point emanation is a box of no size), and on hexes `hexStack` (4.6).
- **The clip** is the union of the area's visibility polygons (ISOA-D5), inside the scene's rectangle, above the drawn ground (`drawnGround`, iso design 4.3), at 0 over a pit.
- **What it promises.** A creature above the drawn ground whose cells (the ones the rules read) lie inside the DM's solid through its height is caught under every coverage and inclusion rule, and one whose cells miss it is caught under none. Between, the room's rule grades it, as Top-down's shaded squares do, and the caught ring says which.

### 4.2 The mesh (`client/features/areas/volume.ts`)

1. **Tessellate** the solid, closed and wound outward: around a circle `4⌈π√(r·px)/4⌉` segments, 16 to 64, so a chord strays about a pixel at this zoom, along a length about a cell a step. Rebuilt when the zoom crosses a factor of 2. Coarse (16 around) while it moves.
2. **Clip.** Split every triangle by every whole line of the clip that crosses it: the polygons' edges, the scene's edges, and the cell lines where the drawn ground changes. Neighbors then share each new vertex, which the loops need. Keep the pieces whose middle lies in the clip, then cut each below its cell's ground. Pieces keep their triangle's normal.
3. **Cut faces** along the clip's edge inside the shape, a polygon edge whose far side no other polygon covers: quads from `span`'s low end (raised to the ground) to its high end, wound out of the solid. A cut at the ground gets no face, since the ground or a column side lies there.
4. **Edges,** once per geometry: each edge with the faces beside it.
5. **Per turn,** a face is **near** when its normal meets the camera, `n · (K·s, K·c, ½) > 0`, else **far**, and its band is `⌊depth(middle)⌋`. An edge is a **silhouette** where a near face meets a far one, a **crease** where faces meet at more than 35° (box edges, rims, a cone's base) or a wall cut's rim, and joins the band of its middle with the guides' pieces. Bands, with their view boxes, are kept per turn.
6. **Per run, at layout:** the boundary loops of its near faces and of its far faces, by a walk of the edges with one side in the set, kept by area, turn and band range.
7. **Footprint:** the sub-cells the solid's triangles cover, by their boxes, for the stand rule.

What each shape shows at every turn. The view is a true orthographic one from 30° up (K = √3/2), so a sphere's outline is a circle of its radius.

| Shape | Outline |
|---|---|
| Sphere | the circle, cut where it meets the ground, its equator as a guide |
| Cylinder | the top rim whole, the bottom rim's near half solid and far half dashed, two upright sides |
| Cone | its base rim, an ellipse turned with its aim, and two lines from the apex |
| Cube, line | its visible edges solid and its hidden ones dashed, a line aimed up or down as a long box |
| Emanation | the creature's box grown by its distance, round at the corners, its middle as a guide. On hexes the stack's edges |

### 4.3 Depth

- **Entries.** `ReliefIndex.layout` (relief/buckets.ts:191) takes volumes beside standees: each area's bands, sorted per turn, keyed at the band's middle, merged with the buckets. Ties draw column, pit, wall, volume, standee, then id. Consecutive entries of one area with nothing else between them make one run: far loops filled, near loops filled, then its hidden lines, then its outline. Runs draw in `ReliefRun` like other pieces, so no Konva node is added.
- **Why a flier reads inside.** A standee is an upright at one depth, its footprint's middle. Inside a convex volume the far faces under its art lie deeper and draw before it, and the near faces draw after it: tinted once, with the far outline behind it. A creature in front draws after every face under its art and stays clear. One behind draws before both and takes both tints. The order is right to within one band of the surface, the relief's own tolerance (5.6).
- **Columns and walls** sort with bands the same way, and a volume never draws inside a column, being cut at its top. **Two volumes** interleave band by band, and their low tints blend in either order.
- **Silhouettes** (5.6): a band never gives a standee one, being translucent.
- **Accepted:** within one band of the surface a creature can read a band early or late. A flier whose lift is capped (5.4) draws lower than it is, so it can draw among a tall volume's bands, its badge and dashed stem saying its height. Where a wall cuts a volume, its cut face and the half-height stone wall share a depth, and the face may tint the stone's near side.

### 4.4 What stands and what lies flat

- For a player on a scene with fog, a volume stands only when every fog sub-cell of its footprint (4.2 step 7) is revealed to that player. Otherwise the area lies flat on the ground stage under the fog, as it draws today. The DM's and a fogless scene's volumes always stand.
- Its walls are the runs that stand for that player (`wallPieces`' rule, relief/runs.ts, read whatever the zoom), as a `WallSet` built once per fog change, with visibility polygons cached as coverage caches its own. The DM's are the scene's (`sceneWalls`). View as a player reads the player's, and a table display its own fog, as a player who owns nothing.
- So a player's volume reads its template as received, the walls the player sees standing, the drawn ground under revealed sub-cells, and nothing else. Its rings and name stay on the ground stage and the overlay by today's rules.

### 4.5 Each state

| State | Isometric |
|---|---|
| Placed area | ground shading, outline and caught rings as today. The volume in the depth list, its name pill as ISO-3 stands it |
| Area being aimed (this device) | while the finger moves: a coarse volume, whole in the drag layer, far faces then near faces. At rest: the fine volume joins the depth list, as the coverage refines. The flat shading and range line as today |
| Other members' previews | whole in the drag layer, coarse, fill and dashed outline as Top-down's remote preview. Never in the depth list |
| Selected placed area, Area tool | as an aimed area, its outline 2.5 px. Grips on the drawn ground as today, and a dashed 1 px line from the origin grip up to a raised origin |
| Aura at rest | a placed area. An attached area follows its token's stored spot |
| Aura, token dragged here | `DragMarks` draws its far bands before the moved standees and its near bands after them, so the creature reads inside its own aura. Rebuilt at each cell the drop crosses, coarse. Standees on the relief under it take its whole tint |
| Aura, token dragged elsewhere | whole on the overlay with the other moving marks, coarse |
| Moving aura over fog | the stand rule at each crossing, else today's flat moving mark clipped to revealed sub-cells (5.1) |
| Trap areas | unchanged: shown only with the Trap tool, which shows Top-down (ISO-D9) |
| DM-only area, area on a hidden token | the DM's volume, a DM-only one at 60% with a dashed outline, as Top-down. Players never receive either |
| Below the threshold, Low power | flat as today (ISOA-D7) |

### 4.6 Hex scenes

True shapes stand as on squares. A hex emanation (HX-D11) stands as `hexStack`: each hex its reach covers, from the lowest to the highest layer `withinReach` passes, as one prism, sides only where a neighbor's interval does not cover. So the drawn solid is exactly the hexes and layers it catches. The client passes squares on hex scenes until HX-3 (docs/design-v1-hex-grids.md, As built), and a volume reads whatever `resolveArea` reads, so it follows HX-3 with no change. Hex walls clip by their polygons, and hex heights cut by their drawn ground (H3).

## 5. Look

- **Fill:** the area's color at 16% on far faces and again on near faces. What lies behind a volume takes about 30%, what lies inside it 16%, and what lies in front nothing.
- **Outline:** silhouette, near creases and wall-cut rims 2 px in the area's color at 95%. Hidden creases, both faces far, 1 px dashed 4 4 at 55%. Guides 1 px, near at 80%, far dashed as hidden lines. A wall cut has an outline, so it reads as the wall stopping the area.
- **DM-only** 60% with the outline dashed 6 4. **Selected** outline 2.5 px. **Other members' previews** fill 10%, outline dashed 8 5.
- The ground shading (26%), its outline and the caught rings stay where they are, so the volume's foot and the squares it covers read as today.
- **Against maps.** The outline carries the shape on parchment, light art and the builder's textures. The fill is the area's own color, as Top-down's shading is. Screenshots on a dark map and on parchment.
- **Phones.** Line widths are screen pixels. From 12 to 20 px a cell the outline does most of the work and the fill stays.
- Rejected: faces lit and shaded (a fill per shade per run, seams), a dark halo under the outline (it breaks where runs join, prototype), fills alone or outlines alone (D-261026-28).
- **Screenshots** of the prototype are in the screenshots folder `iso-area-shapes`: a sphere over fliers at turns 0 and 2, a cone aimed up at turns 0 and 1, a cylinder at turns 0 and 3 and an emanation on a creature at turns 0 and 1 on parchment, a sphere cut by a wall beside a platform at turns 0 and 1, a player's sphere in a room under fog, a player's sphere touching fog lying flat, a cube and a line aimed up, and a phone at 40 px a cell.
- Tokens in `theme.ts`: `theme.area.volumeFill`, `volumeLine`, `volumeHidden`, `volumeGuide`.

## 6. Cost

Draw-call medians from a throwaway prototype outside the repository (canvas 2D, headless Chrome, 390 by 844 at 2x, CPU 4x through the DevTools protocol, 30 frames of a pan). The typical scene holds a 20 ft sphere 10 ft up, a 30 ft cone aimed 40° up, a 10 by 40 ft cylinder and a 15 ft emanation, all large on a phone, and 16 tokens. "Without" draws the ground with every area's shading and the standees, standing in for Top-down's frame.

| Frame | Without | With |
|---|---|---|
| typical, 40 px, each volume one run | 15.5 | 18.8 |
| typical, 40 px, each 1-cell band its own run (the worst split) | 15.5 | 24.7 |
| the same with half-cell bands | 15.5 | 30.2 |
| typical, 20 px, one run each | 17.0 | 21.3 |
| 200 areas on an 80 by 80 scene, 40 px | 35.0 | 47.4 |
| 200 areas, 12 px | 83.4 | 121.2 |

- **Why loops.** In the typical scene at 40 px, filled triangle by triangle, the fills alone cost 24 ms over the ground, against 9.5 ms as each band's boundary loops. As one run each, fills and outlines cost 2 to 3 ms.
- **Per area:** a build (mesh, clip, edges) of 1.5 ms (a cube) to 11 ms (the sphere at 40 px), a turn's bands of 0.8 to 4 ms, 200 to 1,100 triangles at 40 px and 430 for the sphere at 12 px. Built eagerly, the 200 areas took 1.1 s and their turn 280 ms, so building is lazy.
- **Lazy and sliced.** Only areas whose box meets the view, grown by a screen, are built, nearest the middle first, at most 6 ms of building in an animation frame. An area not yet built lies flat for those frames. A turn rebuilds the bands of built areas in view.
- **Kept, never per frame:** meshes by the coverage cache key (`coverageCacheKey`, aoe.ts:897), the viewer's walls, the drawn heights object, the zoom octave and coarse or fine. Bands per turn. Loops per run. A pan that crosses no 128 px step lays nothing out again. Nothing animates at rest.
- **Gates,** in `TaskDuration` at 4x on scripts/bench-iso.ts, new rows: a pan of the typical scene with its four areas, aiming a sphere (each move, and the frame at rest), a drag of a token with an aura, at most max(16 ms, 1.75 times Top-down's same frame). A turn at the 200-area cap at most 150 ms whole. The first view at that cap with no frame over 50 ms.
- **If a gate misses,** in order: far faces as hidden lines without a fill, coarser meshes (`4⌈π√(r·px/2)/4⌉`), then volumes from 20 px a cell. Each is measured before it is claimed.
- **Risks.** Software raster may overstate path work and understate a phone's fill. A dungeon full of columns splits volumes into many runs, toward the worst row. The prototype keyed vertices by strings, and the build should be cheaper with typed arrays.

## 7. UI checklist

- **Words shown:** none new. No setting (D-261026-28).
- **Loading:** a volume builds in milliseconds. At the caps an area may show flat for a frame or two, so no indicator.
- **Keys, focus and touch:** unchanged. The drop line takes no presses. Grips keep their sizes.
- **Screen readers:** unchanged. The Areas panel and "In area" lists read the rules as before.
- **Large interface sizes:** no DOM changes, so no alignment root. Line widths follow Top-down's.
- **FEATURES.md,** Isometric: "Areas stand as their real shapes: a sphere as a sphere, a cone aimed up or down as stored, a cylinder, a cube, a line, an emanation round its creature, each see-through with an outline, so a flier inside one shows inside it. On ground a player has not wholly revealed, an area lies flat as in Top-down." Areas of effect, Height counts: "In Isometric each area stands as the shape it measures."

## 8. Cases

| Case | Expected | Test |
|---|---|---|
| Every shape, both cylinder anchors, cones and lines level and aimed ±90°, cubes with face offsets, emanations attached, stationary and from a point, random points | `inside` holds exactly when `span` holds the height | aoe unit, property |
| Each shape's mesh | closed, wound outward, every vertex within its chord tolerance of the surface, its volume within 2% of a sampled one | volume unit |
| **The owner's case:** random creatures, every size, elevations 0 to 60 ft, round each shape, with and without walls, every coverage and inclusion rule | cells inside the DM's solid through their height: caught. Cells missing it: not caught | volume unit, seeded property |
| A 30 ft cone aimed 40° up from a caster, a goblin on the ground under its far half | outside the drawn cone and not caught, though the flat shading covers its square | volume unit, iso e2e |
| A sphere beside a wall stub, a closed room | the solid's height over a point equals `span` there inside the polygons, and nothing past them | volume unit |
| A sphere half sunk, beside a 10 ft platform, over a pit | no vertex below the drawn ground, 0 over the pit | volume unit |
| A 20 ft sphere 10 ft up: a flier inside, one above, one in front outside, one behind outside, at each turn | inside between its far and near bands, the one in front after every band under its art, the one behind before them | buckets unit, iso e2e |
| A volume with no standee in its depth range, then a flier inside it | one run, then two | buckets unit |
| Two overlapping volumes, a volume and a column, ties | bands interleave by key, column, pit, wall, volume, standee | buckets unit |
| A standee inside a volume | no silhouette from its bands | buckets unit |
| Each turn | near and far faces swap as the camera turns | volume unit |
| Below 12 px, and below 24 in Low power | every area flat, as today | iso e2e |
| Aiming a sphere, moving then resting | coarse and whole in the drag layer, then fine in the depth list | areas unit, iso e2e |
| A token with an aura dragged here and elsewhere | its far bands under the moved standee and near over it, rebuilt per cell, whole on the overlay for the other device | drag marks unit, iso e2e |
| A hex emanation | one prism per hex and layer it catches | volume unit |
| DM-only area | DM: dashed at 60%. Player: nothing | iso e2e |
| **Security:** a player's area with one fogged sub-cell under its solid | flat under the fog, the same pixels as before this lane | stand unit, iso e2e screenshot |
| **Security:** two rooms differing only in walls wholly under a player's fog | the same volume, footprint and bands for that player | volume unit |
| **Security:** the same rooms differing only in heights on cells that player has not seen | the same volume, footprint and bands | volume unit |
| **Security:** a moving aura entering fog | today's flat clipped mark | stand unit |
| **Security:** View as a player | the player's walls and stand rule | iso e2e |
| Top-down, any area | pixel for pixel as before | bench parity |

## 9. Security

- **Nothing new is sent.** No op, field or event. The volume is drawn from what the device holds.
- **A player's volume reads only** its template as received (the server withholds DM-only areas and areas on unseen tokens, and drops an unseen caster, shared/project.ts:1139), the walls standing for that player, and the drawn ground. Never the rules' wall set or real heights.
- **It stands only over wholly revealed ground** (ISOA-D4), else the area lies flat under the fog as Top-down draws it. Moving, it is today's clipped mark. So a player's Isometric never shows an area where Top-down's fog hides it.
- **Pixels over fog.** A standing volume rises into the air, so on screen it may cover fogged ground behind it, as a standee does. Fogged sub-cells are opaque, so it covers fog and shows nothing under it.
- **Depth order** reads only geometry already drawn. Previews follow the same stand rule, whatever Top-down's overlay shows.

## 10. Lane plan

Order: after the map discovery lanes, HX-3 (IsoBoard.tsx, stand.ts, the hex area code) and the iso walls lane (relief/pieces.ts, runs.ts). ISOA-1, then ISOA-2.

| Lane | Owns | After |
|---|---|---|
| ISOA-1 The solid | `shared/rules/aoe.ts` (`span` on every `Shape3`, `ResolvedArea.solid`, the hex stack), new `client/features/areas/volume.ts` (mesh, clip, cut faces, edges, bands, loops, footprint, the viewer's `WallSet`) and their tests. No drawing | HX-3 |
| ISOA-2 The board | `relief/buckets.ts` (volume entries, runs, silhouettes), `drawRelief.ts` (volume runs), `relief/IsoBoard.tsx` (the schedule, stand split, volumes into layout), `relief/stand.ts` (`volumeStands`), `relief/isoTest.ts` (the layout for e2e), `areas/TemplateLayer.tsx`, `areas/AreaPreviewLayer.tsx`, `canvas/DragMarks.tsx`, `lib/theme.ts`, `scripts/bench-iso.ts`, `e2e/iso.e2e.ts` (prefix ISOA), then FEATURES.md, docs/dm-guide.md (Areas in Isometric, a screenshot) and the iso design's 5.3 row | ISOA-1, the iso walls lane |

- **Tests:** every unit case above, seeded. **Mutation checks:** `span`'s sign and bounds, the near test's sign, a band keyed at its far end, a run merged across a standee, the rules' walls for a player, the stand rule's every-sub-cell test, real heights for the cut, pits below 0, the coarse mesh at rest, an aura's near bands before the moved standee, the clip by bounding boxes rather than whole lines.
- **e2e:** iso.e2e.ts (the cases marked), areas.e2e.ts unchanged as the Top-down check, and `reach`.

## 11. As built

Filled by ISOA-2's docs commit, with every place the build went its own way and the bench's rows.
