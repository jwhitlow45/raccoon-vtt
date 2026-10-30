# raccoon-vtt v1: raised hexes in Isometric

Status: draft 3, revised for design review rounds 1 and 2. Code references are to main at `de083a47ca084e07dd004068a9401df4bf15bd5b`. Design only. Nothing here is built. This completes the raised-hex work deferred by D-261028-115, and keeps the isometric view and area-shapes designs except where this note says otherwise. The connected-pit correction also fixes the same visible bug on squares in this lane.

## 1. The owner's words

The project owner, 2026-10-26: "Also if possible adding an option for an isometric view of the board would be great wherever that fits in". Asked whether walls and raised terrain will be textured, the answer was yes (D-261026-7).

On automatic walls beside raised terrain: "I would think raised areas wouldn't have walls unless specifically said (unless this interacts in a particular way to block vision) I'll let you resolve this". The square view consequently keeps automatic wall tops level with the lower room, while a wall deliberately drawn stands on the higher ground (D-261026-27).

D-261028-115 deliberately left hex ground flat in Isometric until a build of its own. D-261028-116 to 119 already give hex scenes painted heights, six-way stairs, Erase and areas placed at ground height. This build makes those heights visible. Asking the owner is off. Section 3 records the likely answers to choices their words do not settle.

## 2. The answer in short

- **The same view.** Both Hex rows and Hex columns get raised tops, three visible sides, pits, stairs, explicit walls and creatures at height. No setting.
- **One source of visible ground.** Every renderer and pointer reader uses the scene's grid and this viewer's seen heights. Hex keys are never world x and y.
- **Terrain by center depth.** Sort hex centers in world space, independent of height. Section 6 proves this for both orientations and all four turns, including the app's rounded corners.
- **The square view's standee rules.** A creature follows its actual footprint's lower cells, its higher cells cover it, and a rider follows its holder. Areas keep their natural-depth bands and their stated approximation.
- **Fog stays a raster.** A hex's height is known when any of its fog sub-cells is revealed. Its lifted top copies the fog and sight already drawn there. A wholly unseen hex stays at 0.
- **Client only.** No new map data, op, migration, movement rule or sight rule. A press and a drag need new client geometry because the surface they point at now stands up.
- **Phone gates before completion.** Keep cached buckets, batched tops and the existing scheduler. Measure a fully raised 40 by 40 scene in both orientations, with adversarial heights as well as a terrace.

## 3. Decided, with rejected options

These design guesses are logged as D-261030-460 to D-261030-469. They supersede the flat-ground deferral in D-261028-115. Round 1 also corrects connected-pit compositing on both grids, the handoff from rounded hex hits to rule coordinates, and area ground clipping. The coordinator records the corresponding decision addenda.

- **D-261030-460 Geometry:** reuse canonical `hexCorners` through `cornerAt`, the existing 2:1 projection and four 90 degree turns, for both orientations. Carry the hit cell and move a rule-bound hit toward its center by at most 1/64 cell until `hexAt` agrees, for top and face hits alike. Rejected: a new ideal hex outline (corners would miss walls), six 60 degree turns (a different camera), a square proxy under hex lines, assuming a 1e-6 nudge bridges rounded and ideal boundaries.
- **D-261030-461 Depth:** hex prisms sort by world center depth. Hex wall runs sort with their containing lattice hex, off-scene hosts at 0 included, then by midpoint inside it. Connected pits share a region opening clip, each floor retaining its own polygon and pixels, on hexes and squares. Walls based below 0 share the region clip. Standees and area bands keep section 6's own-cell, holder and natural-key rules and its explicit local errors. Rejected: screen y including lift, offset row plus column, midpoint keys for perimeter walls, one key for a whole wall, clipping a floor only to its own opening at 0, leaving the same square pit bug, claiming exact occlusion for wide billboards.
- **D-261030-462 Footprints:** use the actual occupied hex set, squeezed when the current call's landing rule uses squeezing. Rejected: its rectangular key range (includes hexes the creature does not occupy), its center alone (a Large straddles three hexes).
- **D-261030-463 Stairs:** level hex tops with the existing treads lifted onto them and solid risers between different heights, as squares draw today. No new ramp surface. Rejected: suppressing connected risers (opens a hole), inventing sloped heights or a ramp tool (changes picking and the map contract).
- **D-261030-464 Fog:** any revealed `hexSubcells` member permits that hex's drawn height, while tops retain raster fog and sight. Unseen neighbors count as 0 for faces, picking and bounds. Rejected: square fog tests under hex keys, requiring a whole hex revealed before its height stands, reading hidden neighbor heights to hide faces.
- **D-261030-465 Sides:** keep stair swatches and existing wall textures. Other hex sides use a map tint only on a fully revealed hex, from source pixels wholly inside its polygon, else the neutral side tone. Rejected: bounding-box averages (read neighboring art), new painted hex floors or a new texture picker.
- **D-261030-466 Areas:** cut each area face against the convex polygons of the hexes it meets, merging same-height neighbors and sharing stable edge-plane ids. Before height cuts, assign any boundary-coincident face portion to one owning cell by sampling toward the solid's interior with canonical geometry. Emit and cut it only for that cell. Clip below-ground parts to connected pit regions. Retain the current band width, loading slices, stand rule and caught rings. Rejected: closed clips emitting the same boundary face for both neighbors, extended hex-side line arrangements (quadratic subdivision), raising only the ground while spheres still cut against squares, changing the area rules, a new 3D renderer.
- **D-261030-467 Cost:** keep 12 px per cell, 24 in Low power, and the existing matched `TaskDuration` gates. Heights do not disappear by a count or pan-time budget. Rejected: always drawing prisms at fit, dropping random cells, claiming phone timings from face counts.
- **D-261030-468 Contract:** all changes stay in client drawing, input, tests, benchmarks and docs. Explicit scene grid replaces inference from height-bearing chunks. Rejected: an op or snapshot version, changing server sight edges to match a view, storing a second elevation.
- **D-261030-469 Delivery and UI:** one implementation lane owns the coupled ground, input and volume changes, then its acceptance and docs commit. Reuse View and existing controls and loading words. Rejected: concurrent edits to the same board and height APIs, an extra relief switch, a new product question.

