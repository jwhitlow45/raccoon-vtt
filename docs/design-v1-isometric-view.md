# raccoon-vtt v1: an isometric view of the board

Status: draft 5, revised for design review rounds 1 to 4 (section 15 maps every finding), D-261026-5 and D-261026-7. Code is cited from main at `8b23756c`. Every lane is built, and Isometric is in reach on every device since ISO-5's integration commit (section 14 says what each built).

## 1. The owner's words

The project owner, 2026-10-26: "Also if possible adding an option for an isometric view of the board would be great wherever that fits in".

D-261026-1 sets the scope: a per-device view choice, Top-down (today's board, the default) or Isometric. The DM may set a scene's suggested view, which a device follows until its user picks one. Play works in it with the same rules. Map building tools may switch the board to Top-down while in use, each with a reason. Tokens stand up as standees with their existing art, known heights show as height, and the view turns in 90 degree steps, projected as the common 2:1 game "isometric". D-261026-5 settles round 1: a pick holds for the whole room until the user picks "Follow the scene" again, a turn alone is never a pick, and Isometric never shows a player more than Top-down (5.2). The owner then asked whether walls and raised ground are textured, and D-261026-7 says yes, from the builder's existing textures (5.5). Asking the owner is off, so every other choice is a guess at the owner's likely answer, listed with the options it rejects.

## 2. The answer in short

- **A view, never a change to the map.** Rules, ops and distances stay in world cells. A press becomes a world point once, then everything runs as in Top-down.
- **2:1 dimetric.** The ground turns 45 degrees and halves in height, heights rise √3/2 of a cell per cell, and the view turns in four steps.
- **Standees.** Each token's art stands upright on its ring, in depth order with raised ground and walls. A covered standee shows its outline, and a second tap picks the one behind.
- **The stand rule.** For a player, anything that stands up stands only where every fog sub-cell under it is revealed to that viewer. Otherwise it lies flat under the fog, as Top-down draws it. Drawn heights never read terrain the viewer has not seen.
- **Heights stand.** Seen raised ground becomes columns whose tops carry the map, grid, areas and fog and whose sides wear the builder's textures. Pits open. Walls stand half a cell high in stone, per quarter-cell run of revealed fog.
- **Four DM tools show Top-down while in use:** the map builder, fog, line up grid and traps.
- **The choice:** a View button beside Fit, keys I, Q and E, a pick per device and room, and a DM's "Suggested view" per scene.
- **Cost**, from the prototype's draw-call timings on the 4x CPU stand-in for a mid phone: a typical scene's pan frame is about 2 ms over Top-down's, and a local drag redraws only the drag layer. At the caps a pan frame is 1.4 to 1.6 times Top-down's, with walls and columns flat below 12 px a cell. Every gate is `TaskDuration`, measured by ISO-2's bench (11).

## 3. Decisions, with rejected options

- **ISO-D1 Projection:** 2:1 dimetric, heights at K = √3/2 view units per cell, the camera tilt that halves the ground. Rejected: true isometric (not 2:1), heights at 1 per cell (taller than the map's scale), a free angle (general 3D).
- **ISO-D2 The pick (D-261026-5):** per device and room: "Follow the scene" (the default), "Top-down" or "Isometric". Turns are kept per scene. Rejected: a pick per scene, one pick for every room, a server-side preference.
- **ISO-D3 The suggestion:** a DM scene setting, the view only, followed live once any gesture in progress ends. Rejected: a suggested turn, forcing the view (D-261026-1).
- **ISO-D4 Standees:** the token's art upright, never turned by `token.rotation`, on its ring, with a facing tick on the ring when the token is turned. Rejected: turned art (reads as a fallen creature), flat discs (D-261026-1), cut-out figures (new art).
- **ISO-D5 The stand rule (D-261026-5):** sub-cell revealed or flat under the fog. Rejected: whole standees above the fog, clipping upright art by its footprint (the art is not over its footprint).
- **ISO-D6 Ground heights:** seen raised cells stand as columns whose tops copy the ground's pixels, and pits open. Rejected: outlines only, plain tops (hide the art), map-only tops (would drop the fog off a half-fogged cell).
- **ISO-D7 Walls:** half a cell high, per quarter-cell run. Rejected: full height (rooms hide, a phone turns all the time), flat (rooms read flat).
- **ISO-D8 Covered creatures:** true depth order, an outline, tap again. Rejected: standees always on top, no outline (lost until a turn).
- **ISO-D9 Tools:** builder, fog, line up grid and traps show Top-down while in use (6.4). Rejected: every tool in Isometric (cell and edge picking on half-height diamonds), a view without interaction.
- **ISO-D10 Turns:** instant, about the selected token or the middle, Q and E, buttons in the View menu. Rejected: animated turns (a re-sort and label layout each frame), a twist gesture (a pinch would turn the map).
- **ISO-D11 Arrow keys follow the screen:** Up moves toward the map edge facing up and to the right. Rejected: world axes.
- **ISO-D12 Level of detail:** below 12 px a cell (24 in Low power) every drawn height is 0: walls, columns and pits lie flat as Top-down draws them, and picking and standees read the same flat ground. Rejected: always standing (162 ms a frame at the caps' fit, draw calls).
- **ISO-D13 The ground stage:** a second Konva stage under the board, taller by the lift, whose canvas the tops copy. Rejected: redrawing the ground once per height.
- **ISO-D14 Keep in view:** the ground under the clear area's middle stays on the scene. Rejected: the 64 px rule on the diamond's box (its empty corners).
- **ISO-D15 Both drawing trees stay mounted** once Isometric has shown in the room, the hidden one's Stage at 0x0, and every controller with effects mounted once outside both (5.1). Rejected: remounting on each switch (194 to 332 ms at the caps, draw calls).
- **ISO-D16 The table display** picks its own view under its own key. Rejected: mirroring the DM's view.
- **ISO-D17 Follow the DM** sends the DM's camera, never ground: its middle at 0, its size in view units, its view and turn. Each display fits the ground it may see. Rejected: a box over the DM's drawn heights (its size showed displays hidden terrain), a box at 0 plus a fixed margin (cuts high ground or overshoots by a guess), a tight square on the middle.
- **ISO-D18 Textures (D-261026-7):** sides wear their cell's builder texture, walls stone, closed doors wood, all from the builder's openly licensed textures. Rejected: flat tones only, the top's edge pixels stretched down (smears), stone on every side (a grassy bank would read as a wall).

## 4. The projection

### 4.1 Arithmetic

World units are cells, x right and y down the map. A height z is in cells: feet over the room's feet per cell. **View space** is the stage's coordinates before the camera, the world itself in Top-down. The camera stays `{ x, y, scale }`: screen = view × scale + (x, y).

| Turn q | c | s | The map's top edge faces |
|---|---|---|---|
| 0 | r | r | up and to the right |
| 1 | -r | r | down and to the right |
| 2 | -r | -r | down and to the left |
| 3 | r | -r | up and to the left |

```ts
// r = Math.SQRT1_2, K = 0.8660254037844386 (a literal). Turning right adds 1 mod 4: the map turns clockwise.
toView(x, y, z)  = (c*x - s*y, (s*x + c*y) / 2 - K*z)
toWorld(u, v, z) = (c*u + s*w, c*w - s*u)   where w = 2*(v + K*z)
depth(x, y)      = s*x + c*y                // larger is nearer the viewer
```

- Top-down is `toView(x, y, z) = (x, y)`. A cell shows as a diamond √2 wide and √2/2 tall. A circle d across on the ground shows as an ellipse d by d/2 at every turn, so a standee d wide sits on its ring.
- In Konva the ground is two groups, `scaleY 0.5` outside `rotation 45 + 90q`. Their inverse, for upright parts inside, is one group with `rotation -(45 + 90q), scaleY 2`. A unit test pins Konva's absolute transform to `toView` within 1e-9 px.
- **No exactness is needed.** No rule reads the view. Round trips agree within 1e-9 cells.
- **`ViewPoint`** is a branded point. `worldToScreen` and `screenToWorld` become `viewToScreen` and `screenToView`, and `zoomAt`, `fitRect`, `rectClear`, `cameraForView` and `keepInView` take view points, so the typecheck lists every caller.
- **`groundAtMiddle(live)`** gives the point at 0 under the clear area's middle. It reads no heights, so no point a device sends depends on terrain another viewer cannot see. It replaces every hand-written `(viewport / 2 - cam.x) / scale` and every read of `stage.x()` and `stage.scaleX()`: `viewFromCamera` (scenes/create.ts:171), the spawns (CharacterCard.tsx:304, CompanionsSection.tsx:276, EncountersPanel.tsx:328, grid/tool.tsx:24), `focusFromStage` (dm/camera.ts:41), the view event (dm/tableDisplay.ts:57), CameraLayer.tsx:52 and 71, PingLayer.tsx:177 and PinLayer.tsx:136. A unit test scans client/ and fails on those patterns outside lib/camera.ts and lib/view.ts.

### 4.2 Pan, zoom, fit, turns and following

- **Pan, pinch and wheel** are unchanged, in view space.
- **Fit** fits the target's view box: its four corners through `toView` at 0, the top raised by the highest drawn lift inside. `sceneMinScale` reads the same box.
- **Keep in view** clamps the ground under the clear area's middle into the scene's rectangle. `barShift` pans by its dy and clamps the same way.
- **A turn or a view switch** keeps one world point still on screen: the selected token's ground center while on screen, else `pickGround` of the clear area's middle, on this device only. The scale stays.
- **Boxes.** `boardViewOf` returns view boxes, so upright pills slide as today.
- **World points with a zoom** (a starting view, Follow me, Bring everyone here, Look here, follow the turn, Find my token) keep their meaning. Each device centers the point in its own view.
- **Follow the DM (ISO-D17).** A Top-down DM's `view` event stays as today. An Isometric DM's event keeps x, y, w and h as the box of its clear canvas's corners at 0, terrain-free, and adds `iso: { turn, vw, vh }`: its turn, and its clear canvas's size over its scale in view units, centered on its middle at 0.
  - **Protocol.** The schema (shared/protocol.ts:2542) takes `iso` as an optional strict object, `turn` an integer 0 to 3, `vw` and `vh` from 0.01 to 2,000 like `w` and `h`. The server routes it to displays as today (ephemeral.ts:161). A page not yet reloaded checks messages against its old strict schema (client/state/socket.ts:489) and drops the event, so it stops following an Isometric DM until someone reloads it. Nothing forces that reload, since the client has no version check (ISO-1's As built): the deploy note says to reload every open page, table displays included. A test runs today's schema against the new event.
  - **The fit.** A display in Isometric at the same turn frames the DM's view rectangle exactly. Any other display takes that rectangle's ground at 0, then searches its own seen terrain (its shared fog, 4.3) for pieces whose full projected bounds, at the DM's turn, meet the rectangle. Their anchors can lie past the box at 0 toward the viewer, so the search covers the rectangle grown downward by K times the display's largest drawn lift, through its buckets. It fits the world box of that ground and those pieces through its own projection, and promises the ground the display may see under the DM's camera.
  - The event depends on the DM's camera alone, so hidden terrain changes neither the event nor the fit.
  - The event is the DM camera's footprint on the ground at 0, whatever moved that camera: a fit, a turn's hold or a pan that read the DM's own heights moves the camera, and the event says only where it now looks (D-261026-16).

### 4.3 Drawn heights and what lies under the pointer

**One source of drawn heights.** `drawnGround(cell)` is 0 below the ISO-D12 threshold and on cells this viewer has not seen (`seenGround`, client/features/builder/heights/ground.ts:36, is null), else the cell's ground. `seenFootprintGround` is the highest `seenGround` under a footprint, unseen cells counting 0, and `drawnFootprintGround` the same through `drawnGround`.

- **A standee's base** is `drawnFootprintGround + elevation - seenFootprintGround`. Above the threshold that is its elevation. Below it, its lift over the seen ground. Hidden terrain never enters, so the same visible state over different hidden heights draws the same pixels. A negative offset, a token inside the ground, appears only where that ground is seen.
- **Mid-drag**, the previewed base applies the drop's landing (`dropLanding`, movement/drop.ts:125) to drawn ground: a rider whose seat is kept (`seat.keptAt`) stays at its holder's elevation, and otherwise `landedElevation`'s branch applies, so a fogged platform never lifts a standee. After the drop the stored elevation draws by the formula above, so after a drop onto hidden ground the stem shows the badge's own number, as Top-down's badge already does.
- Columns, pits, wall bases, uprights, picking, fit, the lift margin and culling all read drawn heights. Rules keep reading real heights, so a ruler stop's stored z is still `seenGround`.

`pickGround(screen)`, grid-owned, gives the world point a press means. In Top-down it is `toWorld(screenToView(screen))`.

1. Let `v = screenToView(screen)`. The ray's trace on the ground, `toWorld(v, z)`, runs from near the viewer to far as z falls from the highest drawn ground (or 0) to the lowest (or 0), 2K cells of trace per cell of height.
2. Visit the cells it crosses in that order. Cells outside the scene count as 0.
3. In each cell the ray enters at `zIn` and leaves at `zOut`. At or below the cell's drawn ground on entry: the near face, so return the entry point moved 1e-6 into the cell. Ground between the two: the top, so return `toWorld(v, ground)`.
4. **Bound.** The walk visits at most 2√2·K·Δz + 3 cells, Δz the drawn range in cells, and never more than the scene's w + h: about 150 at 5 ft a cell over −100 to 200 ft, the scene's size at 1 ft. A bound, not a cutoff.

Standees are found first, by Konva's hit canvas. Hex scenes get H3's hex walk (4.4).

### 4.4 Hex scenes

The projection knows no grid. H1's hex lines draw on the ground stage, and footprints keep their boxes (hex design 4.2), so standees and decor need nothing more. HX-D18's culling enumerates, per hex row, only the span inside the inverse-projected viewport polygon, so hex lines cost about twice Top-down's, not the 6.6 times its bounding box would.

Lines for the hex design to carry: **H2**: "In Isometric, Wall lines stand as free walls do (isometric view 5.5), by the quarter-run rule." **H3**: "In Isometric, heights stand as hex columns, the three sides facing the viewer as faces, sorted by hex center depth, a standee after the hexes of its footprint at or below its base. `pickGround` and the drag adapter walk hexes along the trace with the near-face rule per hex side. A pit clips to its hex opening. Tests: hex depth order, hex `pickGround`."

## 5. What draws how

### 5.1 Structure

In Isometric the board is two stages, one over the other:

1. **The ground stage** never listens. It is taller than the canvas by the lift margin: the highest drawn lift in view, in 128 px steps, at most one canvas height. One layer holds the ground group: background, map, grid, the `board` layers, sight, fog, and the still ground marks (range rings, attached areas and tethers of tokens not being dragged, turn start, explored outline). Nothing that moves each frame draws here.
2. **The main stage** holds three layers. The relief holds the ground group again, with the depth list of 5.6. The drag layer holds what a local drag moves: the pressed standee, its decor, its path and label, and its rings, attached areas and tethers. The overlay, in view space, holds uprights, silhouettes, decor and the moving marks: pings, the hold ring, the laser, area previews, rulers, other members' previews, and the rings, attached areas and tethers of a token another member is dragging.

- **One draw a frame.** In Isometric the Stage owns one requestAnimationFrame scheduler. After mount it assigns `batchDraw` on the ground and relief Layer instances to a function that marks the scheduler, so react-konva's commits, Konva's own calls and `Stage.batchDraw` all reach it. Each frame it draws the ground if marked, then the relief if marked or if the ground drew. The drag and overlay layers keep Konva's own `batchDraw`. The bench counts draws per frame.
- **Moving marks.** While a token is live-dragged, here or on another device, its range rings, attached areas (auras) and tethers draw as moving marks at their drawn height, and return to the ground stage at the drop. Rings are above the fog in Top-down and draw whole. An aura or tether, under the fog in Top-down, draws clipped to the viewer's revealed sub-cells. Clipped, it loses the fog's 35% edge tint and the sight shading over it, the cosmetic loss 5.2 accepts for ghosts.
- **Both trees (ISO-D15).** The Top-down and Isometric drawing trees are drawing only. Every controller with effects mounts once, outside both, whichever view shows: CameraLayer's camera events, PingLayer's sound and vibration, TemplateLayer's and TetherLayer's reminder subscriptions, and the frame clocks (remote drag easing, ping and laser animation, sight tile writes). The hidden tree's Stage is sized 0x0, which frees its canvases and keeps its nodes, and it is memoized out of camera renders.
- Top-down keeps today's four layers. `LayerDef` (client/features/layers.ts) gains `iso: "ground" | "moving" | "upright" | "off"`.

### 5.2 The stand rule (D-261026-5)

- For a player on a scene with fog, a thing that stands up stands only when every fog sub-cell under its Top-down footprint is revealed to that viewer. Otherwise it lies flat on the ground stage under the fog, as Top-down draws it.
- **The things and their footprints:** a creature's footprint (squeezed while it squeezes), another member's drag ghost's footprint and its name tag's box at each eased frame, a map label's measured flat box (`labelShape`, 6.2), a text drawing's box, an area's or trap's pill or badge as the box Top-down places it in at this zoom, and a tether's stroke: the sub-cells within half its width of its line, its round caps included.
- **Always standing:** party members and tokens every player always sees (`drawsAboveFog`), and everything on the DM's device or on a scene without fog.
- **Flat creatures** keep an invisible press area on their footprint in the relief layer, and their decor on the view box of their footprint's diamond, ((w + h)·r wide), above the fog as Top-down's decor already is (design 13.4). They get no silhouette.
- **A flat ghost and its tag** draw on the overlay at the ghost's drawn ground, each clipped to the revealed sub-cells of its own box. Fogged sub-cells are opaque (lib/fogTiles.ts:50), so this exposes no unrevealed content. The fog's 35% edge tint and the sight shading are not drawn over a clipped ghost, a cosmetic loss accepted. Overlay ghosts, standing or flat, draw over the relief whatever its depth, also accepted.

### 5.3 Each layer

| Thing | Isometric |
|---|---|
| Background, map image, grid, floors, pit terrain, stair treads, difficult ground, stamps | ground stage, lifted onto columns with their tops |
| Relief tint and shadow (relief.ts) | off where columns stand, else ground stage |
| Walls, doors, windows, pillars | standing (5.5), or flat under ISO-D12 |
| Map labels, text drawings, area and trap pills and badges | upright by the stand rule, else flat on the ground stage |
| Areas, traps, other drawings, range rings, tethers | ground stage, draping over columns, and moving marks while their token is dragged (5.1) |
| Sight with its memory, fog | ground stage. Tops copy them |
| Turn start, explored outline | ground stage, above the fog |
| Pings, hold ring, laser, area previews, outliner flash, rulers | moving: overlay ground shapes, rulers upright lines, at their drawn height. Pills upright |
| Pins | upright at the pin's drawn ground |
| A local drag: the standee, its decor, path and label, drop ghost | the drag layer, the ghost at 0.6 |
| Other members' drags | overlay, standing at 0.6 or flat (5.2), each eased frame |
| Fog draft, height marks, light reach, stamp handles, line up grid | off: their tools show Top-down (6.4) |
| Tokens | standees (5.4) or flat by the stand rule |
| Chips, badges, HP bar, notch, lock, AC, number, label, plate | upright passes on the standee's box, laid out as today |
| Silhouettes | upright: a standing standee's art outline where a later piece covers it, at 0.35 |
| Action bar, dock, door pill, height readout, stop note | HTML chrome anchored through `toView`: the bar under the ring and label (`worldAnchor`, `belowLabel`), `tokenRise` the art box's height |

### 5.4 Standees

- **Box.** The art box is the footprint's w by h in view units, its bottom middle on the footprint's center at the base (4.3). `TokenText.widthPx`, `boardSizes` and every decor layout keep their numbers. Label layout (`useBoardText`, `textBoxes.ts`) reads view × scale px boxes.
- **Ring and art.** The art is as today, with its life tints, dead mark, initials and glyphs. The ring is the footprint's ellipse at the base, filled 25% black. Selected and active outlines are ground ellipses around it. A turned token adds a short tick toward its facing.
- **Height.** A base above the drawn ground under the footprint draws a shadow ellipse on that ground and a 1 px stem to the ring. A lift on screen is capped at the margin cap, and a capped stem draws a break mark (the badge still says the height). A token inside seen ground is hidden by its own cells (5.6), and its outline shows.
- **Carried tokens** draw after their holder, standing half its art height up on it, inset by `COVER_INSET` when they cover its footprint.
- **The DM's device** dims to 0.5 a standee whose footprint is wholly under the players' fog or out of party sight.
- **The node** sits at the token's world x and y inside the ground group, its upright parts in one inverse group. `node.x()` and `node.y()` stay world cells (6.3).

### 5.5 Raised ground and walls

- **Columns.** A cell whose drawn ground is above 0 draws its sides that face the viewer, from the neighbor's drawn ground up to its own, then its top: the ground stage's pixels under the cell, copied up by the lift, clipped to the lifted diamond, read only from the source box. Neighboring tops with one lift share a clip and a copy.
- **Textures (D-261026-7).** A side wears its cell's builder terrain texture (client/features/builder/textures.ts), laid along the face one tile per `TEXTURE_CELLS` cells of edge and of height, then shaded lighter on the left face and darker on the right. A stair's side takes the stair swatch. A cell with no builder terrain, on a map image, takes a flat tone tinted to its top's average color. The average reads only pixels wholly inside the cell, from the decoded map image Top-down draws, copied 1:1 into a small canvas so nothing is resampled across the cell's edge, and is cached per cell. Never the thumbnail, whose downsampling blends neighbors. For a player only cells with every sub-cell revealed take the tint, the rest the neutral side tone, so no tint carries art from under the fog. Patterns are made once per texture and face direction and kept with the bucket.
- **Pits.** A cell below 0 is an opening. Inside its diamond it draws its floor (the ground pixels copied down) and its far sides. Everything on a pit's cells, standees included, is clipped to the openings swept upward past the canvas top, so the near rim hides what is below it.
- **Stairs** are columns, and their treads come up with their tops. Connected stair edges draw no face. Past the margin, a top whose source lies below the ground stage fills with the face tone until panned up.
- **Wall segments** are the derived set's walls, doors and windows (`deriveWalls`, shared/rules/walls.ts:1110), so automatic walls stand and "no wall" marks do not. Its raised-edge and pillar segments are not walls. Free walls are split where they cross, keeping their door and window features.
- **Runs.** Each segment is cut at sub-cell lines into quarter-cell runs. For a player, a run stands only where a fog sub-cell beside it, on either side, is revealed, since Top-down shows that half of the line there. A free-wall run inside one sub-cell stands by that sub-cell. Neighboring standing runs of one segment merge within each cell, so there is at most one piece per wall cell. A piece stands `WALL_RISE` = 0.5 cell high from the higher drawn ground beside it, walls in the stone texture tinted toward the wall color, a closed door's leaf in the wood texture, a window as a half-opaque pane. An open door lies flat. Locks and secret marks stay the DM's. Pillars follow the stand rule, in stone tinted toward the pillar swatch.
- **Sight.** Sides and wall pieces keep the darkness the sight overlay gives their cell, cached per sight tile object.

### 5.6 Depth order

- **Keys.** A column or pit by its cell's center, a wall piece by its midpoint, a standee by its footprint's center, each by `depth`.
- **Own cells.** A standee draws after every cell of its own footprint whose drawn ground is at or below its base, and before every own cell above its base, whatever their keys. So a Large's ring stays whole on a platform, and a token buried in its cells is hidden.
- **Ties:** column, pit, wall, standee, then a carried token after its holder, then id.
- **Why it holds.** Columns are unit cells on one grid, so center depth orders them, and a snapped standee stands on a cell's center or corner. Mid-drag or with snapping off, a column within one cell's depth may draw on the wrong side for that moment. Wall pieces never cross and never pass a cell line. Two that meet at an end can draw in the wrong order only within one cell of the meeting point and `WALL_RISE` tall. All accepted.
- **Silhouettes.** A standing standee whose art box meets the screen box of anything drawn after it gets one, found with the sort.
- **Buckets.** Pieces live in 16 by 16 chunk buckets, each sorted. A token move re-inserts one standee. A turn sorts only the buckets in view and the rest as they come into view. A bucket is rebuilt when its heights, walls, doors or the viewer's seen sub-cells change (fog tile objects, as `mergedOf` keys them). Runs of pieces that are not standees draw in one Konva Shape that does not listen.

### 5.7 Culling

Each piece has its full projected bounds in view space: a column with its faces and top, a wall piece with its rise, a standee's art box, ring, stem, shadow and decor. Each bucket caches the union of its pieces' bounds, rebuilt with the bucket and on a turn. A bucket draws when that box meets the canvas's view box, so a high flier whose anchor lies off screen, and wide art past its chunk's left or right edge, still draw. The overlay's decor culls by the same per-token bounds.

## 6. Input

### 6.1 Pointer to map

`ToolPointer.world` (client/features/tools.ts:58) is `pickGround(screen)` in Isometric. `screen` is as today. Slops and grab radii compare view distances: a candidate's `toView` point against the pointer's, times scale, against the px (doors, labels, the ruler, AreaTool.tsx:150 and 176, DrawTool.tsx:187 and 203, ruler.ts:153).

### 6.2 Taps

- A standee takes a press on its art box or ring by Konva's hit canvas, so the front one wins. Relief runs do not listen, so a press on a column reaches a standee hidden behind it, where its outline shows, and otherwise goes to `pickGround`.
- **Tap again.** A tap on the selected standee where another standee's art or ring also lies under the press selects the next one behind, front to back, round again. No hold. With Shift, Ctrl or Cmd the front one is added or removed as today (`tapToken`, client/state/selection.ts:34).
- **Box select** takes tokens whose ring center lies in the screen box.
- **An empty tap** (emptyTap.ts) reads `pickGround`'s point: a map label by its displayed bounds, a door by its standing piece or its ground line, then the height readout, then a pin by its marker box (`pinUnder`). Hold to ping pings at `pickGround`'s point.
- **`labelShape(label, view)`**, the displayed bounds from `measureLabel` (the upright text block's view box, or the flat box's corners through `toView`), is shared by drawing, the stand test, `labelUnder` (builder/labelTap.ts), `LabelMarks` (BuilderLayer.tsx) and `labelPaneFrame.ts`.

### 6.3 Drags

A footprint-aware drag adapter, `dragBoundFunc` on each standee:

- **Grab.** At the start it keeps the grab offset, the screen vector from the pointer to the ring's center.
- **Where it lands.** Each move takes pointer plus offset as the ring's screen point `v`. For a token on the ground at the start, it scans the drawn heights along the ray from the highest down. At each height h it places the footprint centered on `toWorld(v, h)`, snapped as the drop would snap it. It keeps the first h where the landing rule over drawn ground (the footprint's highest drawn ground) stands it at h. Failing an exact match, it keeps the first h where it would stand at or above h. A flier keeps its base: `toWorld(v, base)`, unless the footprint's drawn ground there is higher, when the walker's scan applies. A token inside seen ground keeps its base and never rises. A Large or Huge straddling heights therefore stays under the finger.
- **On and off a holder.** A rider moved within its holder's footprint, where the seat is kept, stays at the holder's elevation, as `dropLanding` does. Off the seat it takes its branch from the holder's footing, as `landedElevation` does (drop.ts:71), judged on seen ground: off a holder on the ground, the walker's scan. Off a flying holder, the flier's rule at its own base. Off a holder inside seen ground, its own base, fixed. So pick and preview agree with the stored drop wherever its ground is seen. Where the holder's real footing differs on hidden ground, the preview follows the seen branch, and the stored elevation then draws by 4.3.
- **Readers unchanged.** It returns the footprint's top-left as an absolute position through the ground group, so `node.x()` and `node.y()` stay world cells for Stage.tsx's `dragMove`, movement/stageHooks.ts with its held previews, and RulerLayer.tsx's listener. Followers and carried riders move by the lead's world delta as today. Snapping, routes, legs, labels, refusals and drops are unchanged.
- **The drag layer.** On dragstart the Stage calls `node.moveTo` on every node the drag moves, into the drag layer's ground group, with their decor and moving marks: the pressed standee, the group's followers, carried riders and their riders. On dragend, and on `putBack` for a cancelled drag (Stage.tsx:1302-1316), it moves each back into the relief's ground group at its sorted index before React's next commit of those tokens, since react-konva never re-parents a node.

### 6.4 Tools

| Tool | In Isometric | Why |
|---|---|---|
| Select, several at once | works | 6.2 |
| Ruler, Straight and Walking | works | points by `pickGround`, stored z by `seenGround` as today |
| Area | works | origin by `pickGround`, aimed in the ground plane at the origin's height |
| Ping, laser, Draw, Add token, Pin | works | `pickGround`. Draw's rectangles and ellipses are world shapes |
| Doors, action bar, turns, Fit, Find my token, View as a player, label editing | works | 6.2 |
| Map builder, every mode | Top-down while in use | it paints cells and picks edges, which shrink to half-height diamonds and standing pieces, Heights would raise the ground under the brush, and its panes and handles are square to the map |
| Fog | Top-down while in use | it paints the ground the fog lies on, and a reveal behind a column could be neither seen nor reached |
| Line up grid, Trap | Top-down while in use | the grid box lines up with the image's own axes, and trap zones are rects of cells with wires on half-cell points |

Choosing one of these four tools shows Top-down at once, centered on the same ground point, and any other tool brings Isometric back. The pick does not change.

### 6.5 Keys

Through the registry (client/state/shortcuts.ts), rebindable, for everyone:

- **I** picks the other view. **Q** and **E** turn left and right, and in Top-down say "Turning needs the isometric view." While a tool shows Top-down, I records the pick and says the tool's line (section 8).
- **Arrow keys** in Isometric move by the screen: Up toward the map edge facing up and to the right, Right toward the one down and to the right, and so round. Up is north at turn 0, west at 1, south at 2, east at 3. Stage.tsx:837's nudge goes through `arrowStep`.

## 7. The choice

- **View button** in the top bar before Fit (RoomChrome.tsx:283), 44 px, on every layout. Its icon is a square grid in Top-down and, in Isometric, a diamond with its top edge marked, turned with the view. The strip and the others give way first.
- **View menu**, a popover on wide screens and a bottom sheet on phones: a radio group "View" with "Follow the scene", "Top-down" and "Isometric", then "Turn left" and "Turn right" while the board is Isometric.
- **Remembering.** `rvtt.view.<roomId>` in localStorage: `{"v":1,"pick":"isometric","turns":{"<sceneId>":1}}`. No `pick` means Follow the scene. A turn writes only its scene's turn, at most 100 scenes, the oldest dropped. Reads and writes sit in try/catch, and an unreadable value reads as Follow the scene at turn 0.
- **Suggested view.** Scene settings, This scene, after Starting view: "Suggested view", a segmented "Top-down" or "Isometric", DM only. A following device switches once any gesture in progress ends.
- **Table display.** Its menu gets the same rows, stored under `rvtt.displayView.<roomId>`, as `rvtt.displayUiScale` is kept apart. Follow the DM fits the DM's world box (4.2).

```ts
// Scene: the view a following device shows here. Absent reads as Top-down.
suggestedView?: "isometric";
```

- **Op.** `scene.update`'s patch takes `suggestedView: "topDown" | "isometric"`, "topDown" removing the field, so stored scenes and undo hashes never change. DM only. Reducer: shared/reducer/room.ts beside `defaultView`. Undo label: "changing the suggested view of the scene Crypt".
- **Players** receive it in the scene copy (`projectSceneCtx`, shared/project.ts:999-1020). Duplicate and the room export copy it.
- **Versions.** The next free op and snapshot pair at build time, identity steps, so an older build refuses a room that may hold the field, and an open page reloads before it meets the `view` event's `iso` (4.2).

## 8. UI checklist

- **Words shown.** View button: aria-label "View: Top-down" or "View: Isometric", tooltip "Change the view". Menu: "View", "Follow the scene" with the help "This scene suggests Isometric." or "This scene suggests Top-down.", "Top-down", "Isometric", "Turn left", "Turn right" (aria "Turn the map left", "Turn the map right"). While a tool forces it, in the menu and the tool's options: "The map builder works top-down. Isometric comes back when you switch tools." (or "Fog", "Line up grid", "Traps"). Scene settings: "Suggested view", help "Devices that follow the scene show this view." Display menu: the same rows.
- **Loading.** A switch or a turn costs one frame plus the sort of the buckets in view, about 50 to 75 ms at the caps in draw calls, so no indicator. The first Isometric view in a room mounts its tree in batches of 100 standees a frame, ground first, behind the shared indicator after 200 ms ("Loading the isometric view").
- **Keys and focus.** The View button opens the menu with focus on the checked radio. Arrow keys move within it, Tab reaches the turn buttons, Escape closes with focus back on the button. A forced Top-down keeps focus where it is. I, Q and E in the sheet.
- **Screen readers.** A polite status for each change: "Isometric view.", "Top-down view.", "Following the scene: isometric.", "Turned right. The map's top edge faces down and to the right.", and once per tool choice the forced line.
- **Large interface sizes.** At 130% on a 320 px phone the radio rows wrap rather than cut a word, and the turn buttons stack.
- **Look.** Raised sides wear the builder's textures, lighter left and darker right, walls stone, doors wood, windows a pane. Map-image sides take a tone from their top. The textures load through the builder's loader with the first Isometric view, behind the same indicator.
- **Touch.** 44 px targets. No hold anywhere. Tap again picks the standee behind.
- **Alignment.** The top bar with the View button, the View menu in both views, Scene settings' row and the display's rows are measured with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px, with roots in e2e/alignmentRoom.ts.

## 9. Cases

| Case | Expected | Test |
|---|---|---|
| Any device after the deploy | Top-down, nothing changed | view store unit, reach |
| A point through each turn and back, z over the model's range, hex centers too, and Konva's ground group | the same point within 1e-9 cells, Konva within 1e-9 px | view unit |
| A press on a 10 ft platform's top, its near face, over a pit, over a fogged platform (player) | that cell, that cell, the pit's floor or far side, the ground behind at 0 | pickGround unit |
| At 12 and at 11 px a cell: a press behind a 30 ft platform, a standee on a seen 10 ft one | the top and 10 ft, then the flat cell and the flat ground | pickGround unit, standee unit |
| The trace at 1 and 5 ft a cell over −100 to 200 ft | within the stated bound | pickGround unit |
| A Medium behind a wall, and one in front of it | the one behind draws before the wall, the one in front after | depth unit |
| A Large and a Huge on a platform, and on mixed heights | ring whole, own lower cells before | depth unit |
| A token at 0 on a 10 ft cell, and a buried Large | its own cells draw after it, outline shown | depth unit |
| A goblin in a pit | clipped at the near rim | depth unit |
| Two free walls crossing in an X, and meeting in a T | split, ordered, any error within one cell | depth unit |
| A ledge and a pillar in the derived set | no wall piece from either | wall unit |
| A high flier whose anchor lies below the canvas, wide art past the left or right edge | drawn | culling unit |
| Two standees under one tap, then a tap again | front, then the one behind, then front | selection unit, iso e2e |
| A player drags a token 4 cells | lands as the same move in Top-down, "20 ft" | iso e2e |
| A finger on a 10 ft platform's top | lands on that cell, at 10 ft | drag unit, iso e2e |
| A Large and a Huge dragged across a ledge, a flier over a lower platform | under the finger, the flier at its height | drag unit |
| A rider dragged off a holder on the ground, one flying at 20 ft, one inside seen ground, one moved within a mount that straddles a ledge | lands as `dropLanding` does: on the ground, at 20 ft, at its elevation, at the mount's elevation, the preview agreeing | drag unit, iso e2e |
| A group of 4, and a mount with its rider, dragged and then cancelled | every moving node on the drag layer, each back in its place | drag unit, bench |
| A ruler from a token to a platform, a hold-to-ping | the same feet as Top-down, the same world point for the DM | iso e2e |
| Arrow Up at each turn | north, west, south, east | shortcuts unit |
| Q with the selected token on screen, Fit, a pan past the scene | the token stays put, the whole diamond, the middle on the scene | camera unit |
| The builder chosen in Isometric, ten times | Top-down and back, one frame each way, one camera stream, one ping sound, one reminder | iso e2e, controllers unit, bench |
| A pick, a reload, another scene, and a display page in the same browser | the pick kept across the room, the display's apart | view store unit, iso e2e |
| Q while following, then the DM changes the suggestion | the device still follows, and switches after any drag in progress | view store unit, iso e2e |
| Follow the DM across views and turns, with a revealed platform outside the box at 0 but inside the DM's rectangle | the same rectangle at the same turn, else at least the ground the display may see, the platform in a Top-down display's fit | display unit |
| An Isometric DM's `view` event against today's schema | rejected, so an old page stops following until it reloads | protocol unit |
| A grass bank, a stone platform, a map-image platform | grass sides, stone sides, a tone from the top on fully revealed cells | relief unit |
| **Security:** a fully revealed map-image cell with the same pixels beside different hidden art | the same tint | relief unit |
| `scene.update` with `suggestedView: "topDown"`, undone, and from a player | removed, restored, refused | room reducer unit, permissions unit |
| A label tapped with Select in Isometric | the label pane opens on the drawn label | label unit, iso e2e |
| **Security:** a party token at one stored elevation on fogged ground over hidden 0 ft and hidden 10 ft, still and mid-drag | the same pixels | standee unit, drag unit |
| **Security:** one DM camera and shared fog over different hidden heights | the same `view` event, focus point and display fit | display unit, camera unit |
| **Security:** a partly fogged goblin | flat under the fog, press area and decor kept | stand unit, iso e2e screenshot |
| **Security:** an area wholly under fog, a found trap's pill on fogged ground, a label with every cell partly revealed | each flat under the fog | stand unit |
| **Security:** a ghost whose eased path crosses fog between two allowed frames | ghost and tag flat and clipped on the fogged frames | stand unit |
| **Security:** a dragged token's aura crossing fog | clipped to revealed sub-cells | stand unit |
| **Security:** an edge with one sub-cell revealed each side, or on one side only | a quarter of the wall stands | wall unit |
| **Security:** a platform and a wall under fog | flat and not drawn for the player, standing for the DM | relief unit |

## 10. Tests

- **Units.** Every case marked unit, in `client/lib/view.test.ts` (seeded `rng`, a few thousand points a turn) and beside each module: `pickGround`, the drag adapter, depth order, silhouettes, culling, the stand rule, wall runs, camera, the view store, `arrowStep`, `labelShape`, the controllers mounted once, and the scan that bans hand-written camera math.
- **Mutation checks.** Each new test fails with its rule removed: the turn's sign, the lift's sign, a tie order, the own-cell rule, the pit clip, the 1e-6 nudge, the stand rule's every-sub-cell test, the either-side run test, the flat threshold, `seenFootprintGround` swapped for real ground, the footprint scan swapped for the center ray, a bucket's horizontal bounds, the grab offset, the front-to-back walk, the tap-again order, the room-wide pick, a controller moved into a drawing tree, the holder's footing branch, the kept seat, heights read in `groundAtMiddle`, the display fit's seen heights and its downward search, the tint on partly revealed cells or from pixels past the cell's edge.
- **e2e.** A new `e2e/iso.e2e.ts` (prefix ISO): the DM suggests Isometric, a player's page follows, the player drags, measures and pings on a square scene and on a hex rows scene, turns, picks Top-down and reloads. The DM switches to the builder and back, and edits a label through Select. Screen points come through the drag test hook (movement/dragTesting.ts). Plus `maps.e2e.ts`, the alignment files and `reach`.
- **Bench.** `scripts/bench-iso.ts`, ISO-2's first commit, reads `TaskDuration` as bench-height-pills.ts does. Rows: pan, pan with both trees mounted, local drag (whole frame), a drag of a token with two range rings and an aura, local and remote, a group drag of 4 and a mount with its rider at the caps, textured sides and walls at the caps, ping, switch, builder round trip, turn, and hex lines.

## 11. Cost

Every number is a draw-call median from the prototype on the stand-in (Chrome at 4x CPU, 390 by 844 at 2x pixels, software raster), never `TaskDuration`, which comes with ISO-2's bench. Appendix A has them all. In short, a typical scene's pan frame is about 2 ms over Top-down's. 500 tokens add 25 to 50% to Top-down's already slow frames. The caps pan at 1.4 to 1.6 times Top-down's. A switch with both trees costs one frame (48 ms at the caps) against a 194 to 332 ms remount. Textured sides and walls add about 9% at the caps.

**Gates**, in `TaskDuration` at 4x on ISO-2's bench: every frame kind (pan, pan with both trees, a whole local drag, a group or mount drag, remote drag, a ringed and aura'd drag, textured pans, ping, switch, builder round trip) at most max(16 ms, 1.75 times Top-down's same frame). A turn at the caps at most 150 ms whole. Hex lines on the 200 by 200 hex scene at most 2.5 times Top-down's.

**Target, unmet in the prototype:** the overlay under 16 ms wherever Top-down's is. It drew 19.7 against 15.8 at the caps. The way there is culling overlay decor and silhouettes by bucket bounds (5.7), measured before it is claimed.

**Kept, never per frame:** buckets with their bounds and patterns, seen sub-cells and sight darkness per tile object, wall pieces per chunk object, the silhouette set, the tints per cell, and the ground stage's canvas. Nothing animates at rest. The ground stage redraws only on a camera, map, fog, sight or still-mark change.

**Risks.** Software raster may overstate the copies and understate a phone's fill. Crossing a 128 px margin step reallocates a canvas. The depth order is approximate between snapped spots (5.6).

## 12. Security

- **The view never changes what a device receives.** It adds no event and no projection rule. The table display's `view` event keeps its audience, and its new `iso` field holds a turn and a size, nothing about the map. It depends on the DM's camera alone, each display fits only ground it may see (4.2), and `groundAtMiddle` reads no heights, so no point sent to another device carries terrain.
- **One new field**, `Scene.suggestedView`, set by the DM through `scene.update`, refused for players, sent with the scene. It names a view, nothing about the map.
- **A player's Isometric screen never shows more than Top-down's.**
  - By the stand rule (5.2), anything upright stands only over wholly revealed sub-cells, else lies flat under the fog, at every eased frame for ghosts and their tags. Party members and tokens every player sees stand always, as Top-down draws them above the fog.
  - Tops copy the ground stage, fog and sight included. Moving auras and tethers are clipped to revealed sub-cells. A side's tint reads only pixels wholly inside a fully revealed cell, as Top-down draws them.
  - Drawn heights, the standee base, the drag preview and `pickGround` read only seen ground. A base never subtracts hidden terrain, so different hidden heights draw the same pixels.
- **Two cell-level reaches remain, both shown today.** A column stands on a cell with any revealed sub-cell, so its faces reach up to one cell past the revealed part. The height readout already shows that cell's height (docs/design-v1-heights-readout.md 1). A wall run stands where either side's sub-cell is revealed, where Top-down already draws half the line.
- **Per-player vision:** each device reads its own fog and draws its own projection (per-player vision 6.6).

## 13. Lane plan

Order: after the hex grids' H1. ISO-1, then ISO-2 and ISO-5 beside each other, then ISO-3 and ISO-4 beside each other. Isometric stays unreachable (`isoReady` false in the view store) until an integration commit after ISO-2, ISO-3 and ISO-4 and their checks turns it on, followed by ISO-5's docs commit.

| Lane | Owns | After |
|---|---|---|
| ISO-1 Contract | `client/lib/view.ts` (`toView`, `toWorld`, `depth`, `ViewPoint`, `drawnGround`, `seenFootprintGround`, `pickGround`, `arrowStep`, `groundAtMiddle`) and tests, `client/lib/camera.ts`, `client/features/view/store.ts`, the camera scan test, `shared/model.ts`, `shared/protocol.ts` (with the `view` event's `iso`), `shared/migrate.ts`, `server/rooms/stateSchema.ts`, `shared/reducer/room.ts`, `shared/project.ts`, `shared/permissions.ts`, `server/rooms/undoLabels.ts`. One mechanical commit renames every camera call site to the view API with Top-down's identity and routes the hand-written sites through `groundAtMiddle`, every file in 4.1 (CameraLayer.tsx included) plus traps/paneBox.ts, lights/paneBox.ts, builder/tool.tsx, builder/labelPaneFrame.ts, builder/heights/tap.ts, fog/tool.tsx, display/DisplayRoom.tsx and scenes/FrameView.tsx, so trunk stays green | H1 |
| ISO-2 Ground and standees | `scripts/bench-iso.ts` (first commit), `client/canvas/Stage.tsx` (stages, drag layer, scheduler, layer routing, both trees, the controllers lifted out), `layers/MapLayer.tsx` (hex row spans), `TokenNode.tsx`, `TokenShadow.tsx`, `tokenShadow.ts`, `RemoteDrags.tsx`, new `client/canvas/relief/*` (pieces, runs, buckets, bounds, the stand rule, silhouettes, pits), `client/features/layers.ts`, `dm/CameraLayer.tsx` (as a controller), `builder/BuilderLayer.tsx` and `draw.ts`, new `builder/labelShape.ts`, `client/lib/theme.ts`, the texture patterns and cell tints | ISO-1 |
| ISO-3 Upright and moving marks | `measure/Pill.tsx`, `RulerLayer.tsx`, `RangeRingLayer.tsx`, `TurnStartLayer.tsx`, `movement/MoveLayer.tsx`, `pings/PingLayer.tsx` with its hold and its controller, `LaserLayer.tsx`, `pins/PinLayer.tsx` with its tap, `pins/rules.ts`, `attach/TetherLayer.tsx` and `areas/TemplateLayer.tsx` with their reminder controllers, `areas/AreaPreviewLayer.tsx`, `traps/TrapLayer.tsx`, `drawings/DrawingLayer.tsx`, `outliner/FlashLayer.tsx`, `canvas/useBoardText.ts`, `textBoxes.ts`, `boardView.ts` | ISO-2 |
| ISO-4 Input | Stage.tsx's pointer, tap, box, drag adapter, drag layer moves and nudge code and its anchors, `canvas/emptyTap.ts`, `builder/labelTap.ts`, `builder/labelPaneFrame.ts`, `LabelPaneHost.tsx`, `lib/group.ts`, `state/selection.ts`, `doors/tap.ts`, the slops and grab radii (6.1), `doors/DoorPill.tsx`, `heights/ReadoutHost.tsx`, `movement/StopNote.tsx`, `dm/camera.ts`, `dm/tableDisplay.ts` and `display/logic.ts` (the `iso` fit), `encounter/followTurn.ts`, `client/lib/camera.ts` (`keepInView`, `barShift` and `sceneMinScale` for Isometric, ISO-D14), the forced Top-down for the four tools | ISO-2, beside ISO-3 |
| ISO-5 Choice and docs | `client/features/view/ViewMenu.tsx`, `pages/RoomChrome.tsx`, `pages/Room.tsx`, `scenes/SceneSettings.tsx`, `display/DisplayRoom.tsx` (its menu), `state/shortcuts.ts`, `components/Icon.tsx`, `e2e/iso.e2e.ts`, alignment roots, the integration commit, then FEATURES.md and the docs | ISO-1, its last two commits after all |

ISO-4 stacks on ISO-2 for Stage.tsx. ISO-3's edits are mechanical and suit a lighter model. H3's brief adds hex columns and the hex walk (4.4).

**Docs to update:** FEATURES.md (Scenes and maps: an "Isometric view" subsection, Height and elevation, Walls and doors, Fog and vision, Building maps' Top-down line, The table display, This device, and the Shortcuts tables), docs/features.md (section 19's "Hex and isometric grids" later item), docs/design.md (13.3 and 14.2), docs/dm-guide.md (an Isometric view section with a screenshot, Suggested view, the four Top-down tools), and README.md's update note (reload open pages). New rows, in the Keys table `| I | Switch between top-down and isometric | everyone |` and `| Q, E | Turn the isometric view left, right | everyone |`, and in the Mouse and touch table `| Tap a standee again | Pick the one behind it, in isometric | everyone |`.

## 14. As built

Filled by each lane's docs commit, with every place the build went its own way, one real-phone spot check (a pan on the typical scene at 40 px, both views), and one canvas-memory check on a 2x tablet with both trees mounted.

### ISO-1 Contract

Nothing a user sees changes: `isoReady` is false, so every device shows Top-down. The phone and memory checks wait for ISO-2, which draws something to check.

- **Reloads (ISO-ASTRA-22).** Section 4.2's protocol line and section 7's Versions line say the version step forces an open page to reload. It does not: the client has no version check, so nothing reloads a page. A page open across the deploy, a table display above all, keeps its old strict schema and drops an Isometric DM's `view` event until someone reloads it. The op step's deploy note in shared/migrate.ts says to reload every open page, table displays included, and ISO-5 puts the same line in the README's update notes.
- **Versions.** Snapshot 25 to 26 and op 24 to 25, both identity steps, on top of the hex grids' H1. HX-1's test of its own numbers now asks for at least them.
- **The view API.** `View` is `{ kind: "topDown" }` or `{ kind: "isometric", turn }`, with `TOP_DOWN` and `isometric(turn)`. `ViewPoint` and `ViewBox` are brands that exist only in the types. `fitRect` and `rectClear` take a `ViewBox` (`viewBox(view, rect, lift)`), and `cameraForView` takes a `ViewPoint` and a zoom. `zoomAt` and `pinchCamera` keep their screen anchors, since no world point goes in. `keepInView`, `barShift` and `sceneMinScale` keep the scene's bounds, which stand for its box on screen in Top-down only. ISO-4 adds ISO-D14's ground clamp for Isometric beside them.
- **New helpers.** `cameraAt` (the camera that shows a view point at a screen point), `holdStill` (a turn or switch that keeps one world point put), `cameraOfStage` and `liveOfStage` (the only reads of a Konva stage's camera), `groundGroups` (the ground's two Konva groups and the upright group, pinned to `toView` within 1e-9 px), `heightsStand`, `drawnHeights`, `flatHeights` and `drawnBase` (4.3's base formula). `turnAxes` and `depth` take a turn, since only Isometric has depth.
- **`groundAtMiddle(live, insets?)`.** `Live` is the camera, the canvas size and the view, and `StageCamera` is now a `Live`, which the Stage publishes with `TOP_DOWN` until ISO-2 passes the shown view. Every site the rename routed through it keeps the whole canvas's middle, as before. The clear area's middle is there for ISO-4's keep-in-view, by passing the insets.
- **`viewFromCamera`, `focusFromStage` and `viewEvent`** take a `Live`. CameraLayer reads the stage through `liveOfStage`, whose `scaleX() || 1` meets the guards they already had, so the numbers are the same.
- **The rename's reach.** Besides section 4.1's files and section 13's list, the scan's patterns brought in `boardViewOf` (canvas/boardView.ts, its corners through `screenToView`), Stage.tsx's pan to an initiative row's token and Find my token's camera (both through `cameraAt`), and one call each in SceneSettings.tsx and stageCamera.ts. The codemod also renamed the call sites in files later lanes own: Stage.tsx, pins/rules.ts, DoorPill.tsx, StopNote.tsx, ReadoutHost.tsx and emptyTap.ts. Every remaining Top-down assumption is a `TOP_DOWN` at its call site, for the later lanes to find.
- **`pickGround`.** The walk clips the trace to the scene first, since the ground outside it is 0: a trace that reaches 0 before the scene hits there, and one that leaves the scene hits the outside ground's face or top. Its bound is 2√2·K·Δz + 3 cells, not + 2: a stretch of trace crosses at most one more cell line on each axis than its length along that axis. It also returns the height it met. On a hex scene it reads flat ground, since H1 refuses heights on hexes, until H3's hex walk.
- **`arrowStep`** is built and tested, and ISO-4 wires Stage.tsx's nudge through it.
- **The view store** holds the pick, the turns, `shownView` (Top-down while `isoReady` is false or a tool forces it) and `settledView` (a switch waits for any gesture in progress). ISO-4 and ISO-5 wire them.
- **Players** receive `suggestedView` in the scene copy as section 7 says, table displays too. The DM alone sets it.
- **Mutation checks.** Two mutants survive as equivalent: a near face entered exactly at its ground's height, which the top rule returns at the same point, and a walk that steps one axis at an exact corner crossing, where the ray passes through the corner itself and either reading names a cell that touches it.

### ISO-2 Ground and standees

Still nothing a user sees changes: Isometric shows only where a test or the bench sets the test flag before the page loads (`__rvttIsoTest`, features/view/choice.ts), which also gives them `__rvttIsoHook` (canvas/relief/isoTest.ts) to pick and turn as the View menu does. Top-down draws pixel for pixel as before, with one intended exception: a player's shadow of a flier over raised ground still under the fog falls as onto level ground (FLIER-SHADOW-FOG, below). The bench's parity images of all three scenes at two cameras match, before and after. At review round 1's tip one image, the caps at the far camera, differed on the GPU by at most 2 levels a channel, inside the textured floors only, and matched with Chrome's 2D canvas on the CPU, as it matches on the GPU again at round 2's tip. So the GPU sampled the shrunken textures differently, and what is drawn is the same.

- **Two stages and one scheduler** as 5.1 has them (canvas/relief/IsoBoard.tsx, scheduler.ts). The ground stage's margin follows the highest drawn lift on the scene, not in view, in 128 px steps. The scheduler counts frames and draws for the tests, and the bench does not read them yet.
- **Both trees.** Top-down's tree is held still while Isometric shows (`Frozen` in Stage.tsx), its Stage at 0x0, and Isometric's the same way (`IsoBoard` memoized on `hidden`). A memo stops only renders from above, and a layer that reads a store re-renders past it, so a hidden tree's stages are also hidden (`visible` false) and skip the draws those layers still ask for. Ghosts and token shadows read no drag in a hidden tree (`TreeShownContext`, relief/context.ts). The hidden isometric board keeps its last read of the room (`useShownView`), and so does every part drawn in both trees that rebuilds from the build: the build's paths, an area's coverage, the trap marks and the token shadows (`useTreeShownView`). A brush stroke in Top-down then walks no walls, heights, buckets or paths in the hidden tree, and a unit test holds every renderer placed in Isometric to that. Other lanes' layers still re-render there on their other stores, and ISO-3 can stop them the same way. The map image loads once above both trees (`SharedMapImage`, layers/MapLayer.tsx), so both draw one decoded bitmap, and only the tree on screen reports its progress. The loader frees a bitmap once the next settles, so a frozen tree still on the old map draws nothing and keeps no image (`treeMap`, layers/sharedMap.ts), and the side tints read a map image only while the loader still holds it (`mapReadable`, useImage.ts). A tint that cannot be read is the neutral tone. A map removed from its scene is read no more: the tints let go once the loader has no map to load, and the loader frees the last bitmap then rather than holding it until the next map. The controllers mounted once outside both are CameraLayer, now `CameraController` reading the camera it is given, the scenes' thumbnails, the trap alerts' toasts and sound (`TrapAlerts`), the DM's teleport toasts (`TeleportToasts`), and one clock that eases every remote drag (`RemoteDragClock`). A unit test reads the sources: every renderer whose code reaches an effect, through the hooks it imports as well as its own, is "off" in Isometric, but for three hooks a second run leaves unchanged (`usePublishPills`, `useLiveTokens`, `useTextures`), and the controllers mount once, before either tree.
- **Renderers left off until their controllers move (ISO-3).** Areas, tethers, pings, pins, rulers and the laser run effects in their components (reminders, sound, listeners, the laser's frame clock), so they draw in Top-down's tree only for now, and not in Isometric. Light reach, stamp handles, height marks, the fog draft and Line up grid are off as section 5.3 says, their tools being ISO-4's forced Top-down. Area previews, movement paths and the outliner's flash draw as moving marks in the drag layer, flat on the ground plane, until ISO-3 lifts them by their drawn height. Range rings, turn start and the explored outline draw on the ground stage. The overlay draws any layer placed upright, none yet, so ISO-3 can move a layer there with no change to the board.
- **Camera framing** reads the view shown: the fit (the scene's corners at 0, without the lift ISO-4 adds), a starting view, the DM's Look here, an initiative row's pan, and the action bar's anchor (under the ring, without heights). A switch or a turn keeps the world point at the canvas's middle still (`holdStill`). The board's gestures attach to the stage on screen. Pointer points, taps and keep-in-view are still Top-down's math, for ISO-4.
- **The drag layer** holds other members' drags with their tags and the moving marks, not the overlay as 5.1 has them, so a ghost's frame redraws none of the overlay's text: with them in the overlay, the bench's remote drag took 25 ms against its 22 ms budget, its labels' text the largest part. The overlay keeps silhouettes, decor and upright labels. What a local drag moves comes into the layer's own empty group at ISO-4, and until then a local drag redraws the relief.
- **Standees** (TokenNode.tsx `Standee`): the art upright, its ring 25% black with the disposition's outline, a facing tick, a shadow ellipse on the drawn ground and a 1 px stem, dashed where the lift is capped (the break mark), a rider half its holder's art height up and inset when it covers the holder. One shape (`standeeShape`, relief/standee.ts) gives the drawing, the decor, the silhouette and the culling the same boxes: the base as drawn, lowered where the lift is capped and kept apart from the logical base, and a rider's seated art. Standees draw over the sight overlay's shading, which Top-down draws over the tokens under it, so for a player a standee in dim sight looks brighter. That shows nothing more: on a vision scene the server sends no token out of sight. Top-down's drifting shadow stays on flat creatures. Decor lays out on a footprint-sized frame standing where the art stands, as Top-down's does on the token's box, and a flat creature's on a box the token's size centered on its diamond: the diamond's own view box waits for ISO-3's view-space label layout.
- **The stand rule's boxes** for a creature are its drawn body, turned by its rotation as Top-down turns its art and clip (a rectangle for an object, an ellipse otherwise), and the rules' footprint (snapped, squeezed while it squeezes), each wholly revealed, so it fails closed whichever a later change draws. A flat creature draws on the ground stage under the fog and takes presses through an invisible footprint on the relief.
- **Ghosts.** A standing ghost stands at 0.6 at the drop's landing on the ground this viewer has seen (`previewLanding`, relief/seenChunks.ts), as this device's own drag and its shadow do. Its tag stands over its art only when the whole pill Top-down draws for it at this zoom is revealed, anywhere its slide can put it (`ghostTagStands`, relief/stand.ts). A flat ghost draws clipped to the revealed sub-cells of its box, and its tag is left out rather than clipped. That shows less than 5.2 allows, never more.
- **Walls.** Neighboring standing runs merge only where they touch, so a cell can hold two pieces of one segment with a fogged run between them. Pillars stand as stone drums `WALL_RISE` high, by the stand rule over their cell. A secret door not yet found stands as a wall, its mark staying flat for the DM. A wall on a scene's east or south edge at a multiple of 16 cells goes to the bucket inside the scene, and a bucket's signature holds the scene's size, so a resize rebuilds what it straddles.
- **Stairs** draw their risers as sides. Connected stair edges still draw a face.
- **Side tints (ISO-FR-R4-1)** read the map image Top-down draws, the asset's full or phone copy, through a 1:1 copy of the pixels wholly inside each cell, as section 5.5 says, and never `scene.thumb` or the asset's thumbnail. A table display fetches and draws that same image, so it can tint too. Tints are read with each bucket's build and kept per cell for the life of the image (ISO-FR-R5-1).
- **Not yet:** sides and walls keep no sight darkness, and the DM's dimming reads the players' fog, not the party's sight. A bucket rebuilds per chunk and its neighbors, and standees are tested one by one for culling rather than kept in buckets, which the bench shows is cheap at 500 tokens.
- **Map labels** stand on their anchor at the drawn ground, drawn in the box `labelShape` gives them (builder/labelShape.ts), which ISO-4's tap reads too. The board splits them once by the stand rule, and again when the board's font loads since the fallback's widths no longer hold (`labelSplitter`), and the build on the ground stage leaves out what stands by id (`IsoGround.uprightLabels`), with walls and pillars through draw.ts's `standing` option.
- **Staged for later lanes, with no caller yet:** `lineStands` and `lineSubcells` (relief/stand.ts) for ISO-3's tethers, and `hexesInView` (layers/hexSpans.ts) for HX-2's hex lines.
- **Hex row spans** are `hexesInView` (canvas/layers/hexSpans.ts). No hex lines draw on the client yet (HX-2), so the hex row of the bench waits for them.
- **Flier shadows (FLIER-SHADOW-FOG).** A player's token shadow reads the build through `seenChunks` (relief/seenChunks.ts), where every fully fogged cell's height is 0, as the height readout reads it, still and while dragged. This changes Top-down too, as intended: a player's shadow of a flier over a fogged platform falls as onto level ground.
- **Bench** (scripts/bench-iso.ts): `TaskDuration` at 4x CPU on the 390 by 844 stand-in at 2x, medians in ms of each step (one input and the frames it draws), from two rounds of this lane's tip after review round 1, Top-down and Isometric taking turns on one machine under the same load. Every gated row is inside max(16 ms, 1.75 times Top-down's) in both rounds but one, the builder's round trip in one round (below). Top-down's medians sit within the earlier rounds' noise.

| Frame | Top-down | Isometric | Budget |
|---|---|---|---|
| pan, typical, 40 px | 10.2, 10.9 | 15.5, 16.7 | 17.8, 19.1 |
| local drag, whole frame, typical, 40 px | 9.6, 10.3 | 11.2, 10.6 | 16.9, 18.0 |
| local drag of a token with two range rings and an aura, typical | 11.7, 11.8 | 15.3, 14.7 | 20.4, 20.6 |
| remote drag of the ringed and aura'd token, typical | 16.3, 17.6 | 16.3, 14.6 | 28.5, 30.7 |
| ping, each frame of its animation, typical | 3.0, 2.8 | 0.3, 0.4 | 16.0, 16.0 |
| a round trip to the map builder, each way, typical | 56.9, 63.7 | 114.5, 104.5 | 99.5, 111.6 |
| pan, caps, fit | 10.4, 9.2 | 13.7, 13.5 | 18.2, 16.1 |
| pan, caps, 40 px | 18.3, 15.5 | 14.3, 15.7 | 32.1, 27.2 |
| group drag of 4, caps, 40 px | 13.9, 13.0 | 10.1, 10.1 | 24.3, 22.7 |
| a horse with its rider dragged, caps, 40 px | 13.6, 13.5 | 9.8, 10.3 | 23.9, 23.7 |
| pan, 500 tokens, 40 px | 119.6, 116.0 | 105.9, 101.7 | 209.4, 203.0 |
| local drag, whole frame, 500 tokens, 40 px | 84.3, 83.0 | 28.8, 27.8 | 147.5, 145.3 |
| turn, caps, 40 px | - | 34.0, 30.6 | 150 whole |
| switch, caps, 40 px, both trees mounted | - | 52.9, 48.3 | none |
| pan, caps, 40 px, both trees mounted | - | 15.0, 13.7 | none |
| a brush stroke's step from another device of the DM's, caps, 40 px: Top-down alone, then with Isometric mounted and hidden | 84.2, 82.7 | 84.6, 85.6 | 147.4, 144.8 |

The caps' rooms wear the builder's textures, so their pans are the textured pans. Isometric is cheaper than Top-down where it culls: its relief draws only the standees in view, which a 500-token drag shows most. Pings, rulers and areas are off in Isometric until ISO-3, so the ping row times nothing there yet. The builder shows Top-down since ISO-5 (section 6.4), so in Isometric its round trip now holds a view switch each way. One round is over its budget (114.5 against 99.5) and the other inside it (104.5 against 111.6), as both rounds before this lane's last fix were (83.9 and 110.2). A switch alone costs about 50 ms, so this row stays near its budget until a switch costs less. A turn's first visit at the caps costs up to 141 ms, sorting its buckets for that turn, and later visits 21 to 39 ms, from the profile before review round 1, whose fixes change no turn. Each round's turn row also holds one step of 231 and 244 ms, where that profile found the icon index's one-time parse and sort (features/images/icons.ts, about 108 ms at 4x) landing in the window, not the turn. With other members' drags in the overlay, as 5.1 first had them, the remote drag took 25 ms against a 22 ms budget, which is why they moved to the drag layer. A switch costs one frame of 48 to 53 ms, the prototype's 48. A pan with both trees mounted costs what a pan with one does. A brush stroke's step at the caps, sent from another device of the DM's, costs the same in Top-down alone and with the isometric tree mounted and hidden. Before the hidden tree kept its last read of the build, it cost 148.3 and 145.8 there against 93.3 and 91.3 alone.

- **The phone and memory checks.** No real phone was at hand, so the spot check waits for ISO-5's integration. Canvas memory on a 2x tablet stand-in (1024 by 1366 at 2x) on a 40 by 30 scene: Top-down alone holds 58.0 MB of scene canvases and 10.9 MB of hit canvases, Isometric with both trees mounted 60.8 and 7.3, and Top-down again with both mounted 58.0 and 10.9, the hidden stages at 0x0 holding nothing. With a map image on that scene (the cavern battlemap, 16 MB decoded), the page holds one decoded bitmap with both trees mounted, where each tree loaded its own before. A switch there and back draws each view the same as before it, pixel for pixel.
- **The view's hooks for ISO-5.** The board draws `useRoomViewChoice().shown`, and a table display's MapStage takes the display's own choice through a `view` prop. While this device drags a token the board sets `viewGestureSlot`, so a new suggestion or a turn waits for the drop. A pinch and a held ruler join it in ISO-4. The test flag's hook (`useIsoTestHook`) only picks and turns now, since the choice reads the flag itself. Top-down's stage stays first in the page and hidden while Isometric shows, so a test that waits for the board must wait for the visible one (`.filter({ visible: true })`), as iso.e2e.ts does.
- **Mutation checks.** Three mutants survive as equivalent: a hex row span that starts one hex later, which is exactly the tight bound where the code keeps one hex of slack, a footprint ellipse with its axes swapped, the same box at every turn since each turn's axes lie at 45 degrees, and an edge wall filed one bucket further in, which still lays out and culls by its own bounds.

### ISO-3 Upright and moving marks

Still nothing a user sees changes: `isoReady` is false, and Top-down draws as before (the parity check below). Isometric shows through the test flag, as ISO-2 left it.

- **Controllers (ISO-D15).** Five more mount once outside both trees, each in a file of its own beside its layer: `PingController` (a ping's tone and buzz, the select tool's hold-to-ping, and the one frame clock pings and the laser animate by, `frameClock.ts`), `PinController` (a tap on a pin, its popover's timer and its closing on a selection), `RulerController` (this device's own drag, heard from the stage's drag events into a store the ruler layer reads), `AreaController` (the area reminders and the selection count) and `TetherController` (the falling off reminder). A controller that listens to presses or drags needs the stage on screen, so `ControllerProps` gained `stage`, and Stage.tsx keeps Top-down's stage as state beside the ref and passes whichever stage shows: the one change there. The source scan holds each moved layer to having no effect, and each controller to running its hooks itself. A walking ruler's search and its "Finding the way" timer run per tree, as `useWalkMeasure` and `useDelayed` feed only their own tree and a hidden tree holds the ruler they measure, so the scan lists them with the three hooks ISO-2 allowed.
- **A layer in several places.** `LayerDef.iso` may list places, and each part reads its own through `IsoGround.place`, which IsoBoard now provides on the drag layer and the overlay too, with `ground(x, y)`, the drawn height under a point. `IsoParts.tsx` holds the pieces every layer draws with: `Lift` (cells at a drawn height, lifted in the drag layer and carried onto a lifted plane from the overlay, as they are on the ground stage), `Upright` (view units from inside the plane), and `MarkPill` and `MarkPillStack` (a pill upright at its point's drawn height, and flat on the ground stage without its slide along the screen's edge, which means nothing there). In Top-down each is its children or today's pill.
- **Moving marks stay in the drag layer**, where ISO-2 put them, not the overlay that 5.1 and 5.3 name: a ping's or a laser's frames then redraw the ghosts' layer, not the overlay's text. Each is lifted by its drawn height: a ping at its point, an area being aimed at its origin, the outliner's flash at its middle, the hold ring and the stopped drop's ghost at the drawn ground under the token. Rulers, the laser and a drag's path are lines in view space between points each at its own drawn height, so a leg across raised ground cuts through it rather than draping. A drag's label stack hangs off the middle of the footprint it would land in, since the bottom right corner Top-down uses points nowhere useful at most turns. The stroke being drawn with Draw moves in the drag layer too, so drawing never redraws the ground stage.
- **Pins** stand on the overlay wherever they are, since Top-down draws a pin above the fog, with the tip at the drawn ground under it (`pinTip`), which reads only ground this viewer has seen. The pin controller's tap finds a pin there.
- **The stand rule's new things** (`markStand.ts`): an area's or a trap's name by its pill's reach with its outline, a trap's badge by its disc, outline and eye (`traps/badge.ts`), a text drawing by its lines grown by the ink and halo Konva draws past them (`drawings/textBox.ts`). A plain pill, which slides anywhere at the screen's edge, never stands over a player's fog. An upright text drawing stands on the middle of its Top-down box, as a map label stands on its anchor. Ring labels and the turn's pill stand always, as Top-down draws them above the fog.
- **A dragged token's marks** (`DragMarks.tsx`): its range rings, attached areas and tethers leave the ground stage while it is dragged, here or elsewhere (`draggedIds.ts`), and draw on the overlay, each at the drawn ground under the token's footprint where the drag would drop it, not at a flier's base, so they read as the ground marks they become at the drop. Rings draw whole. An aura draws clipped to the revealed sub-cells of its covered window grown by two cells, and a tether to the revealed sub-cells it crosses, at the moving end's ground. An aura's name that does not stand is left out while it moves, showing less, never more. `DragMarks` takes the token ids and draws in view space under whatever group it is mounted in: IsoBoard mounts one on the overlay with every drag's ids, and ISO-4's last commit can mount a second in the drag layer with this device's own once its standee moves there (ISO-4 did: see its As built, "One pick, stacked on ISO-3", and its review round 1 for the aura's and the tether's clip). On the ground stage the still areas read where tokens stand, not where drags would drop them, so a drag changes nothing there, and a dragged token's ring in another, still area waits for the drop.
- **Hidden trees** read nothing: every layer here, `useLiveTokens` and the frame clock read through `useTreeShownView` or the new `useTreeShownStore` (relief/context.ts), and a source test holds them to it.
- **Still rings and tethers keep their shapes (ISO2-RANGERING).** A ring's scene function is made once per shape (`ringScene.ts`) and its dash is one array, a tether's points and dash are memoized, and a still area's shading and the area itself are memoized, so a render for another token's drag hands Konva nothing new. The bench counts the ground stage's draws while the scout crosses cells.
- **Labels' ink (ISO2-FV-7).** Measured in Chrome with Inter at 700: on drawLabel's middle baseline accented capitals reach 0.70 em above the anchor and descenders 0.535 below, and a letter's ink 0.035 em past its advance, with the 0.08 em halo beside. `labelStands` tests the box from 0.8 em above to 0.7 below, 0.04 em wider each side (`LABEL_INK`), and leaves the shared `labelBox` as it was. The same class of gap was in pills, whose 1.5 px outline lies half outside their box, so the stand rule counts it for names and, in stand.ts, for a ghost's tag.
- **The hidden board builds no buckets (ISO2-OPUS-12).** While hidden its relief does not sync, so a map changed in Top-down, whose tints go and come back, rebuilds nothing until the board shows, and then once.
- **The hold-to-ping** pings at `pickGround`'s point on this viewer's drawn heights (`boardPick.ts`), built once per hold. PingController marks the one line where ISO-4's pick (`pressAt(boardPickOf(...), screen)`, 6.2) takes over once it is stacked.
- **Not yet:** token labels, chips and plates still lay out in Top-down's pixel boxes (`useBoardText`, `textBoxes.ts`), not the view space boxes 5.4 names, so in Isometric a name can sit over another standee, and an area's name keeps off token boxes in world cells. The layout's inputs come from Stage.tsx, which ISO-4 owns, so it moves once ISO-4 is stacked: the isometric board lays out its own pass from the standee boxes, the published pills and the standing map labels in view space. Pointer points for rulers, areas and drawing are still Top-down's math until ISO-4, so a ruler measured in Isometric starts where Top-down's math puts the press. Superseded by ISO-4: token labels lay out in view space ("Token labels in view space (5.4)"), and every press reads `boardPick` (its As built and review round 1).
- **Bench** (scripts/bench-iso.ts): `TaskDuration` at 4x CPU on the 390 by 844 stand-in at 2x, medians in ms of each step, from two rounds at this lane's tip, Top-down and Isometric taking turns on one machine under the same load. Every gated row is inside max(16 ms, 1.75 times Top-down's) in both rounds but two: the builder's round trip in both, as for ISO-2, and the typical pan in one round by 0.1 ms (below). The ground stage rows count draws, not time.

| Frame | Top-down | Isometric | Budget |
|---|---|---|---|
| pan, typical, 40 px | 10.2, 12.3 | 18.0, 16.1 | 17.9, 21.5 |
| local drag, whole frame, typical, 40 px | 9.4, 11.0 | 12.0, 11.7 | 16.5, 19.3 |
| local drag of a token with two range rings and an aura, typical | 10.7, 11.9 | 16.0, 14.2 | 18.7, 20.8 |
| remote drag of the ringed and aura'd token, typical | 15.2, 17.0 | 14.6, 14.9 | 26.5, 29.7 |
| ground stage draws while the ringed and aura'd token is dragged here across cells | - | 0, 0 | none |
| ground stage draws while another member drags it across cells | - | 0, 0 | none |
| ping, each frame of its animation, typical | 2.7, 3.3 | 1.6, 1.5 | 16.0, 16.0 |
| a round trip to the map builder, each way, typical | 61.1, 56.2 | 119.3, 105.1 | 106.9, 98.3 |
| pan, caps, fit | 9.8, 9.0 | 14.7, 12.8 | 17.2, 16.0 |
| pan, caps, 40 px | 17.4, 15.7 | 15.7, 15.2 | 30.5, 27.4 |
| group drag of 4, caps, 40 px | 13.9, 11.9 | 11.8, 11.0 | 24.3, 20.9 |
| a horse with its rider dragged, caps, 40 px | 13.0, 12.1 | 11.8, 10.9 | 22.7, 21.2 |
| pan, 500 tokens, 40 px | 104.6, 111.1 | 98.1, 100.6 | 183.1, 194.4 |
| local drag, whole frame, 500 tokens, 40 px | 75.7, 82.4 | 32.0, 31.5 | 132.5, 144.2 |
| turn, caps, 40 px | - | 30.3, 31.1 | 150 whole |
| switch, caps, 40 px, both trees mounted | - | 55.1, 50.9 | none |
| pan, caps, 40 px, both trees mounted | - | 13.8, 16.0 | none |
| a brush stroke's step from another device of the DM's, caps, 40 px: Top-down alone, then with Isometric mounted and hidden | 82.9, 81.9 | 85.7, 84.2 | 145.1, 143.4 |
| a map image set and taken away from another device of the DM's, caps, 40 px: Top-down alone, then with Isometric mounted and hidden | 29.1, 26.5 | 28.7, 32.6 | 50.9, 46.3 |

Pings, rulers and areas now draw in Isometric, so the ping row times real pings there, cheaper than Top-down's since their frames redraw only the drag layer. The typical pan's 18.0 in one round is noise, not this lane: timed twice more at ISO-2's tip and twice at this one, back to back, it took 16.0 and 16.4 there and 16.3 and 15.8 here, and ISO-2's two rounds took 15.5 and 16.7. The builder's round trip holds a view switch each way, as ISO-2 found, and stays near its budget until a switch costs less. Neither ground stage row draws: a drag redraws the ground once at its start, as the marks leave it, and once at the drop, as they come back, and never as it crosses cells. The map row sets the map while Isometric shows and then swaps it from another device in Top-down. Before the hidden board stopped syncing its relief, that row took 83.6 ms there, its 15 syncs rebuilding 2535 buckets in 537 ms. After, it took 33.8 ms, with no sync while hidden and one of 169 buckets (11 ms) when the board shows.

- **Top-down's parity.** The bench's parity images of all three scenes at two cameras match ISO-2's tip pixel for pixel.
- **The phone and memory checks.** No real phone was at hand, so the spot check still waits for ISO-5's integration. This lane adds no stage, layer or canvas: every mark draws in the ground stage, the drag layer or the overlay ISO-2 measured, so canvas memory was not measured again.
- **Mutation checks.** One mutant survives as equivalent: a text drawing's box without its halo term, which the 0.3 em ink pad already covers (the ink reaches 0.14 em past a line, and the halo another 1/28 em). A layer that calls a controller's hook without importing it passes the source scan, and the typecheck fails it.

### ISO-4 Input

Still nothing a user sees changes, since `isoReady` is false. Top-down reads every press, slop and camera as before, and draws as before (Parity, below).

- **One read of the board (`boardPick`, canvas/boardPick.ts).** The Stage publishes the board as it draws it (`boardPickSlot`): the camera, the view shown, the drawn heights and their source. Every tool reads a press through it: `pressAt` is `pickGround`, and `pressGap` is the screen distance every slop and grab radius compares. In Top-down `pressGap` is the world distance times the scale, as it always was, and in Isometric a point at its drawn ground, or at its own height, through the view. For a player on a fogged scene the source is that player's fog, so a press reads only seen ground. The drawn heights are made again only when the build, the fog, the scene's size or the stand threshold changes (`DrawnHeightsMemo`), so a pan or a zoom reads the same ones.
- **Doors** are reached within the slop on screen by their line on the higher drawn ground beside the door's middle, which is where relief/runs.ts stands its piece, or by a closed door's piece, a band swept up the screen `WALL_RISE` high while heights stand. The door pill hangs over the piece's top, or over the line's middle for an open door and below the threshold. The search box grows by the piece's reach, which `doorsNear`'s 4-cell padding already covers, so that mutant survives as equivalent.
- **Labels.** A label standing up is reached by `labelShape`'s view box on screen, with the slop. One lying flat is reached by the world point under the press, as in Top-down, since `pickGround` already lifts that point with the column tops. The label pane frames the label as the board draws it (`LabelLook` through `labelScreenBox`).
- **Rulers, areas and polygons** reach their handles by `pressGap`, each at its drawn ground: a ruler's last stop, an area's handles and a polygon's first point. Draw's eraser keeps its world radius.
- **Tap again** walks the relief's standee nodes from the last drawn to the first, each hit first by its box on screen, then by Konva's hit canvas (`frontToBack`, `nextUnderTap`). It walks only when the selected token is under the press, so a tap on any other standee takes the front one as before. Shift, Ctrl and Cmd add or remove the front one.
- **Box select** takes a token when its ring's center on screen lies in the box (`tokensByCenter`, `ringCenter`).
- **The empty tap** hands its press's screen point to the label, door, height readout and pin tests, which read `pickGround`'s point for everything lying on the ground.
- **Hold to ping** pings at `pressAt(boardPickOf(...), screen)` in ISO-3's PingController.ts, the press read as every tool reads it.
- **The drag adapter** (canvas/isoDrag.ts) is section 6.3's, with one change: a flier over ground higher than its base scans by its own landing rule, the higher of its base and the ground, with its base among the heights tried. The walker's scan there would put it on the first lower roof under the finger and drop it below its base, which the drop never does. A rider's seat is the drop's own (`seenSeat`, now exported from movement/drop.ts), read from this viewer's copy. A test rides within a mount straddling a 10 ft ledge, kept at 10 ft, and off its low half to the ground (ISO-OP-34).
- **The standee's base mid-drag** reads the drop's landing on seen ground for every token this device drags, a kept seat first, then the holder's footing (`previewLanding` with `seenSeat` in relief/IsoBoard.tsx), and a rider whose holder moves with it rides at the holder's landing. The adapter and the preview read the same landing, so the ring stays under the finger as the standee climbs.
- **The drag layer.** On dragstart the Stage moves the pressed standee, its followers and their carried riders into the drag layer's ground group (`dragGround`, canvas/dragLayer.ts), in the order they drew, and on the drop or a cancel puts each back before the nearest sibling that followed it and is still there, else after the nearest that preceded it. A standee this device drags carries its own decor upright (TokenNode.tsx), as the overlay draws it for the rest, so the decor travels with it. Its rings, auras and tethers (ISO-3's `DragMarks`) draw in the drag layer under the standees it moves, from the spots the drag writes, and come back to the ground stage with the drop or a cancel. Other members' drags keep theirs on the overlay. So each frame of this device's drag redraws the drag layer alone (ISO-31).
- **One pick, stacked on ISO-3.** ISO-3's own `boardPick.ts` helpers (`pickOnBoard`, `drawnSourceOf`) gave way to this lane's: the hold to ping, a pin's tap (PinController.ts) and the empty tap's and the height readout's pin tests all read `boardPickOf`, a pin where it stands (`viewGround`). Those two pin tests read a flat pin before, so a readout could open under a pin standing on a platform.
- **Token labels in view space (5.4).** The isometric board lays token names, chips and plates out again (`useBoardText` with `place`, relief/isoText.ts): each token's box is its decor frame where its art stands, its ring an obstacle below it, and a name below a standee hangs under the ring, as a plate does. They keep off the published pills where the board stands them, at the drawn ground under their point, and off the map labels by their ink (FV-7's `LABEL_INK`), standing or lying by the stand rule. Token decor itself stays above the fog as 5.2 has it. The action bar hangs under the label as drawn (`footPx`, the ring's bottom). A pan lays out nothing, and a drag's start lays nothing out again, its frames being the same. Top-down's layout is unchanged and still runs beside it.
- **Keys.** The nudge goes through `arrowStep` (`nudgeStep`).
- **Camera.** `keepInView` and `barShift` in Isometric clamp the ground at 0 under the clear area's middle into the scene, and a camera already past it may come toward it but never go further (`GroundMap`, lib/camera.ts). `sceneMinScale` reads the scene's view box with its lift. The fit takes the view box at 0, then fits again with the highest drawn ground inside the target (`liftIn`). A turn or a switch keeps the selected token's ring still while it shows in the clear area, else the drawn ground under the clear middle (`heldPoint`), raised by its drawn height in the view before and after. A pan to a world point (a starting view, Follow me, Bring everyone here, Look here, follow the turn) centers that point at the drawn ground under it, not at 0, and Find my token and an outline row's focus frame their target's view box.
- **Anchors** (canvas/anchors.ts). The action bar, the stop note and the token's rise read the ring's bottom and the art's top at the token's drawn base. The height readout hangs at its cell's drawn ground.
- **Follow the DM.** The event and the fit are 4.2's. The downward search raises a column by its own drawn ground only, not by the walls standing on it. A display at the DM's turn frames the DM's rectangle exactly.
- **Gestures.** Any pointer down on the map holds a new suggestion or turn (`viewGestureSlot`), not only a pinch and a held ruler: ISO-D3 says a switch waits for any gesture in progress, and a one-finger pan is one.
- **Files outside the lane, each a small change:** relief/IsoBoard.tsx (the drag layer's group name and the moved standees' base), TokenNode.tsx (a dragged standee's decor), relief/standee.test.ts (its count of `drawnBase` readers), movement/drop.ts (`seenSeat` exported), builder/heights/tap.ts and LabelPane.tsx (the press's screen point and the label's look passed on), state/types.ts and state/ephemeral.ts (a display keeps the event's `iso`), display/DisplayRoom.tsx (the display's camera reads its view and seen heights), and canvas/fitSlot.ts, find/findToken.ts, pages/RoomChrome.tsx and outliner/focus.ts (Find my token's view). Stacked on ISO-3: pings/PingController.ts and pins/PinController.ts (the board's pick), DragMarks.tsx (its comment), canvas/useBoardText.ts (`place`, `footPx` and the layout as a plain function), relief/standee.test.ts (its frame scan reads `decorPlace`) and iso.e2e.ts's ISO-31 (a local drag's ring in the drag layer).
- **Not yet.** A flat creature hidden under the fog that this device drags keeps its picture where it was until the drop, as ISO-2 draws it. The phone spot check waits for ISO-5's integration, as ISO-2's does. Canvas memory is ISO-2's: the drag layer moves nodes and makes no canvas. The layers under the decor still keep off token labels by Top-down's boxes (`labelBoxes`), so in Isometric an area's name keeps off them in world cells.
- **Tests.** Units for the press, the gap, the ring, the memo and the held point (boardPick.test.ts), the adapter (isoDrag.test.ts), the drag layer, the anchors, doors, labels, tap again, box select, the camera's ground clamp, Find my token, the display event and fit. Security: two scenes differing only in heights under a player's fog give that player the same picks at every turn, the same drag landings, a flat label and the same display fit. iso.e2e.ts adds ISO-40 to ISO-45: a player's walker up a revealed platform and a Large across a ledge, each in the drag layer, a tap again through a stack, arrows at each turn, the builder's Top-down and back with the selected token in place, a label's pane on a platform, and a held ruler holding a new suggestion.
- **Mutation checks.** 53 mutants, 52 killed and one equivalent (the door search box above), and two more against e2e builds, both killed (a local drag's marks on the overlay fails ISO-31, Top-down's label offsets on the standees fail ISO-46): the grab offset, the footprint scan for the center ray, the kept seat, the holder's footing, the scan's order and its at-or-above step, a flier's scan, a token inside rising, footing on real heights, the front-to-back walk, the tap-again order and its wrap, box select, the ground clamp and its memory of a camera past it, `barShift`'s ground, a player's fog in picks and in the memo, the gap at the drawn ground, the held point both ways and its height, the nudge, the fit's lift, the doors' piece, line and slop, the label's ground and its fog, both anchors, the drag layer's way home and its order, Find my token's view, the display's seen heights, its downward search, a column's raised top, the same-turn frame and the event's size and `iso`, the pin tests lying flat and `viewGround` at 0, and the label layout ignoring its place, its ring as an obstacle, a name below the ring, `footPx`, a standing map label's ink, a pill's ground and a standee's frame.
- **Bench** (scripts/bench-iso.ts), as ISO-2 ran it: two rounds, this lane's base (ISO-2's tip) and its tip taking turns on one machine, medians in ms. Every gated row is inside its budget in both rounds, the builder's round trip among them. Top-down's rows match the base's within the noise of the rounds.

| Frame | Top-down | Isometric | Budget | Isometric at the base |
|---|---|---|---|---|
| pan, typical, 40 px | 10.1, 10.4 | 16.2, 17.7 | 17.7, 18.2 | 18.6, 15.5 |
| local drag, whole frame, typical, 40 px | 9.9, 10.7 | 9.1, 12.4 | 17.4, 18.7 | 11.7, 12.6 |
| local drag of a token with two range rings and an aura, typical | 12.7, 12.9 | 12.2, 10.8 | 22.3, 22.6 | 16.6, 14.9 |
| remote drag of the ringed and aura'd token, typical | 16.4, 17.0 | 17.1, 16.4 | 28.6, 29.7 | 14.0, 13.5 |
| ping, each frame of its animation, typical | 2.6, 2.8 | 0.5, 0.4 | 16.0, 16.0 | 0.3, 0.2 |
| a round trip to the map builder, each way, typical | 62.8, 54.5 | 90.6, 88.9 | 109.9, 95.4 | 124.2, 131.2 |
| pan, caps, fit | 9.3, 9.7 | 13.3, 15.0 | 16.3, 16.9 | 13.6, 16.3 |
| pan, caps, 40 px | 15.9, 15.3 | 13.8, 16.9 | 27.8, 26.8 | 14.1, 19.5 |
| group drag of 4, caps, 40 px | 12.6, 11.8 | 7.4, 6.9 | 22.1, 20.6 | 9.5, 13.1 |
| a horse with its rider dragged, caps, 40 px | 12.7, 11.9 | 7.8, 9.2 | 22.2, 20.7 | 9.7, 12.5 |
| pan, 500 tokens, 40 px | 121.6, 102.9 | 108.3, 112.1 | 212.8, 180.1 | 98.4, 115.8 |
| local drag, whole frame, 500 tokens, 40 px | 86.6, 82.9 | 5.5, 5.7 | 151.5, 145.0 | 27.1, 34.2 |
| turn, caps, 40 px | - | 35.0, 30.6 | 150 whole | 31.0, 37.0 |
| switch, caps, 40 px, both trees mounted | - | 56.5, 46.2 | none | 48.7, 62.8 |
| pan, caps, 40 px, both trees mounted | - | 14.7, 12.8 | none | 14.2, 18.6 |
| a brush stroke's step from another device of the DM's, caps, 40 px: Top-down alone, then with Isometric mounted and hidden | 82.6, 82.3 | 84.5, 82.2 | 144.6, 144.0 | 87.3, 90.3 |

The drag layer is where a local drag now draws: a frame of a 500-token drag redraws the moved standee alone, 5.5 ms against 27 to 34 at the base, and the group and the horse drop by a quarter or more. The builder's round trip holds no drag, so the drag layer does not move it. It came in at 90.6 and 88.9 against the base's 124.2 and 131.2, both of those over budget in the same rounds. That saving was not profiled. The switch alone did not get cheaper, so it lies in the builder's part of the trip, where this lane's one change is the camera: the switch's held point and the ground clamp in place of Top-down's clamp on an isometric camera. Another member's drag came in about 3 ms above the base in both rounds, inside its budget. No code of this lane runs in its frames, since the Stage reads no other member's drag, and ISO-2's own rounds gave 16.3 and 14.6, so this reads as the machine's load: other lanes ran on it throughout.

- **Parity.** On the GPU, one image differs from the base, the caps at the far camera, by 1 level a channel at 480,880 pixels and 2 at 30,228, and by nothing more. Each build gives its own image again on a second run. On Chrome's 2D canvas on the CPU (`--disable-gpu`) every image matches the base pixel for pixel, so the GPU samples the shrunken floor textures differently between builds, as ISO-2 found at its round 1, and what is drawn is the same.
- **Bench, stacked on ISO-3:** the drag and pan rows (`--only drag,pan`), two rounds, ISO-3's tip and this one taking turns, Isometric medians in ms. The drag rows here are from two rounds after the last fix. Every row is inside its budget but the typical pan in one round, over at both tips (16.7 against 16.3 here, 20.6 against 18.3 at ISO-3's), and inside in the other (14.3 and 19.2). Moving this device's marks into the drag layer cuts the ringed and aura'd drag by a quarter to a half. The 500-token drag's slowest frame is 97 and 102 ms, where it was 355 and 385 while a drag's start still laid every label out again.

| Frame | ISO-3's tip | Here | Budget here |
|---|---|---|---|
| pan, typical, 40 px | 20.6, 19.2 | 16.7, 14.3 | 16.3, 19.5 |
| local drag, whole frame, typical, 40 px | 14.6, 11.5 | 6.0, 7.2 | 16.0, 17.3 |
| local drag of a token with two range rings and an aura, typical | 18.0, 15.3 | 9.5, 11.4 | 16.0, 16.0 |
| remote drag of the ringed and aura'd token, typical | 20.8, 14.7 | 11.9, 16.3 | 21.8, 20.1 |
| pan, caps, fit | 16.4, 11.9 | 12.7, 12.3 | 16.0, 16.9 |
| pan, caps, 40 px | 17.4, 12.9 | 16.1, 14.2 | 23.1, 25.6 |
| group drag of 4, caps, 40 px | 14.2, 9.5 | 9.0, 7.8 | 19.0, 19.1 |
| a horse with its rider dragged, caps, 40 px | 13.0, 9.2 | 8.9, 8.7 | 19.0, 18.8 |
| pan, 500 tokens, 40 px | 95.1, 97.3 | 84.2, 84.8 | 182.3, 246.0 |
| local drag, whole frame, 500 tokens, 40 px | 29.2, 25.7 | 6.1, 7.7 | 130.5, 163.6 |
| pan, caps, 40 px, both trees mounted | 14.6, 12.3 | 14.7, 13.6 | none |

- **Review round 1 (ISO-3 and ISO-4 together).** Two rules came out of it: every press, aim, anchor and frame reads the drawn ground where the thing is drawn, and every upright or moving mark tests its whole painted box or clips. One line a fix:
  - **Pits (ISO34-ASTRA-6).** `boxGround` starts its highest ground at minus infinity, so a mark round a footprint wholly in a pit stays down in it: the drag marks, the hold ring (MoveLayer.tsx) and a drag's label stack.
  - **Doors (ISO34-ASTRA-4, OPUS-6, FV-2).** The search round the press grows by twice K times the scene's span of heights plus the wall's rise, so a door beside a tall platform or a deep pit is found, and the equivalent mutant of the first build is now killed. For a player a closed door's piece stands only along the stretches of its line where relief/runs.ts stands it (`standingStretches`): the swept band reaches those alone, and the pill hangs raised only when a stretch covers the door's middle.
  - **The drawn ring (ISO34-ASTRA-3, ASTRA-9, OPUS-10).** `tokenBase` and `ringCenter` give a token's base as the board draws it: its lift capped at a canvas height (`cappedBase`, relief/standee.ts) and, for a player, on the drawn ground when the stand rule lays it flat (`standsFor`). Box select, the held point of a switch, the action bar's anchors and the token's rise read it, and a drag takes its grab from it. The drag adapter casts its ray at the capped drawn base (`DragPlan.drawn`) and keeps the logical base for the landing, tested for a capped flier at every turn.
  - **Flat creatures (ISO34-FV-3).** A creature lying flat takes its press area and its decor at the drawn ground under its footprint, where its picture lies, not at 0.
  - **Label obstacles (ISO34-FV-4).** A flat map label's obstacle for the token label layout is its ink box projected at the lowest and the highest drawn ground under its cells, so every fragment of a label across a ledge is kept off. A drag's label stack hangs at its footprint's highest drawn ground (`boxGround`), where the standee's ring stands.
  - **Pins (ISO34-ASTRA-1, OPUS-2).** The Pin tool hits a pin where it stands (`pinAt` with `viewGround`), drags it by the screen offset from its tip through `pressAt`, and the pin pane frames the marker as drawn (`pinScreenBox` with the view).
  - **Find my token and outline focus (ISO34-ASTRA-2, OPUS-3).** The fit takes a `FindFrame`: the target's view box with its lift, centered on its middle at the token's drawn base (`tokenBase`) or an outline row's highest drawn ground (`groundIn`), fitted symmetrically round that middle so the raised ground round it stays on screen too.
  - **Areas (ISO34-ASTRA-5, OPUS-4).** An aim or a turn reads the press on the ground plane at the drawn ground under the area's origin (`aimPoint`), where its preview draws, as 6.4 says. A placed area's handle is reached at its origin's drawn ground, with the rest of the preview.
  - **Draw (ISO34-OPUS-8, ASTRA-8).** The stroke being drawn lifts each point by its own drawn ground, a rectangle or an ellipse as its outline's points, so it stays under the finger across heights. A player's draft draws clipped to the revealed sub-cells of the box its stroke, arrowhead and handles paint, each piece lifted with its ground, as Top-down's fog hides it. Round 2 replaced both with ground pieces (below).
  - **The moving aura (ISO34-OPUS-1, FV-1).** Its clip box is its covered window grown by two cells and by every creature it catches, with its ring's gap and stroke at this zoom (`auraBox`), so a Gargantuan caught by one corner cell is clipped at the fog's edge.
  - **The moving tether (ISO34-ASTRA-7, OPUS-5).** It shows whole only when every sub-cell within half its stroke of its line, the round caps included, is revealed (`strokeSubcells`), and otherwise clips to the revealed ones among them.
  - **The label tap (ISO34-OPUS-9)** builds the viewer's fog once for every label a press tests.
  - **The outliner's flash (FV-4's class).** A door's line lies at the highest drawn ground of the cells either side of it, where its piece stands. A box round cells on several heights becomes the outline round the box seen at their lowest and highest drawn ground (`flashShape`), so it bounds every fragment the ground stage draws, not only its middle cell's. Round 2 moved the door's line to the door's own two cells (below).
  - **The DM's camera event (D-261026-16)** needed no change: it reads no height, as 4.2 now says. The display's security test, two rooms differing only in hidden heights giving one event and one fit, stands, and a mutant that lifts the event's middle off 0 fails it. The same mutant on the corners alone is equivalent, since a lift moves all four corners alike and leaves the box's size.
  - **Kept (ISO34-OPUS-7).** The design's body (5.1, 5.3) still names the overlay for the moving marks. The ISO-3 and ISO-4 As built record the drag layer, as this document does for every lane, and ISO-3's two lines that ISO-4 overtook now point here.
- **Review round 2.** One line a fix:
  - **A flat creature's drag (ISO34-OPUS-11).** The grab and the ray read one stand rule: a creature lying flat under a player's fog is grabbed on the drawn ground and the ray meets it there (`drawnRing`), so dragging another member's partly fogged flier does not jump.
  - **A capped ring's ray (ISO34-OPUS-12, ASTRA-11).** The adapter tries each drawn ground from the highest down, and takes the first whose spot has that ground under it (`placeDrawn`), so a 100 ft flier over a 30 ft platform stays put at the first move. A token standing on the ground takes the ray at its own height.
  - **Find at the zoom found (ISO34-OPUS-13, ASTRA-13).** `findTokenCamera` fits on the uncapped base, then centers the ring's base capped at the fitted zoom, as a scene's fit reads its lift again. An outline row for a token frames the same way (ISO34-ASTRA-2), and other rows by the ground under their box.
  - **A switch from Top-down (ISO34-ASTRA-12).** The held point judges standing by each view's own pick, so a creature that lies flat in Isometric is held where Isometric draws it.
  - **A door's flash (ISO34-ASTRA-15)** reads the door's own two cells (`sideGround`, shared with the door's tap and pill), never one past its ends.
  - **The stroke being drawn (ISO34-ASTRA-10).** It lies in ground pieces (`groundPieces`): the cells its box touches, grouped by drawn ground, each the stroke clipped to those cells where it lies and then lifted by their ground. A player's pieces take only revealed sub-cells, so no part drawn over fog lands on a revealed top. It draws as the ground stage will lay it, so it no longer jumps at the drop.
  - **A flat creature's press area (ISO34-ASTRA-14)** is its footprint cut at the cell lines, each piece at its own cell's drawn ground (`pressCells`), as the ground stage copies its picture. Its decor stays on the highest.
  - **Equivalent mutant.** A second Find fit at the capped base: the cap only bites at the farthest zoom, where the fit clamps again.
- **Review round 3.** **Find at the zoom found, heights too (ISO34-ASTRA-13).** A board pick rebuilds itself at another camera the way the board builds it (`BoardPick.at`), since the zoom decides whether heights stand (the stand threshold, Low power's too) as well as the lift's cap. Find and every outline row fit again on the board rebuilt at the zoom found when heights stand otherwise there, and center on it (`findOnBoard`). Nothing reads a pick at another zoom with only its camera swapped.
- **Review round 4.** **Find's zoom always fits its board (ISO34-ASTRA-16).** When the fit on a standing board lands where heights lie flat and the fit on the flat board lands where they stand, no standing zoom fits the target with them, so Find shows it flat just under the stand threshold (`standScale`, Low power's when on), where the flat fit holds and the heights stay flat. The zoom returned is always one whose board stands as the board the fit read. A player's Find is tested against two rooms that differ only under that player's fog (ISO34-FV-5). Capping that zoom by the flat fit changes nothing today, since in that cycle the flat fit always lands at or above the threshold.

### ISO-5 Choice and docs

Isometric is in reach since this lane's integration commit, which turned `isoReady` on. Until then the whole choice hid behind `isoOffered`, not only the Isometric item (D-261026-11): the View button, Suggested view, the display's rows, the keys and their rows in the sheet.

- **Where the choice is.** The View button before Fit opens a popover from 900 px up and a bottom sheet below. The display's menu has a View group, Scene settings has Suggested view after Starting view, and the shortcut table has I, Q and E, with "Tap a standee again" in Mouse and touch. The shortcut test's rule of no plain taps in that table names the tap again as its one exception, since the design lists it there.
- **The popover keeps its size (D-261026-12, ISO5-OPUS-9).** A popover fixes its size as it opens, so its turn row stays in every view, disabled in Top-down with "Turning works in Isometric." as its reason, or the tool's line where a tool shows Top-down. Every reason the tool allows shares one cell (`turnsReasons`, choice.ts), the one that applies shown and the others hidden and unread, so a pick neither leaves an empty band nor pushes the reason under "Scroll for more".
- **Focus and names.** Any open of the menu, by a key, a click or a tap, puts focus on the checked radio, its ring showing only after keys (D-261026-12). The turn buttons are named by their words, "Turn left" and "Turn right", and described as "Turn the map left" and "Turn the map right" (D-261026-11), so a name holds what is shown.
- **The narrowest bar (D-261026-12).** At 320 px and 130% the bar cannot hold View beside Undo, Redo and Fit, so its gaps tighten first and then the View button folds into the room's menu as a View row that opens the same sheet. Undo and Redo never leave the bar. A widening that unfolds the row closes its sheet for good and hands focus to the menu's title (ISO5-ASTRA-04, ISO5-FOCUS-UNFOLD).
- **The wide bar.** From 900 px up a DM's row in a fight, on a scene with phases, still overflowed by 5 px with the View button once Full screen and the Phase menu had left. So there the gaps narrow to a phone's 6 px next, and last the View button folds into the room's menu too, each until the layout is wider, and every row checks once Isometric is offered, a player's included.
- **The display's menu** takes a height cap and a scroll, since its new rows overflow a phone-sized display.
- **View as a player** keeps a view of its own, in memory and never saved (`previewViewSlot`), so a pick or a turn in the preview leaves the DM's untouched (ISO5-ASTRA-02).
- **The tool's line** promises Isometric back only to a device that wants it: a Top-down pick keeps Top-down after the tool (ISO5-ASTRA-03).
- **"Top-down" never breaks at its hyphen** where it runs in words (`ViewName`): the help under Follow the scene, the display's, and the menu row's detail (ISO5-OPUS-5, ISO5-OPUS-10).
- **Turns stored in order (ISO1-OPUS-1).** Section 7's stored form is now `{"v":1,"pick":"isometric","turns":[["<sceneId>",1]]}`, the turns oldest first and read as pairs. Kept as an object keyed by scene id, a scene id "constructor" or "__proto__" read the object's prototype, so a scene of that id crashed every device following it, and integer-like ids such as "7" listed first, so the oldest dropped was the wrong one. Turns kept as an object still read.
- **A user's key wins (D-261026-12, ISO5-OPUS-7).** A device that had moved a shortcut onto I, Q or E keeps it, and the new default has no key, shown as "No key" in the sheet with its Reset, which takes the key back. The rule is general (state/keyBindings.ts `keysInEffect`): a change on another row's default wins and that row is left unbound, while changes that share a key with each other are dropped as before.
- **The integration commit.** `isoReady` is true, and `isoOffered` follows it alone, so `isoReady` stays the one switch that would take the view out again. The test flag stays, but only for the test hook (`__rvttIsoHook`), which iso.e2e.ts's input cases and the bench pick and turn with, and it offers nothing. The tests that checked the choice hidden without the flag went, since no page hides it now. The FEATURES.md rows for I, Q, E and "Tap a standee again" landed in this commit, so every commit stays green (D-261026-11).
- **The DM's dimming (D-261026-18, ISOREB-OPUS-02).** ISO-2 built on party vision before per-player vision reached main, and dimmed a DM's standee by the DM's own fog layer. It now dims by the fog the DM's map draws, the party's explored ground counting as revealed, as Top-down's translucent fog image shows it. `FogView` reads the explored layer that `withExplored` files beside the DM's under keys of its own, as the fog image does. A sweep of every fog or seen read in this view's files against what Top-down reads for the same viewer, DM and player, on a per-player scene found no other difference.
- **Footprints on hex scenes (ISOREB-OPUS-01).** Section 4.4 says footprints keep the hex design's 4.2 boxes. That holds on hex scenes only after HX-3: this view's client footprint reads pass `SQUARES` (canvas/DragMarks.tsx, canvas/boardPick.ts, canvas/isoDrag.ts, canvas/relief/IsoBoard.tsx and canvas/relief/stand.ts), now on the hex design's list for HX-3. Today a hex scene draws squares in both views, so they agree.
- **Alignment.** alignment-icons' iso5-a measures the top bar for the DM and Pat, the folded menu's View row, the View menu in both views and Suggested view, and iso.e2e.ts the display's rows and the sheet's No key row, at 1440 by 900, 390 by 844 and 320 by 568, at 100% and 130%, all within 1 px.
- **The phone and memory checks.** No real phone was at hand for this lane either, so a pan on the typical scene at 40 px in both views waits for one. The choice adds no stage or canvas, so canvas memory is ISO-2's.
- **Not yet, and older than this view.** At 320 by 568 and 130% the DM's "Players see black" chip pushes Undo, Redo and Fit past the bar's edge, with the View button folded or without it, as it did before Isometric. The shortcut sheet's table is wider than the sheet at that size, its Change buttons cut at the edge.

## 15. Review dispositions

### Round 1

| Finding | Where it went |
|---|---|
| ISO-OP-1, OP-5, OP-19, FR-1, FR-3, FR-10, ASTRA-02, Opus question 2 | the stand rule (5.2, D-261026-5), 5.3, 12, security cases |
| ISO-ASTRA-01, ASTRA-03, ASTRA-04, ASTRA-05, ASTRA-06, OP-2, OP-3, OP-4, OP-13, FR-2, FR-6, FR-7, FR-8 | wall runs, own cells, the pit clip (5.5, 5.6), drawn heights (4.3), the drag adapter (6.3), culling (5.7), cases |
| ISO-OP-6, OP-7, OP-8, FR-4, FR-5, FR-12, FR-13 | the drag layer, moving marks, one scheduler, both trees (5.1, ISO-D15), the bench and gates (10, 11), visible-bucket turns (5.6) |
| ISO-ASTRA-07, ASTRA-08, OP-9, OP-11, OP-12, OP-18, Opus question 1 | Follow the DM (4.2), the room-wide pick, `rvtt.displayView` (7), `labelShape` (6.2), ISO-1's rename and `groundAtMiddle`, owners, `isoReady`, FEATURES tables (13) |
| ISO-ASTRA-09, ASTRA-10, FR-11, OP-10, OP-15 | row spans, the grid-owned walk, hex lines (4.4), the walk bound (4.3), the lift cap (5.4) |
| ISO-OP-14, OP-16, OP-17, FR-9 | sight darkness, pillars, segments (5.5), slops (6.1), facing tick and dimming (5.4), threshold pits (ISO-D12), runs that do not listen (6.2) |

### Round 2

| Finding | Where it went |
|---|---|
| ISO-ASTRA-11, OP-24 | the base formula with `seenFootprintGround` (4.3), own cells above the base after (5.6), the hidden-height case |
| ISO-FR-R2-1, FR-R2-2, ASTRA-16, OP-28, OP-29 | the ghost's tag, `labelShape`'s measured box, the narrowed clip claim, ghost depth and height, the in-sub-cell run, the diamond's decor box (5.2, 5.5) |
| ISO-OP-20, OP-21, OP-22, ASTRA-13, ASTRA-14, Astra's note | the whole local drag and moving marks on the drag layer and overlay (5.1, 5.3), max(16 ms, 1.75x) gates, the unmet overlay target, numbers labeled as draw calls (11, Appendix A) |
| ISO-OP-23, ASTRA-12, FR-R2-3, FR-R2-4, FR-R2-5 | controllers once, the hidden Stage at 0x0 (5.1, ISO-D15), `batchDraw` (5.1), `moveTo` (6.3), runs merged per cell (5.5), the memory check (14) |
| ISO-ASTRA-03, ASTRA-06, OP-25 | the footprint scan (6.3), full projected bounds (5.7), walls, doors and windows only (5.5), cases |
| ISO-ASTRA-07, OP-27 | superseded by round 3's camera geometry (4.2) |
| ISO-ASTRA-15, OP-26 | the integration commit, CameraLayer.tsx in ISO-1 (13) |

### Round 3

| Finding | Where it went |
|---|---|
| ISO-ASTRA-18 | camera geometry in `iso: { turn, vw, vh }`, each display fitting its own seen ground, the terrain-free middle (ISO-D17, 4.1, 4.2, 12), the differential case |
| ISO-ASTRA-19 | moot: the height-range box is gone, and the promise is the ground the display may see (4.2) |
| ISO-ASTRA-17 | the holder's seen footing picks the branch (6.3), three holder cases |
| ISO-OP-30 | every node a drag moves on the drag layer (6.3), group and mount cases, bench rows |
| ISO-OP-31 | the case at one stored elevation, the stem line (4.3) |
| ISO-OP-32 | Top-down's flier shadow, outside this design, left to the coordinator's follow-ups |
| ISO-FR-R3-1 | the cosmetic loss named for auras and tethers (5.1) |
| D-261026-7 | textures (ISO-D18, 5.5, 8, cases, bench rows) |

### Round 4

| Finding | Where it went |
|---|---|
| ISO-ASTRA-20, FR-R4-1 | the tint from pixels wholly inside the cell, from the drawn map image, never the thumbnail (5.5, 12), the differential case |
| ISO-ASTRA-07 | the display's downward search for raised pieces in the DM's rectangle (4.2), the cross-view case |
| ISO-ASTRA-21, OP-33 | old pages drop the event and reload by the version step (4.2, 7), the old-schema case |
| ISO-OP-34 | `dropLanding` with the kept seat on drawn ground (4.3, 6.3), the mount case |

## Appendix A. Measurements

All draw-call medians, not `TaskDuration`: a throwaway prototype outside the repository, Konva 10.7.1 (the app's), headless Chrome, 390 by 844 at 2x pixels, CPU throttled 4 times through the DevTools protocol, 40 frames inside requestAnimationFrame, up to three rounds. It drew a 4096 px map, a grid, 4 px a cell fog and sight images, 512 px token art in clipped circles, and a name and HP bar per token. Isometric used two stages, a 256 px margin, culled relief pieces without buckets, and standing walls 0.5 cell high.

| Scene, zoom | Top-down pan | Isometric pan | Top-down drag | Isometric drag |
|---|---|---|---|---|
| Typical, 40 px | 3.5, 4.0, 3.7 | 5.2, 5.5, 5.7 | 1.1, 1.3, 1.4 | 2.8 in the relief, 0.0 the standee alone on a drag layer |
| Typical, fit | 4.3, 4.0 | 13.6, 13.8 (walls flat 10.3, 9.8) | 1.6, 1.6 | 9.4, 8.8 (walls flat 5.3, 4.5) |
| 500 tokens, 40 px | 42.6, 38.9 | 53.0 (52.0 without outlines) | 20.3, 17.4 | 25.7 |
| 500 tokens, fit | 46.8, 46.2 | 68.3 | 21.9, 20.6 | 33.8 |
| Caps, 40 px | 41.9, 38.5 | 60.5, 63.0 | 15.6, 15.3 | 31.9, 31.3 in the relief, 0.1 the standee alone |
| Caps, fit | 43.6 | 162.2 (flat 59.7) | 18.5 | 103.2 (flat 27.3) |
| Caps with 40 tokens, 20 px | 6.1 | 12.7 | 1.3 | 8.3 |

| Other rows | Top-down | Isometric |
|---|---|---|
| Overlay alone (a ping), typical and caps | 1.4, 15.8 | 1.5, 19.7 |
| A switch's first frame, both trees mounted, typical and caps | 3.3, 33.1 | 4.2, 47.9 |
| Every node rebuilt (a remount), 500 tokens and caps | | 160 to 220, 194 to 332 |
| Sort of every piece, typical (4,374) and caps (26,671) | | 1.6 to 2.9, 9 to 48 |
| Pan with textured sides and walls, typical and caps, one later session | | 7.9 and 77.0, against 7.1 and 70.8 flat-toned in the same session |

- A copied top costs about 15 µs. The caps at 20 px walked all 26,671 pieces to cull them, which the buckets avoid. Not measured: a whole local drag frame, ringed and aura'd drags, a pan with both trees mounted.
- A screenshot of the prototype is in the screenshots folder `raccoon-vtt/iso`.