## 4. Today, in the code

### 4.1 Squares

- **Projection and height.** `client/lib/view.ts:73` projects `(x,y,z)` to `(c*x-s*y, (s*x+c*y)/2-K*z)`, K = √3/2. `drawnGround` at line 197 reads `seenGround`, or 0 while heights lie flat. `drawnBase` at line 230 keeps a token's elevation above its seen ground when the relief lies flat.
- **The source canvas.** `client/canvas/relief/IsoBoard.tsx:535` mounts a non-listening ground Stage. Lines 553 to 561 draw map, grid, board layers, flat creatures, sight, fog and still marks in that order. The relief copies this canvas, including its masks, rather than reconstructing the art per height.
- **Tops and sides.** `relief/pieces.ts:189` enumerates square cells, their four neighbor heights and stair marks. `facesOf` at line 92 emits near sides above 0 and far sides inside pits. `drawRelief.ts:105` clips and copies lifted tops. Line 231 groups consecutive equal-height tops between ordering barriers into one copy.
- **Pits.** `drawRelief.ts:157` clips the lowered floor and far sides to the opening at 0. `buckets.ts:352` gathers a standee's pit openings, and `IsoBoard.tsx:419` passes them to its drawing. Areas have a separate pit list (`volumes.ts:93`). Every one is square today.
- **Depth.** `pieces.ts:167` rounds world depth to 1e-9 cells. Lines 172 to 174 use cell centers and wall midpoints. `buckets.ts:228` merges bucket lists. Lines 352 to 394 raise a standee's key to its own lower cells and holder chain, then redraw earlier higher own cells over it. This is an approximate billboard order, as the original design 5.6 states.
- **Cliffs and stairs.** `shared/rules/walls.ts:686` derives raised sight edges and marks a stair connection separately from a ledge. The relief never turns those derived raised edges into extra walls (`runs.ts:59` reads walls and free walls). `builder/heights/relief.ts:118` omits a connected stair's top-down rim. Isometric still draws a vertical riser (`pieces.ts:92`), and copies the treads with the top. The original design's promise to omit connected faces was not built.
- **Walls on heights.** `runs.ts:57` splits free-wall crossings and quarter-cell fog runs. `pieces.ts:229` stands explicit walls half a cell above the higher adjacent ground, free walls on their containing cell. Automatic walls have a fixed top above the lower room, so a tall bank replaces them rather than carrying another wall. Doors use wood, walls stone, windows a pane (`drawRelief.ts:214`).
- **Tokens and labels.** `IsoBoard.tsx:229` builds standees from their base and footprint. Its overlay at line 615 draws upright map labels. Labels and decor stay readable above terrain, as they do on squares. They are not opaque physical faces in the depth list.
- **Areas.** `areas/volume.ts:2513` cuts meshes on square step lines and level planes. `onOrBelow` at line 402 samples by floored world coordinates. `relief/buckets.ts:271` merges the one-cell depth bands against standees' natural keys, even after own cells raise their placed keys. `relief/volumes.ts:28` carries this viewer's heights, fog and live-ground test.
- **Fog and sight.** `relief/fogView.ts:98` reads raster sub-cells and fails closed on absent or invalid tiles. `relief/stand.ts` applies the existing creature and volume stand rules. The source canvas includes `SightOverlay` before fog, so copied tops retain both. Contrary to the initial iso design 5.5, side faces currently do not sample sight darkness (its As built, ISO-2). This lane keeps that cosmetic behavior on both grids, and adds no hidden-data read to imitate it.

### 4.2 The hex flat path

`client/lib/view.ts:208` infers hexes from `heightsGrid`. `drawnGround` (197), `seenFootprintGround` (213) and `drawnHeights` (258) then return 0. `pickWalk` (309) returns the inverse point at 0 whenever `isHex(src.grid)`. Hence a raised hex has no prism and its standee uses its stored elevation over a flat map.

`IsoBoard.tsx:171` knows `sceneGrid(scene)`, but line 175 leaves it out of `DrawnSource`. Lines 234 and 398 give the height helpers `occupiedRange`, a world-raster bounding range on hexes (`shared/rules/footprint.ts:151`), and line 472 floors world coordinates for ground anchors. That range is neither the occupied hex set nor its key bounds. `boardPick.ts:61`, `isoDrag.ts:145` and the volume ground cut make the same square assumptions. Removing only `flatOnHexes` would draw square columns from hex keys and place several readers on the wrong hex.

Hex geometry and masking already exist: `shared/rules/hex.ts:167` centers, 184 neighbors, 219 canonical rounded corners, 301 footprints, 348 scene membership, 369 key extents and 384 fog sub-cells. `seenChunks.ts:38` already masks a hex height by those sub-cells (D-261028-115). `builder/heights/ground.ts:41` reads a seen height correctly when passed the scene grid.

## 5. The hex prism

### 5.1 A client ground adapter

Add `client/lib/groundCells.ts`, pure client geometry over the existing shared helpers. It has no Konva or store dependency. Keep cell-key arguments separate from world-point arguments in names and types:

```ts
type GroundCell = { col: number; row: number };
// Contract sketch. Heights remain in cells here, feet in stored data.
type GroundSurface = {
  grid: Grid;
  atCell(cell: GroundCell): number;
  atPoint(point: Point): number;
  cellsIn(box: WorldRect): Iterable<GroundCell>;
  polygon(cell: GroundCell): readonly Point[];
};
```

`DrawnSource.grid` is explicit at every production construction. `DrawnHeights` carries the surface and its seen extrema. Keep squares on their existing arithmetic. Hex enumeration uses `sceneHexSpan` and `hexInScene`, never `row < bounds.h`. Token helpers take an occupied cell iterable, from `occupiedHexes` on hexes and the existing square helpers, instead of guessing it from `CellRange`. A rectangle query enumerates the hex polygons it actually intersects, including border touches where the existing query includes them.

Use `hexAt` as the candidate for a world point, then test its canonical polygon and the six neighbors if rounding puts the point across an edge. This is a rendering lookup only. Rules retain their existing `hexAt` answers. Ties use the existing orientation's row/column order. Clip polygons at scene bounds, and return 0 in the unused perimeter between the last complete hexes and the scene rectangle.

The same polygons serve top copying, side endpoints, world-point ground, pit clips, wall splits, volume cuts and picking. Canonical corner names ensure shared endpoints are identical. Do not recreate corners from centers or use the square bounding box as the surface.

### 5.2 Tops, faces and cliffs

For a hex h, `P = hexCorners(grid,h).map(cornerAt)`. Project all six vertices at its drawn height z. Hex columns are the shared helper's x/y mirror of hex rows, not a separately wound polygon. Determine winding or use neighbor vectors when finding outward normals.

Facing d in `hexNeighbors` corresponds to edge vertices `(d+1)%6` and `(d+2)%6` (`shared/rules/walls.ts:798`). Let n be its outward normal and D = `(s,c)`. The edge faces the viewer when `n·D > 0`. At these four camera turns exactly three edges face the viewer on either orientation. Heights never enter that test.

- **Raised cell z > 0:** for each near edge with neighbor height a < z, draw the quad between `max(0,a)` and z. Then copy the source ground inside the six-sided top, shifted up K*z. Equal-height neighbors have no internal side. Missing, out-of-scene or unseen neighbors have drawn height 0.
- **Pit z < 0:** form connected regions of side-adjacent cells whose drawn heights are below 0. Clip each region's below-rim terrain to the union of its openings at 0. In center order draw each pit's floor clipped to its own projected floor polygon at z, then its far faces from z to `min(0,a)` where positive in extent. The corresponding raised neighbor supplies the part above 0. A floor can show through a neighboring opening, but keeps its own source pixels. Size its copy's source box from the projected floor polygon and the copy's inverse height translation, not the opening's box at 0. Apply the same region, floor-copy and depth-order fix to square pits in this lane.
- **No duplicate cliff wall:** keep the shared raised sight/ledge segments for rules and the Top-down line, but only the prism's exposed face stands in relief. An explicit wall can stand on it. Hex scenes continue to have no automatic walls.
- **Bounds:** project every polygon vertex at every height the piece draws. Bucket bounds include the resulting faces, wall rise and visible floor bounds after the region clip. A pit floor may reach another cell's opening, so its own opening alone cannot bound or cull it.
- **Copies:** consecutive tops at one height may share a clip and source copy only within their existing uninterrupted terrain run. Never batch a top past a wall, standee or volume band that belongs between them.

After copying a pit floor, fill `pitShade` only inside that floor's own projected polygon at its depth, under the region opening clip. Never fill an opening at 0 or the whole region with each pit's shade. A neighbor's floor seen through an opening keeps that floor's own shade, with no extra darkening from the opening's owner. Apply this to square and hex floors. The color oracle checks uniform equal-depth shading across connected openings as well as the source colors.

Keep the existing face lighting and edge widths. Hexes have no painted terrain texture because painted ground stays square. Stair-marked sides use the existing stair swatch. Walls and doors retain their textures. For a map tint, read the same decoded image Top-down draws, 1:1, and include a source pixel only if its whole pixel square lies inside the hex and every raster sub-cell that pixel touches is revealed. Cache by image, map rectangle, grid and cell. A partly revealed hex stays neutral. A missing or unreadable image stays neutral too.

Walls whose base is below 0, standees in pits and an area's sub-zero parts reference the same connected region, not just the openings directly under their footprint. Their upright clips keep the existing upward sweep from the region opening so content above the rim is not cut away. Floor and far-face paint still takes the region's opening union at 0. Build regions only from drawn ground. Unseen negative heights cannot join a region or change any player's clip. Cache region membership and clip paths until drawn heights or the viewer's masks change, including neighboring buckets when an edit joins or divides a region.

### 5.3 Stairs and ramps

The map stores one height per hex and a stair mark, not a slope. Retain that surface. Copy the existing five tread marks and chevron to the hex top at its stored height. Its resolved facing comes from `WallSet.stairAt`, including held directions on a player's map. Auto and all six explicit facings keep their present meaning (D-261028-117).

Between stair-connected different heights the solid vertical interval remains, just as the square view's riser remains. It shows the height difference, while the treads say the step is traversable. Do not cut a hole to suppress a cliff and do not stretch a tread into a traversable ramp. No ramp tool, slope interpolation, collision mesh or continuous landing height is added. An unresolved Auto stair has its existing undirected marks, never a guessed direction from hidden neighbors.

### 5.4 Fog, per-player sight and remembered ground

For a player, a hex's seen height is available when any `hexSubcells(grid,h)` member is revealed in that viewer's merged fog. A fully fogged hex is 0 in the surface, extrema, neighbors, side decisions, picking, fit and drag preview. This keeps D-261028-115's cell-level height disclosure. It does not require a whole hex seen to stand its terrain.

The top copies its source fog and sight pixels at each raster sub-cell, so revealing one quarter-cell never copies the rest of the map without its mask. The prism outline and neutral sides may reveal that known hex's full height, the same cell-level reach the square view permits. They reveal no hidden neighbor's height or map color. A side is not a new row of revealed floor sub-cells.

Creatures and upright labels keep their stricter stand rule. Areas require every sub-cell under their pre-ground-cut plan revealed and live now. Remembered ground alone cannot stand an area (`areas/liveGround.ts:17`). A fog or sight change invalidates a pending volume's permission before its next draw. View as a player and the table display use their own projection, fog and sight, never the DM's.

## 6. Depth order, and what it proves

### 6.1 Keys

For turn q, D = `(s,c)` from `turnAxes(q)`. Define `k(p) = round(1e9 * (s*p.x+c*p.y))/1e9`, ascending, far to near. Height is absent. A static entry's tuple is `(k, rank, localDepth, stableId)`, with column, pit, wall, volume, standee ranks in that order. Existing square keys and ordering stay unchanged.

- **Hex column or pit:** k at `hexCenter`, localDepth 0. A raised cell draws its faces then top. A pit draws its own floor then far faces, under its connected-region opening clip.
- **Wall:** split at crossings, raster quarter-cell boundaries and every canonical hex side crossed, including off-scene lattice sides. Coalesce only contiguous allowed runs in one host hex, never across fog gaps or crossings. k is the host center's key, localDepth is the run midpoint's depth. On a shared side use the nearer host at this turn, with base the higher drawn ground beside it. Store both support cells and give the piece one stable owner bucket by the orientation's row/column tie order. A turn changes its cached key, not that owner. A wall inside a hex uses that hex's ground. Host a perimeter run in the off-scene lattice hex given by `hexAt`, checked against its canonical polygon as in section 5.1, and treat that host as a flat prism at 0. The base changes along a long wall exactly at its hex crossings. A base below 0 takes its connected-pit region clip.
- **Standee:** natural key N at the stored box center. Placed key P is `max(N, all occupied-cell keys with drawn height <= base, holder-chain placed keys)`. At equal placed keys, holder-chain depth precedes id. Keep the current redraw of earlier own cells above the base, and the pit opening clips. Use the actual footprint hex set, never a rectangular key range.
- **Area band:** keep the existing one-world-cell band key. Insert it after the last placed standee with natural key strictly less than the band key. Ties put the band first. Keep the original area's precedence rule, not a comparison against P. Hex terrain and wall host keys replace square terrain keys in the static merge.
- **Labels:** map text and token decor remain the existing overlay, anchored at their drawn surface or standee. They intentionally read over foreground relief. Flat labels stay in the copied ground and split across its heights. This lane adds no label sort pretending text is a solid wall.

Reparent local drags to the existing drag layer, and restore every node at its new sorted place on drop or cancel. Remote ghosts and moving auras keep their current drag-layer ordering. They do not force a terrain sort every pointer frame.

### 6.2 Why terrain center depth works

Fix screen horizontal coordinate u. The inverse projection at successive heights traces a straight ground line parallel to D. A prism can cover that screen ray only where its plan hex intersects that line. At fixed u and v, increasing z increases ground depth by 2*K*z, so the nearer surface is the later interval along D.

For ideal hexes a shared side is the perpendicular bisector between centers A and B. Crossing it toward D implies `D·(B-A)>0`, so center depth strictly increases at each crossed side. Therefore ordering the prisms by center depth orders their ray intervals, for any pattern of heights. A very tall far hex can hide a shorter near one, but cannot change which ray interval is nearer where both have a surface.

The app rounds corners to 1/64, so the ideal-hex proof alone is insufficient. On rows a vertical side retains an east/west normal. On each slanted side the horizontal run is 0.5 and the vertical run is less than 0.5 after rounding. Thus its normal's larger component keeps the same sign under every D = `(±r,±r)` as the ideal side's normal. Columns mirror the argument. Every actual side crossing still increases center depth. A ray through a vertex uses the canonical tie rule, and a shared boundary has zero interior area.

Walls contained in one hex occupy that same ray interval. Ordering them with the host's center prevents a midpoint from putting a far wall in front of a nearer prism. This includes the off-scene lattice hosts at 0 around the last complete scene hexes. Their base is at least the touched supporting top, so a wall following its own top cannot paint over the top's interior. The nearer-host rule handles a wall exactly on a shared side. Splitting is required. A whole wall spanning several hexes has no single supporting interval or base. The proof does not justify clipping a pit floor to its own opening at 0: the projected floor can fall inside another opening, which section 5.2's region compositing preserves.

### 6.3 Cases that defeat a naive sort

| Naive choice | Failure | Rule that resolves it |
|---|---|---|
| Offset `col + row` | Hex rows (1,0) and (0,1) tie although their world depths at turn 0 differ | `hexCenter` before k. Columns mirror it |
| Projected screen y | Raising the near hex sorts it behind a far hex while its side still covers it | k excludes z |
| Only a creature's center | A Large on three platform hexes draws before its nearer supporting top, cutting its ring | P follows every lower occupied hex |
| Every footprint cell before the token | A creature buried in one of its hexes draws on top of the higher ground | Higher own cells redraw over it |
| Rectangular footprint | A high hex outside the Large's triangle lifts its order and base | Enumerate only occupied hexes |
| Wall midpoint among terrain centers | A run at a far hex's near corner can pass the next terrain center | Wall k is its split run's host center |
| Midpoint for an unused-perimeter wall | On rows at turn 0, a run at `(3.54,8.6959375)` has midpoint key `8.6521143804`, before raised hex `(3,9)` at `8.7480273365`, though it lies outside that hex's near side | Use its off-scene lattice host center at ground 0 |
| One key and base for a long wall | A run across a terrace floats over its low hexes or cuts through its high ones | Split at hex sides, base per run |
| Area bands against P | A Large or Gargantuan flier raised by its footprint can read outside a sphere it is inside | Bands compare with N and the existing precedence rule |

### 6.4 Accepted approximation, not an exact 3D claim

The proof covers opaque terrain and its supporting walls against other hex terrain. A standee is a billboard, not the hex footprint extruded into a creature. Its wide art can meet an unrelated hex at another depth. Keep the square view's local error: natural-center sorting away from its own cells, own-cell and holder precedence, silhouettes and tap again. During an unsnapped drag, the preview remains on the drag layer above the relief.

Two crossing walls are split first. Within one host hex their midpoint order can be wrong near a meeting point, over no more than that hex's depth span and the half-cell wall rise. Center-host wall keys can shift a wall against a standee or area band by at most the host polygon's depth radius, less than 0.57 cells at these turns. They do not promise exact wall/billboard intersections.

Area meshes retain their one-cell band approximation. A band's late tint caused by standee placement is bounded by the actual `P-N` computed from the occupied hexes and holder chain, plus the existing band width. Do not reuse the square whole-box raise formula on hexes. Measure that raise in tests. Transparency order between areas stays the original design's accepted low-tint blend.

## 7. Input and unchanged rules

`pickWalk` gains a hex branch above the standing threshold. Trace `toWorld(v,z)` from seen high to seen low, including 0. Intersect the ray with canonical hex sides, visiting only positive-length intervals. The first interval entered at or below its surface returns its near-side hit. A height between entry and exit returns its top hit. Return the hit `GroundCell` with the point and z. Advance all simultaneous vertex exits together. Handle the scene perimeter at 0. Do not use `hexLine` as a ray traversal: it interpolates between cell centers and can miss a short interval crossed by this arbitrary ray.

Carry that cell through `boardPick` and empty-map taps so cell-based UI uses the canonical hit, not another `hexAt` guess. Before any hit point enters rule-bound placement or another consumer that reclassifies it, move it toward the hit hex's center only as far as needed for `hexAt` to agree, with at most 1/64 cell of displacement. Apply this to top hits in rounded-edge slivers as well as face hits. Keep the geometric point for screen geometry. Use the reconciled point consistently at the rule boundary. No hex pick may claim that a 1e-6 nudge establishes identity. Squares keep their existing nudge.

The walk must terminate by monotonically advancing its ray parameter, not by the square `w+h` cap. Bound work by the finite crossed hexes in the scene, plus perimeter intervals, and test the full supported height range at 1 and 5 ft per cell. A direct ray/polygon oracle verifies top, face, pit and vertex cases independently.

`boardPick`, `isoDrag`, labels, pins, door taps and pills, ground-piece drawing previews, flashes, flat-creature press fragments, camera fits and display fits must read the same surface. Replace world `floor` lookups, square range loops and square pit clips wherever they consume drawn relief. A ground-piece preview clips to each intersected hex polygon and, for players, its revealed raster sub-cells before lifting. Keep the existing slops in screen pixels.

The drag still scans distinct seen heights for its snapped footprint's highest drawn ground. Snapping, a kept seat, stepping off a holder, flying, a buried token, capped stems and cancellation keep their current branches. The highest query over an all-pit footprint starts at minus infinity, not 0. Current full-footprint versus squeezed landing choices stay those of `dropLanding`, not a new visual rule.

**What stays the same, with evidence:**

- Positions stay world coordinates with the box center as anchor (`shared/rules/hex.ts:263`, `shared/model.ts:898`). No token moves when the view switches. Four quarter turns and hex arrow stepping stay as today.
- Heights and stairs are already chunk data with a grid stamp (`shared/model.ts:652`, heights at 671, stairs at 678, grid at 692). `groundAt` and `WallSet.stairAt` already read hex keys. No persistence or version change.
- Sight already derives canonical raised hex edges (`shared/rules/walls.ts:770`, 798 and 908), and filters them against eye height (1324). A stair connection affects movement while its raised side can still block sight. Rendering does not change either fact, nor make a half-cell drawn wall the rules' wall height.
- Movement, ledges, routes, distances, area membership and elevation landings keep the shared rules and existing ops. Their client preview now has to point at the visible surface. That input correction is necessary client work, not a changed game rule.
- Server projections, remembered pieces and per-player withholding stay unchanged (`shared/project.ts:141`, `shared/rules/held.ts`, `areas/liveGround.ts:17`). The renderer reads only this device's supplied pieces and masks. No server or shared production file needs editing.

## 8. Areas and their ground cut

Every solid, including a hex emanation stack, keeps the rules' existing mesh and wall clip. Replace only its ground adapter: intersect each area face's plan with the convex polygons of the hexes it meets, then cut each resulting piece by that hex's height plane and sample `atPoint` inside it. Merge same-height neighboring pieces along their shared edges without treating a nonconvex merged region as one convex hex. Include the unused scene perimeter at height 0. Shared cuts use stable edge/plane ids and the same order so adjacent faces share vertices. Preserve faces with degenerate or vertical plans by clipping their original 3D polygon against the hex's vertical edge half-planes.

**Own a coincident boundary before cutting by height.** A vertical face exactly on a shared hex edge survives both neighbors' closed polygon clips. Split at canonical edge endpoints if necessary, then assign each coincident face portion to exactly one cell. Sample its interior point toward the solid's interior, opposite the face's outward normal, as `readPoint` does (`volume.ts:395`). Classify that sample against canonical ground polygons, not ideal `hexAt` boundaries. This is a sampling offset only. Do not move mesh vertices. Emit the portion only for its owner and apply only that owner's height cut before merging or banding. A post-cut `onOrBelow` test cannot remove overlapping pieces that both extend above ground.

For the reproduced rows case, the face along the edge between `(3,3)` at height 2 and `(4,3)` at 0 spans z 0 to 3 and has its solid interior in `(3,3)`. That cell alone owns the face. Emit z 2 to 3 once, and no part below 2. Equal neighbor heights still require unique ownership, since duplicate transparent faces would darken the same surface. Hex emanations need this routinely: their shell faces lie on canonical edges (`volume.ts:682`).

**Squares already own these faces.** The square path partitions each face once by the global ground planes. `splitPoly` (`volume.ts:267`, all-on-plane return at 292) returns a coincident polygon once, rather than intersecting it independently with both closed cells. After height-plane cuts, `onOrBelow` (`volume.ts:402`, sampling at 413) offsets the centroid opposite its outward normal before flooring to the square cell. Thus a boundary face reads the solid-interior cell's ground. Preserve this behavior and add square regressions alongside the new hex cases. No additional square area-face ownership fix is required by this finding.

Do not extend every encountered hex-side line across the whole original face. On a 9 by 9 rows region, the reviewers reproduced 215 distinct extended lines and 7,299 intersections inside a face. Yielding controls frame work, not that quadratic geometry or the time until it stands. Index the cells met by each face and use bounded polygon intersections, keeping output proportional to local face/cell intersections, then merge same-height neighbors. Charge enumeration, intersection, merging and every height cut to the generator budget. Ground rims and omissions follow the actual hex top or side, never a square staircase through it.

`pitsUnder`, `VolumePiece.pits`, the token's pit clips and `drawVolume` carry connected-region references with polygons or grid-tagged cell keys. An area's sub-zero portion uses the region clip from section 5.2 down to the drawn floor. Replace `ground(floor(x),floor(y))` in face, guide and coarse-volume clipping. Keep volume buckets in world 16 by 16 coordinates. They need not share the terrain's hex-key chunk indices. Merge both streams by depth, not by equal bucket names.

Coverage and caught rings remain the rules' answers. The volume's stand footprint is still taken before cutting by ground, including fog hidden behind a column. New grid and surface identities belong in the volume cache key. Door, height, fog and live-sight changes still invalidate it. On a surface change, lay the old volume flat until the replacement is ready. This tightens the old-volume retention in the area design's As built: a still-permitted old mesh can otherwise rise through the newly drawn platform. Fog-only retention still requires the existing permission test every time.

## 9. Phone cost and redraws

The budget fixture is a scene with world bounds 40 by 40, 5 ft per cell. Each orientation contains 1,778 complete hexes, not 1,600 square keys (`sceneHexes`). A literal 40 by 40 key rectangle is a different fixture. Include a flat-topped terrace, alternating high/low hexes that expose sides, mixed pits, and a seeded map spanning the supported height range. Put a wall across several levels, 40 creatures of mixed sizes and the existing four representative areas on it.

Before culling, raised terrain has at most 1,778 tops and 5,334 near side candidates, 7,112 surface operations before batching. Pit fixtures instead have up to three far side candidates per pit. Wall runs, fog, outlines, areas and tokens cost extra. These are counts, not measured milliseconds. A 390 by 844 phone at 40 px sees a subset, and full projected bucket bounds must still catch offscreen anchors whose tall faces enter view.

Keep the square renderer's cache and redraw rules (`buckets.ts:143`, `scheduler.ts:22`, `IsoBoard.tsx:147`):

- Terrain buckets remain 16 by 16 cell keys. Derive their world boxes from their hex polygons. A 40 by 40 scene needs a 3 by 3 key-chunk grid in either orientation. Free walls retain world storage chunks, but relief runs are indexed under their host hex's terrain bucket, using the stable owner above for a shared side. Keep sparse buckets for off-scene lattice hosts touched by perimeter walls. Their surface is 0 and their runs join the same depth merge.
- A bucket depends on its own and six-neighbor cell data, including diagonal chunk neighbors, and every world fog tile touched by those polygons. Never look up fog under the same numeric chunk index as a hex bucket. Cache grid, bounds, feet per cell, stand threshold, map identity and looks too.
- Keep polygons, face intervals, turn keys, bounds and side tints until those inputs change. Turns build only the needed turn data. Repeated turns reuse it. Index world-to-key queries and changed tile dependencies, so a pan never rebuilds heights or tints.
- The ground and relief draw at most once each per requested frame, ground first. The ground redraws for camera, map, build, masks or still marks. A local drag, remote ghost or ping redraws its existing moving layer, not terrain. Nothing animates at rest or rebuilds the hidden drawing tree.
- Keep 128 px cull and lift-margin steps and the canvas-height lift cap. Keep hidden stages at 0 by 0. Areas keep one shared 6 ms build slice and their existing relayout cadence. No new synchronous all-scene ground cut on every pointer move.

Extend `scripts/bench-iso.ts` for both orientations on Chrome at 4x CPU, 390 by 844, device pixel ratio 2. Alternate Top-down and Isometric runs under the same load. Test fit, 11/12 px, 23/24 px in Low power and 40 px, each turn, pan, first/repeated turn, local/remote drag, mount/group drag, aura, fog change and hidden-tree builder edits. Add a 40 ft cube on alternating hex heights, timing all ground-cut build frames and time to stand, with face/cell intersections and resulting mesh size. Include a large connected depression and a region join/split across buckets. Record rebuild and draw counters beside `TaskDuration`, plus time until areas stand.

The gate is each established frame metric at most `max(16 ms, 1.75 * matched Top-down)`, and a warm turn at most 150 ms whole. Area-building frames must be reported individually, not averaged with idle frames. Old area-cap exceptions do not automatically excuse a regression on this fixture. First optimize clips, runs and cache misses if a row fails. Do not silently raise the standing threshold. Report the miss for review. No integrated timing or real-phone performance is claimed by this design.

## 10. The parts, checks and docs

### 10.1 One implementation lane

HXREL-1 owns the whole change. Land coherent steps in this order, with tests beside each. This avoids concurrent ownership of `view.ts`, the board, the depth index and their height contracts.

| Part | Owned production files and reason |
|---|---|
| Surface and picking | New `client/lib/groundCells.ts`, `client/lib/view.ts`, `client/canvas/boardPick.ts`, `isoDrag.ts`, `isoPlace.ts`, `client/features/display/logic.ts`: explicit grid, hex footprint and world queries, ray walk, ground fragments and visible fits |
| Relief and order | `client/canvas/relief/pieces.ts`, `buckets.ts`, `runs.ts`, `drawRelief.ts`, `looks.ts`, `renderCache.ts`, `context.ts`, `IsoBoard.tsx`, `standee.ts`, `stand.ts`: six-sided cells, host wall keys, actual own cells, masks, copies, connected-pit clips and the square pit correction |
| Tokens and input consumers | `client/canvas/TokenNode.tsx`, `DragMarks.tsx`, `Stage.tsx`, `emptyTap.ts`, `client/features/doors/tap.ts`, `DoorPill.tsx`, `client/features/builder/labelShape.ts`, `labelTap.ts`, `client/features/builder/heights/tap.ts`, `ReadoutHost.tsx`, `client/features/pins/PinTool.tsx`, `client/features/pings/PingController.ts`, `client/features/areas/AreaTool.tsx`: polygon pit clips, canonical hit-cell handoff, rule-bound points, drawn ground and wall bases. Audit callers across drawings, labels and flashes. Mechanical signature changes stay in this lane |
| Areas | `client/features/areas/volume.ts`, `volumeTesting.ts`, `client/canvas/relief/volumes.ts`: bounded face/hex polygon intersections, point samples and connected pit regions. Shared coverage and sight are read-only |
| Acceptance | Corresponding unit files, `e2e/iso.e2e.ts` with HXREL step prefix, `scripts/bench-iso.ts` and its tests, alignment roots only if a changed control needs one |
| Final docs commit | `FEATURES.md`, `docs/dm-guide.md`, this note's As built. Update outdated flat-hex assertions in the iso and area design notes and mark the hex design's deferral complete |

The exact mechanical caller list comes from the typecheck and a search for all drawn-ground, square pit and `floor` consumers, not an expansion into unrelated features. No shared or server production edits are authorized by this design. A necessity discovered there must be documented before changing this client-only contract.

### 10.2 UI checklist

- **Words shown:** existing "View", "Top-down", "Isometric", "Turn left", "Turn right", height/stair readouts and forced Top-down tool lines. No new control, tooltip or setting. Retain the existing "Loading the isometric view" and "Building area shapes" loading messages.
- **Loading and errors:** reuse the delayed shared indicator for first mount and sliced area work. A failed image tint falls back to neutral without blocking play. A fog change removes permission immediately, even while geometry is pending.
- **Keys, touch and focus:** I, Q, E, tap again, 44 px targets and existing focus return. Builder, Fog, Line up grid and Trap still show Top-down while used. No hover-only interaction.
- **Screen readers:** existing view-change announcements and accessible height/stair readouts. Canvas relief adds no redundant focus target. The readout must name the picked hex's height, not an adjacent square.
- **Large interface sizes and alignment:** no intended DOM layout change. Verify any control or anchor changed by the build with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, maximum 1 px. Check View, height readout, door pill and loading placement. Confirm coverage in `e2e/alignmentRoom.ts`, adding a root if absent. Do not call a canvas-only pixel check an alignment sweep.

### 10.3 Cases

| Case | Expected | Test |
|---|---|---|
| Both orientations, every turn, adjacent and diagonal height changes, equal plateaus | Exactly the exposed sides and continuous hex tops, no internal seam or extra wall | ground/face units, pixel e2e |
| Offset-key tie and tall near hex before a low far hex | Center-depth order independent of height and enumeration order | depth units |
| Large, Huge, Gargantuan and squeezed footprints on mixed heights | Only occupied cells affect base/order, ring on supports, higher own ground covers buried art | footprint/depth units, pixel e2e |
| A rider, a buried token, a flier inside a sphere and two fliers with reversed placed/natural keys | Holder first, own-cell masking, the established band precedence | depth and area units, pixel e2e |
| Explicit wall crossing six hexes at three heights, exactly along an edge, an X and a T | Split bases, host order, preserved door/window state and half-cell rise | wall units, pixel e2e |
| Rows turn 0, perimeter wall at `(3.54,8.6959375)` outside raised hex `(3,9)`, and mirrored/turned variants | Off-scene host at 0 sorts the front wall after the raised hex, not by its midpoint | wall/depth units, pixel e2e |
| Auto stairs and all six facings through higher and lower neighbors, both orientations | Copied treads, solid risers, unchanged legal movement and sight | units, iso e2e |
| Differently colored adjacent pit floors, equal depths and both near/far orders of unequal depths, on squares and both hex orientations at all turns | Each floor retains its own pixels through neighboring openings, far faces have no base-canvas seam, source crop covers the projected floor | independent surface/color oracle, pixel e2e |
| Connected equal-depth floors with distinct colors and one uniform `pitShade`, on both grids | Every visible floor pixel has its owner's single shade, including through a neighbor's opening, with no extra dark strip | independent surface/color oracle, pixel e2e |
| All hexes at -1, floor center `(3,3)` seen through opening `(5,4)` on rows or `(4,5)` on columns, turn 0 | The correct floor color appears through the connected opening | independent surface/color oracle, pixel e2e |
| A pit-based wall, a creature and an area below 0 on both grids, region crossing a bucket boundary, then joining/splitting | Connected openings show visible content and hide it behind the near rim, no obsolete region clip | clip/cache/volume units, pixel e2e |
| Top/face tap, vertex ray, outside perimeter, 1 and 5 ft per cell | First drawn surface, finite monotone walk and correct world key | independent ray oracle, pick units |
| Every face and top hit near rounded edges, both orientations and all four turns, through `tapGround` and `snapAnchor` placement | Carried cell names the visible height, reconciled point has the same `hexAt`, displacement at most 1/64, Medium placement chooses that hit hex | pick and real-consumer units, iso e2e |
| Token, holder and group dragged onto/off heights, then cancelled | Preview agrees on seen ground, same stored move as Top-down, nodes restored | drag units, iso e2e |
| One revealed sub-cell and one fog tile crossing a hex-key chunk corner | Known height, masked top, neutral sides, only correct buckets rebuilt | fog/cache units, pixel e2e |
| Two states differing only in fully hidden heights, hidden map pixels or hidden stair facts | Same player pixels, base, pick, preview, extrema, fit and draw decisions | differential units and pixel e2e |
| Per-player viewer, another player's exploration, View as a player and table display | Each uses its own fog/live-sight masks, no borrowed relief | iso e2e, pervision regression |
| Sphere, cone, cylinder, cube, line and hex emanation at a hex ledge and pit | Ground rims on canonical sides, no square cut, live-ground stand rule and rings kept | volume units, pixel e2e |
| Hex emanation and edge-aligned cube with vertical faces on shared edges, equal and unequal neighbor heights, both hex orientations, plus square boundary-face regressions | Each face portion has one solid-interior owner before height cuts, no duplicate faces or retained part below that owner's ground | volume units with face multiplicity and height assertions, pixel e2e |
| Rows `(3,3)` at 2 beside `(4,3)` at 0, face z 0 to 3 on their edge with interior in `(3,3)`, and mirrored case | Exactly one z 2 to 3 face, no z 0 to 2 remainder | volume units |
| A 40 ft cube on alternating hex heights in both orientations | Pieces follow local face/hex intersections rather than the arrangement of extended side lines, each build frame and total latency reported | volume units, integrated bench |
| At 11/12 px and Low power 23/24 px, including Find and Fit | Surface, token bases, input and fit agree with the threshold | units, iso e2e |
| Panning and dragging a fully raised 40 by 40 scene, all turns | Section 9's counters and timing gates, no rebuild at rest | integrated bench |
| Top-down before/after and existing square iso fixtures | Top-down parity and unchanged input, square Isometric changes only for the documented connected-pit correction | parity and explicit square pit baselines, iso/hex/reach e2e |

### 10.4 Independent depth fuzzing and mutation checks

Run a seeded property test over at least 2,000 random 8 to 24 cell height maps per orientation, all four turns, with positive heights, pits, fog masks, sparse scenes and boundary hexes. Include exhaustive neighbor tests through both parities and the largest scene's rows/columns. Failures print seed and the minimal cells, heights and ray. Shuffle chunk and cell enumeration to test stable ties.

The terrain oracle intersects the projected canonical top and side polygons at sampled screen points and picks the nearest world-space ray hit. It does not call `keyOf`, `facesOf` or the proposed traversal. Compare that answer and its owning floor's source color with the last opaque terrain surface drawn there, excluding exact shared-edge antialias pixels. Include connected depressions with equal and unequal floors on squares and both hex orientations. Separately assert own lower cells precede each standee, own higher cells cover it, holders precede riders, wall hosts follow the correct terrain interval and bands obey natural-key precedence. Do not require exact billboard pixels where section 6.4 accepts an error.

**Design check, run on the cited base:** a separate geometry diagnostic checked 2,202,480 side/turn combinations across every hex of both orientations on 200 by 200 scenes. No rounded edge reversed center order. The smallest absolute normal dot D was 0.2470 and the largest center-to-vertex depth radius 0.5632 cells. Seed `0x68153046` then generated 4,000 random height maps, 2,000 per orientation, and 64,000 rays over all four turns. Direct convex-prism ray intersections agreed with center order throughout. This checks the geometric premise, not pit-opening compositing, floor-copy source colors, masks, wall integration, rule-consumer identity or phone cost. Round 1 reproduced failures in the original pit clips and face nudge despite this diagnostic passing. The builder must add the independent production tests above.

Mutation-check tests by replacing center depth with offset sum or lifted y, removing parity/mirroring, reverting wall keys or perimeter keys to midpoint, omitting a split, replacing occupied hexes with their rectangular range, using P for bands, reading raw hidden neighbors, using square fog keys or hex pit clips, clipping a pit floor to its own opening instead of its floor polygon plus region, cropping the floor copy by the opening, shading each opening instead of its floor polygon, leaving a below-rim wall unclipped, dropping hit-cell propagation or rule-point reconciliation, restoring extended-line area cuts or a square volume cut, emitting a coincident area face for both cells or assigning its owner only after height cuts, using ideal `hexAt` for canonical boundary ownership, removing square interior-side sampling, and dropping diagonal-chunk/world-tile or connected-region invalidation. Each must fail its corresponding test. Use randomized fog, turn, height and door-change sequences to assert no stale permitted volume survives and unchanged buckets remain cached.

Pixel cases use solid code-drawn map colors and fixed camera/zoom, actual canvas pixel samples and screenshot comparisons, not only layout-hook ids. For each orientation capture turns 0 and 1 and the opposing turns, height boundaries, a wall, stairs, connected pits with differently colored floors, a flier/area and a partly fogged top. Include equal depths, both orders of unequal depths and below-rim walls on squares too. Inspect every captured image. Retain unchanged square and Top-down parity images, with explicit corrected baselines for square pit cases. Screenshots live in the feature's `iso-hex-relief` screenshot folder, with distinct names for each run.

Run typecheck, units and build, then integration tests and `iso`, `hex`, `pervision`, `areas` and `reach` e2e through the project lane checker when a builder has database and port assignments. Add the alignment runs if controls or their anchors change. The design session has no browser, database or integrated benchmark result to report.

### 10.5 Docs the build updates

`FEATURES.md`: Scenes and maps, its Isometric view and Hex grids entries, Height and elevation, Walls and doors, Areas of effect and Fog and vision. Replace the flat-hex exception. Say hex heights stand, stairs retain their marks, connected pits show their floors continuously on either grid, explicit walls follow their ground and the same fog and low-power rules apply. Keep painted ground, rooms, pillars and automatic walls square-only.

`docs/dm-guide.md`: Hex grids, Heights and stairs, The isometric view's "Hex scenes" paragraph (currently line 418), What players see, and Areas in Isometric. Add an openly licensed map or code-drawn hex-relief screenshot with readable alt text showing a terrace, stair, explicit wall, pit and creature. Explain that a shape meets the raised hex ground and no game distance or sight changes. Keep the existing View menu instructions. Add no deploy action or reload requirement for a protocol that did not change.

### 10.6 Review round 1 dispositions

| Finding | Disposition |
|---|---|
| HXREL-ASTRA-1, HXR-OPUS-2 | Adopted the confer's full fix: connected-opening rim clips, individual projected floor polygons and source bounds, below-rim walls, and colored-floor oracle/pixels for equal and unequal depths. Squares take the same fix in this lane |
| HXREL-ASTRA-2, HXR-OPUS-1 | Adopted: return the hit cell, carry it to cell-based UI, reconcile rule-bound top and face points toward that center within 1/64, and test real tap and placement consumers |
| HXR-OPUS-3 | Adopted: bounded face/hex polygon intersections, same-height merging and stable shared edge ids. Added the alternating-height 40 ft cube bench. The 215-line, 7,299-intersection diagnostic establishes subdivision risk, not a measured timing miss |
| HXR-OPUS-4 | Adopted: off-scene lattice hosts at 0 for perimeter walls, with the reproduced rows/turn-0 case |
| HXR-OPUS-5 | Adopted: decision entries are already logged. Round 1 amendments are supplied to the coordinator |
| HXR-OPUS-6, HXR-OPUS-8 | Adopted: named all requested consumers, including `heights/tap.ts`, beside the caller audit rule |
| HXR-OPUS-7 | Mostly declined: `cellPieces` at 189, `wallItems` at 229 and `masked` at 38 are correct on the cited base. Pointed the footprint reference directly at `occupiedRange` at 151 |

### 10.7 Review round 2 dispositions

| Finding | Disposition |
|---|---|
| HXREL-ASTRA-3 | Adopted: each boundary-coincident face portion has one canonical solid-interior owner before height cuts, with hex-emanation and edge-aligned cube cases, equal/unequal neighbors, both orientations and no-duplicate/no-below-ground assertions. Squares already partition once and sample inward, with code evidence and regression coverage in section 8 |
| HXR-OPUS-9 | Adopted: `pitShade` fills the owning floor's projected polygon at depth, under the region clip, on both grids. Added the uniform-shade colored-floor oracle and pixel case |

## 11. As built

To be filled in the implementation lane's final docs commit. List every departure from this design, final file ownership and exact commits, unit seeds and mutation results, inspected pixel cases, alignment roots and sizes actually measured, both orientation benchmarks and remaining failures. Distinguish integrated phone-stand-in measurements from a real-phone spot check. Record a real-phone pan and drag on the raised 40 by 40 scene, and canvas memory with both trees mounted on a 2x tablet. Until then the flat behavior in section 4 remains the shipped behavior.
