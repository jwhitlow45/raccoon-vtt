# raccoon-vtt v1: an isometric view of the board

Status: draft 2, revised for design review round 1 (section 15 maps every finding) and D-261026-5. Code is cited from main at `8b23756c`. Nothing is built. The build starts after the hex grids' H1 lands, and so after per-player vision.

## 1. The owner's words

The project owner, 2026-10-26: "Also if possible adding an option for an isometric view of the board would be great wherever that fits in".

D-261026-1 sets the scope: a per-device view choice, Top-down (today's board, the default) or Isometric. The DM may set a scene's suggested view, which a device follows until its user picks one. Play works in it with the same rules. Map building tools may switch the board to Top-down while in use, each with a reason. Tokens stand up as standees with their existing art, known heights show as height, and the view turns in 90 degree steps, projected as the common 2:1 game "isometric". D-261026-5 settles round 1: a pick holds for the whole room until the user picks "Follow the scene" again, a turn alone is never a pick, and Isometric never shows a player more than Top-down (5.2). Asking the owner is off, so every other choice is a guess at the owner's likely answer, listed with the options it rejects.

## 2. The answer in short

- **A view, never a change to the map.** Rules, ops and distances stay in world cells. A press becomes a world point once, then everything runs as in Top-down.
- **2:1 dimetric.** The ground turns 45 degrees and halves in height, heights rise √3/2 of a cell per cell, and the view turns in four steps.
- **Standees.** Each token's art stands upright on its ring, in depth order with raised ground and walls. A covered standee shows its outline, and a second tap picks the one behind.
- **The stand rule.** For a player, anything that stands up stands only where every fog sub-cell under it is revealed to that viewer. Otherwise it lies flat under the fog, as Top-down draws it.
- **Heights stand.** Seen raised ground becomes columns whose tops carry the map, grid, areas and fog. Pits open. Walls stand half a cell high, per quarter-cell run of revealed fog.
- **Four DM tools show Top-down while in use:** the map builder, fog, line up grid and traps.
- **The choice:** a View button beside Fit, keys I, Q and E, a pick per device and room, and a DM's "Suggested view" per scene.
- **Cost** on the 4x CPU stand-in for a mid phone: a typical scene's pan frame is about 2 ms over Top-down's and its drag frame is cheaper, since the dragged standee draws alone. At the caps a pan frame is 1.4 to 1.6 times Top-down's, with walls and columns flat below 12 px a cell (Appendix A).

## 3. Decisions, with rejected options

- **ISO-D1 Projection:** 2:1 dimetric, heights at K = √3/2 view units per cell, the camera tilt that halves the ground. Rejected: true isometric (not 2:1), heights at 1 per cell (taller than the map's scale), a free angle (general 3D).
- **ISO-D2 The pick (D-261026-5):** per device and room: "Follow the scene" (the default), "Top-down" or "Isometric". Turns are kept per scene. Rejected: a pick per scene (a player would pick on every scene), one pick for every room (rooms are separate games), a server-side preference.
- **ISO-D3 The suggestion:** a DM scene setting, the view only, followed live once any gesture in progress ends. Rejected: a suggested turn, forcing the view (D-261026-1).
- **ISO-D4 Standees:** the token's art upright, never turned by `token.rotation`, on its ring at its elevation, with a facing tick on the ring when the token is turned. Rejected: turned art (reads as a fallen creature), flat discs (D-261026-1), cut-out figures (new art).
- **ISO-D5 The stand rule (D-261026-5):** sub-cell revealed or flat under the fog. Rejected: whole standees above the fog (Top-down hides a partly fogged creature's fogged part), clipping upright art by its footprint (the art is not over its footprint).
- **ISO-D6 Ground heights:** seen raised cells stand as columns whose tops copy the ground's pixels, and pits open. Rejected: outlines only (heights read weakly), plain tops (hide the art), map-only tops (would drop the fog off a half-fogged cell).
- **ISO-D7 Walls:** half a cell high, per quarter-cell run, from the derived wall set. Rejected: full height (rooms hide, a phone turns all the time), flat (rooms read flat).
- **ISO-D8 Covered creatures:** true depth order, an outline, tap again. Rejected: standees always on top (a goblin behind a wall looks in front of it), no outline (lost until a turn).
- **ISO-D9 Tools:** builder, fog, line up grid and traps show Top-down while in use (6.4). Rejected: every tool in Isometric (cell and edge picking on half-height diamonds), a view without interaction.
- **ISO-D10 Turns:** instant, about the selected token or the middle, Q and E, buttons in the View menu. Rejected: animated turns (a re-sort and label layout each frame), a twist gesture (a pinch would turn the map).
- **ISO-D11 Arrow keys follow the screen:** Up moves toward the map edge facing up and to the right. Rejected: world axes.
- **ISO-D12 Level of detail:** below 12 px a cell (24 in Low power) every drawn height is 0: walls, columns and pits lie flat as Top-down draws them, and picking and standees read the same flat ground. Rejected: always standing (162 ms a frame at the caps' fit).
- **ISO-D13 The ground stage:** a second Konva stage under the board, taller by the lift, whose canvas the tops copy. Rejected: redrawing the ground once per height.
- **ISO-D14 Keep in view:** the ground under the clear area's middle stays on the scene. Rejected: the 64 px rule on the diamond's box (its empty corners).
- **ISO-D15 Both trees stay mounted** once Isometric has shown in the room, so a switch, and a builder round trip, costs one frame. Rejected: remounting (194 to 332 ms at the caps, Appendix A).
- **ISO-D16 The table display** picks its own view under its own key. Rejected: mirroring the DM's view.

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
- **`groundAtMiddle(live)`** gives the ground point under the clear area's middle and replaces every hand-written `(viewport / 2 - cam.x) / scale` and every read of `stage.x()` and `stage.scaleX()`: `viewFromCamera` (scenes/create.ts:171, for FrameView.tsx and SceneSettings.tsx), the spawns (CharacterCard.tsx:304, CompanionsSection.tsx:276, EncountersPanel.tsx:328, grid/tool.tsx:24), `focusFromStage` (dm/camera.ts:41), the view event (dm/tableDisplay.ts:57), PingLayer.tsx:177 and PinLayer.tsx:136. A unit test scans client/ and fails on those patterns outside lib/camera.ts and lib/view.ts.

### 4.2 Pan, zoom, fit, turns and following

- **Pan, pinch and wheel** are unchanged, in view space.
- **Fit** fits the target's view box: its four corners through `toView` at 0, the top raised by the highest drawn lift inside. `sceneMinScale` reads the same box.
- **Keep in view** clamps the ground under the clear area's middle into the scene's rectangle. `barShift` pans by its dy and clamps the same way.
- **A turn or a view switch** keeps one world point still on screen: the selected token's ground center while on screen, else `groundAtMiddle`. The scale stays.
- **Boxes.** `boardViewOf` returns view boxes, so upright pills slide as today.
- **World points with a zoom** (a starting view, Follow me, Bring everyone here, Look here, follow the turn, Find my token) keep their meaning. Each device centers the point in its own view.
- **Follow the DM.** The DM's device sends a world envelope: the box of the clear canvas's corners through `toWorld` at 0, as the event's world x, y, w and h. The receiver fits that box through its own projection. A Top-down DM sends today's numbers.

### 4.3 Drawn heights and what lies under the pointer

**One source of drawn heights.** `drawnGround(cell)` is 0 below the ISO-D12 threshold and on cells this viewer has not seen (`seenGround`, client/features/builder/heights/ground.ts:36, is null), else the cell's ground. Columns, pits, wall bases, standees, uprights, picking, fit, the lift margin and culling all read it. A standee's base is the drawn ground under its footprint plus its lift over the real ground (`elevation - footprintGround`). Rules keep reading real heights as today, so a ruler stop's stored z is still `seenGround`.

`pickGround(screen)`, grid-owned, gives the world point a press means. In Top-down it is `toWorld(screenToView(screen))`.

1. Let `v = screenToView(screen)`. The ray's trace on the ground, `toWorld(v, z)`, runs from near the viewer to far as z falls from the highest drawn ground (or 0) to the lowest (or 0), 2K cells of trace per cell of height.
2. Visit the cells it crosses in that order. Cells outside the scene count as 0.
3. In each cell the ray enters at `zIn` and leaves at `zOut`. At or below the cell's drawn ground on entry: the near face, so return the entry point moved 1e-6 into the cell. Ground between the two: the top, so return `toWorld(v, ground)`.
4. **Bound.** A diagonal trace of length L crosses about L√2 cells, so the walk visits at most 2√2·K·Δz + 2 cells, Δz the drawn range in cells, and never more than the scene's w + h. That is about 147 at 5 ft a cell over the model's −100 to 200 ft, and the scene's size at 1 ft. It is a bound, not a cutoff.

Standees are found first, by Konva's hit canvas. Hex scenes get H3's hex walk (4.4).

### 4.4 Hex scenes

The projection knows no grid. H1's hex lines draw on the ground stage, and footprints keep their boxes (hex design 4.2), so standees and decor need nothing more. HX-D18's culling enumerates, per hex row, only the span inside the inverse-projected viewport polygon, so hex lines cost about twice Top-down's, not the 6.6 times its bounding box would. A bench row checks the 200 by 200 hex scene.

Lines for the hex design to carry: **H2**: "In Isometric, Wall lines stand as free walls do (isometric view 5.5), cut at sub-cell lines, by the quarter-run rule." **H3**: "In Isometric, heights stand as hex columns, the three sides facing the viewer as faces, sorted by hex center depth, a standee after the hexes of its footprint at or below its base. `pickGround` walks hexes along the trace with the near-face rule per hex side. A pit clips to its hex opening. Tests: hex depth order, hex `pickGround`."

## 5. What draws how

### 5.1 Structure

In Isometric the board is two stages, one over the other:

1. **The ground stage** never listens. It is taller than the canvas by the lift margin: the highest drawn lift in view, in 128 px steps, at most one canvas height. One layer holds the ground group: background, map, grid, the `board` layers, sight, fog, and the static ground marks (range rings, turn start, explored outline). Nothing that moves each frame draws here.
2. **The main stage** holds three layers: the relief (the ground group again, holding the depth list of 5.6), the drag layer (the standee being dragged, in its own ground group), and the overlay (view space: uprights, silhouettes, decor, and the moving ground marks: pings, the hold ring, the laser, area previews, rulers and other members' previews, drawn as ground shapes at their drawn height).

**One draw a frame.** In Isometric the Stage owns one requestAnimationFrame scheduler. On the ground layer and the relief layer, `batchDraw` is replaced by a mark in the scheduler. Each frame it draws the ground if marked, then the relief if marked or if the ground drew, so each draws at most once and every top copies the ground of the same frame. The bench counts draws per frame. Top-down keeps today's four layers. `LayerDef` (client/features/layers.ts) gains `iso: "ground" | "moving" | "upright" | "off"`.

### 5.2 The stand rule (D-261026-5)

- For a player on a scene with fog, a thing that stands up stands only when every fog sub-cell under its Top-down footprint is revealed to that viewer. Otherwise it lies flat on the ground stage under the fog, as Top-down draws it.
- The Top-down footprints are a creature's footprint (squeezed while it squeezes), another member's drag ghost's footprint at each eased frame, a map label's box, a text drawing's box, an area's or trap's pill or badge as the box Top-down places it in at this zoom, and a tether's line by the sub-cells it crosses.
- **Always standing:** party members and tokens every player always sees (`drawsAboveFog`), and everything on the DM's device or on a scene without fog.
- **Flat creatures** keep an invisible press area on their footprint in the relief layer, and their decor on their flat footprint's box (w by h/2 in view units), above the fog as Top-down's decor already is (design 13.4). They get no silhouette.
- **A flat ghost** draws on the overlay, clipped to its footprint's revealed sub-cells. Fogged sub-cells are opaque (lib/fogTiles.ts:50), so this shows exactly what the ground stage under the fog would, with no ground redraw each eased frame.
- **Columns** keep `seenGround`'s cell rule (5.5), and walls stand per quarter-cell run. Section 12 says why both show nothing new.

### 5.3 Each layer

| Thing | Isometric |
|---|---|
| Background, map image, grid, floors, pit terrain, stair treads, difficult ground, stamps | ground stage, lifted onto columns with their tops |
| Relief tint and shadow (relief.ts) | off where columns stand, else ground stage |
| Walls, doors, windows, pillars | standing (5.5), or flat under ISO-D12 |
| Map labels, text drawings, area and trap pills and badges, tethers | upright by the stand rule, else flat on the ground stage |
| Areas, traps, other drawings | ground stage, so they drape over columns |
| Sight with its memory, fog | ground stage. Tops copy them |
| Range rings, turn start, explored outline | ground stage, above the fog |
| Pings, hold ring, laser, area previews, outliner flash | moving: overlay ground shapes at their drawn height. Pills upright |
| Rulers, a drag's path and label | moving: upright lines through each point's drawn height. Pills upright |
| Pins | upright at the pin's drawn ground |
| Drop ghost | a standee at 0.6 on the drag layer |
| Other members' drags | standees at 0.6 on the overlay, by the stand rule each frame. Name pill upright with them |
| Fog draft, height marks, light reach, stamp handles, line up grid | off: their tools show Top-down (6.4) |
| Tokens | standees (5.4) or flat by the stand rule |
| Chips, badges, HP bar, notch, lock, AC, number, label, plate | upright passes on the standee's box, laid out as today |
| Silhouettes | upright: a standing standee's art outline where a later piece covers it, at 0.35 |
| Action bar, its dock, door pill, height readout, stop note | HTML chrome, anchored through `toView`: the bar under the standee's ring and label (`worldAnchor`, `belowLabel`), `tokenRise` the art box's height. The dock works in screen px as today |

### 5.4 Standees

- **Box.** The art box is the footprint's w by h in view units, its bottom middle on the footprint's center at the base. So `TokenText.widthPx`, `boardSizes` and every decor layout keep their numbers. Label layout (`useBoardText`, `textBoxes.ts`) reads view × scale px boxes.
- **Ring.** The footprint's ellipse on the ground at the base, filled 25% black. Selected and active outlines are ground ellipses around it. A turned token adds a short tick on the ring toward its facing.
- **Art** as today, with the life tints, the dead mark, initials and glyphs.
- **Height.** A creature above the ground (`tokenLift`) draws a shadow ellipse on the drawn ground under it and a 1 px stem to its ring. A lift on screen is capped at the margin cap, and a capped stem draws a break mark (the badge still says the height). A creature inside the ground draws after its own cells only where they are lower (5.6), so a column hides it and its outline shows.
- **Carried tokens** draw after their holder, standing half its art height up on it, inset by `COVER_INSET` when they cover its footprint.
- **The DM's device** dims to 0.5 a standee whose footprint is wholly under the players' fog or out of party sight, as `visibility: "dm"` tokens are dimmed.
- **The node** sits at the token's world x and y inside the ground group, its upright parts in one inverse group. `node.x()` and `node.y()` stay world cells (6.3).

### 5.5 Raised ground and walls

- **Columns.** A cell whose drawn ground is above 0 draws its sides that face the viewer, from the neighbor's drawn ground up to its own, the left face lighter than the right (two theme tokens), then its top: the ground stage's pixels under the cell, copied up by the lift, clipped to the lifted diamond, read only from the source box. Neighboring tops with one lift share a clip and a copy.
- **Pits.** A cell below 0 is an opening. Inside its diamond it draws its floor (the ground pixels copied down) and its far sides. Everything on a pit's cells, standees included, is clipped to the openings swept upward past the canvas top, so the near rim hides what is below it.
- **Stairs** are columns, and their treads come up with their tops. Connected stair edges draw no face.
- **Past the margin**, a top whose source lies below the ground stage fills with the face tone until panned up.
- **Walls** come from the derived wall set (`deriveWalls`, shared/rules/walls.ts:1110), so automatic walls stand and "no wall" marks do not. The set is already split where walls cross. Each edge wall, free wall, door and window is cut at sub-cell lines into quarter-cell runs. A run stands `WALL_RISE` = 0.5 cell high from the higher drawn ground beside it. Walls take the wall color, a closed door its leaf color, a window its pane color at half opacity. An open door lies flat with its swing. Locks and secret marks stay the DM's.
- **For a player** a run stands only where a fog sub-cell beside it, on either side, is revealed. Top-down shows that half of the line there. A run with neither side revealed is not drawn. Pillars follow the stand rule.
- **Sight.** Faces and wall runs take the darkness the sight overlay gives their cell, cached per sight tile object, so remembered rooms do not look lit.

### 5.6 Depth order

- **Keys.** A column or pit by its cell's center, a wall run by its midpoint, a standee by its footprint's center, each by `depth`.
- **Own cells.** A standee draws after every cell of its own footprint whose drawn ground is at or below its base, whatever their keys. Those tops are at or below the base, so they never cover it. Own cells above its base keep their keys, and on a tie the column draws after the standee. So a Large's ring stays whole on a platform, and a token inside its cell is hidden.
- **Ties:** column, pit, wall, standee, then a carried token after its holder, then id.
- **Why it holds.** Columns are unit cells on one grid, so center depth orders them, and a snapped standee stands on a cell's center or corner. Mid-drag or with snapping off, a column within one cell's depth may draw on the wrong side for that moment. Wall runs never cross, since the set is split at crossings. Two runs that meet at an end can draw in the wrong order only inside one sub-cell of the meeting point, a wedge at most a quarter cell long and `WALL_RISE` tall. Both are accepted.
- **Silhouettes.** A standing standee whose art box meets the screen box of anything drawn after it gets one, found with the sort.
- **Buckets.** Pieces live in 16 by 16 chunk buckets, each sorted. A token move re-inserts one standee. A turn sorts only the buckets in view and the rest as they come into view. A bucket is rebuilt when its heights, walls, doors or the viewer's seen sub-cells change (fog tile objects, as `mergedOf` keys them).
- **Runs.** Neighboring pieces that are not standees draw in one Konva Shape that does not listen.

### 5.7 Culling

Each bucket caches its rise: the most any piece in it reaches above its chunk's ground box on screen (a column's lift, `WALL_RISE`·K, a standee's art height plus its capped lift). A bucket draws when its chunk's view box, grown upward by its rise, meets the canvas. So a high flier whose ground anchor is off screen still draws.

## 6. Input

### 6.1 Pointer to map

`ToolPointer.world` (client/features/tools.ts:58) is `pickGround(screen)` in Isometric. `screen` is as today. Slops and grab radii compare view distances: a candidate's `toView` point against the pointer's, times scale, against the px (doors, labels, the ruler, AreaTool.tsx:150 and 176, DrawTool.tsx:187 and 203, ruler.ts:153).

### 6.2 Taps

- A standee takes a press on its art box or ring by Konva's hit canvas, so the front one wins. Relief runs do not listen, so a press on a column reaches a standee hidden behind it, where its outline shows, and otherwise goes to `pickGround`.
- **Tap again.** A tap on the selected standee where another standee's art or ring also lies under the press selects the next one behind, front to back, round again. No hold. With Shift, Ctrl or Cmd the front one is added or removed as today (`tapToken`, client/state/selection.ts:34).
- **Box select** takes tokens whose ring center lies in the screen box.
- **An empty tap** (emptyTap.ts) reads `pickGround`'s point: a map label by its displayed bounds, a door by its standing run or its ground line, then the height readout, then a pin by its marker box (`pinUnder`).
- **Displayed label bounds** (`labelShape(label, view)`: the upright text block's view box, or the flat box's corners through `toView`) are shared by drawing, `labelUnder` (builder/labelTap.ts), `LabelMarks` (BuilderLayer.tsx) and `labelPaneFrame.ts`, so editing a label through Select hits and frames what is drawn.
- **Hold to ping** pings at `pickGround`'s point.

### 6.3 Drags

A height-aware drag adapter, `dragBoundFunc` on each standee:

- At the start it keeps the grab offset, the screen vector from the pointer to the ring's center.
- Each move takes pointer plus offset as the ring's screen point. A token on the ground at the start lands at `pickGround` of that point. A flier keeps its height: `toWorld` at its drawn base, or `pickGround`'s point where the drawn ground there is higher.
- It returns that point's footprint top-left as an absolute position through the ground group. So `node.x()` and `node.y()` stay world cells, and every reader is unchanged: Stage.tsx's `dragMove`, movement/stageHooks.ts with its held previews, RulerLayer.tsx's listener. Followers and carried riders move by the lead's world delta as today.
- The finger stays on the ring across heights. A finger on a 10 ft platform's top lands on that cell. Snapping, routes, legs, labels, refusals and drops are unchanged. The dragged standee draws alone on the drag layer.

### 6.4 Tools

| Tool | In Isometric | Why |
|---|---|---|
| Select, several at once | works | 6.2 |
| Ruler, Straight and Walking | works | points by `pickGround`, stored z by `seenGround` as today |
| Area | works | origin by `pickGround`, aimed in the ground plane at the origin's height |
| Ping, laser, Draw, Add token, Pin | works | `pickGround`. Draw's rectangles and ellipses are world shapes |
| Doors, action bar, turns, Fit, Find my token, View as a player, label editing | works | 6.2 |
| Map builder, every mode | Top-down while in use | it paints cells and picks edges, which shrink to half-height diamonds and standing runs, Heights would raise the ground under the brush, and its panes and handles are square to the map |
| Fog | Top-down while in use | it paints the ground the fog lies on, and a reveal behind a column could be neither seen nor reached |
| Line up grid | Top-down while in use | it lines a box up with the image's own axes |
| Trap | Top-down while in use | zones are rects of cells and wires end on half-cell points |

Choosing one of the last four shows Top-down at once, centered on the same ground point, and any other tool brings Isometric back. The pick does not change.

### 6.5 Keys

Through the registry (client/state/shortcuts.ts), rebindable, for everyone:

- **I** picks the other view. **Q** and **E** turn left and right, and in Top-down say "Turning needs the isometric view." While a tool shows Top-down, I records the pick and says the tool's line (section 8).
- **Arrow keys** in Isometric move by the screen: Up toward the map edge facing up and to the right, Right toward the one down and to the right, and so round. Up is north at turn 0, west at 1, south at 2, east at 3. Stage.tsx:837's nudge goes through `arrowStep`.

## 7. The choice

- **View button** in the top bar before Fit (RoomChrome.tsx:283), 44 px, on every layout. Its icon is a square grid in Top-down and, in Isometric, a diamond with its top edge marked, turned with the view. It keeps its place while the strip and the others give way first.
- **View menu**, a popover on wide screens and a bottom sheet on phones: a radio group "View" with "Follow the scene", "Top-down" and "Isometric", then "Turn left" and "Turn right" while the board is Isometric.
- **Remembering.** `rvtt.view.<roomId>` in localStorage: `{"v":1,"pick":"isometric","turns":{"<sceneId>":1}}`. No `pick` means Follow the scene. A turn writes only its scene's turn, at most 100 scenes, the oldest dropped. Reads and writes sit in try/catch, and an unreadable value reads as Follow the scene at turn 0.
- **Suggested view.** Scene settings, This scene, after Starting view: "Suggested view", a segmented "Top-down" or "Isometric", DM only. A following device switches once any gesture in progress ends.
- **Table display.** Its menu gets the same rows, stored under `rvtt.displayView.<roomId>`, as `rvtt.displayUiScale` is kept apart. Follow the DM fits the DM's world envelope (4.2).

```ts
// Scene: the view a following device shows here. Absent reads as Top-down.
suggestedView?: "isometric";
```

- **Op.** `scene.update`'s patch takes `suggestedView: "topDown" | "isometric"`, "topDown" removing the field, so stored scenes and undo hashes never change. DM only. Reducer: shared/reducer/room.ts beside `defaultView`. Undo label: "changing the suggested view of the scene Crypt".
- **Players** receive it in the scene copy (`projectSceneCtx`, shared/project.ts:999-1020). Duplicate and the room export copy it.
- **Versions.** The next free op and snapshot pair at build time, identity steps, so an older build refuses a room that may hold the field.

## 8. UI checklist

- **Words shown.** View button: aria-label "View: Top-down" or "View: Isometric", tooltip "Change the view". Menu: "View", "Follow the scene" with the help "This scene suggests Isometric." or "This scene suggests Top-down.", "Top-down", "Isometric", "Turn left", "Turn right" (aria "Turn the map left", "Turn the map right"). While a tool forces it, in the menu and the tool's options: "The map builder works top-down. Isometric comes back when you switch tools." (or "Fog", "Line up grid", "Traps"). Scene settings: "Suggested view", help "Devices that follow the scene show this view." Display menu: the same rows.
- **Loading.** A switch or a turn costs one frame plus the sort of the buckets in view: about 50 to 75 ms at the caps at 4x, so no indicator. The first Isometric view in a room mounts the second tree in batches of 100 standees a frame, ground first, behind the shared indicator after 200 ms ("Loading the isometric view").
- **Keys and focus.** The View button opens the menu with focus on the checked radio. Arrow keys move within it, Tab reaches the turn buttons, Escape closes with focus back on the button. A forced Top-down keeps focus where it is. I, Q and E in the sheet.
- **Screen readers.** A polite status for each change: "Isometric view.", "Top-down view.", "Following the scene: isometric.", "Turned right. The map's top edge faces down and to the right.", and once per tool choice the forced line.
- **Large interface sizes.** At 130% on a 320 px phone the radio rows wrap rather than cut a word, and the turn buttons stack.
- **Touch.** 44 px targets. No hold anywhere. Tap again picks the standee behind.
- **Alignment.** The top bar with the View button, the View menu in both views, Scene settings' row and the display's rows are measured with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px, with roots in e2e/alignmentRoom.ts.

## 9. Cases

| Case | Expected | Test |
|---|---|---|
| Any device after the deploy | Top-down, nothing changed | view store unit, reach |
| A world point through each turn and back, z over the model's range | the same point within 1e-9 cells | view unit |
| Konva's ground group against `toView` | within 1e-9 px each turn | view unit |
| Hex rows and columns centers through each turn | round trips | view unit |
| A press on a 10 ft platform's top, on its near face, over a pit | that cell, that cell, the pit's floor or far side | pickGround unit |
| A press over a fogged platform (player) | the ground behind, at 0 | pickGround unit |
| A press at 12 px a cell and at 11 px a cell behind a 30 ft platform | the platform's top, then the flat cell under the press | pickGround unit |
| A standee on a platform at 12 and at 11 px a cell | at 10 ft, then on the flat ground | standee unit |
| The trace at 1 and 5 ft a cell over −100 to 200 ft | within the stated bound | pickGround unit |
| A Medium behind a wall, and one in front of it | the one behind draws before the wall, the one in front after | depth unit |
| A Large and a Huge on a platform, and on mixed heights | ring whole, own lower cells before | depth unit |
| A token at 0 on a 10 ft cell | the column draws after it, outline shown | depth unit |
| A goblin in a pit | clipped at the near rim | depth unit |
| Two free walls crossing in an X, and meeting in a T | split, ordered, wedge within a sub-cell | depth unit |
| A rider and its mount | rider after mount, half the mount's height up | depth unit |
| A high flier whose anchor lies below the canvas | drawn | culling unit |
| Two standees under one tap, then a tap again | front, then the one behind, then front | selection unit, iso e2e |
| A player drags a token 4 cells | lands as the same move in Top-down, "20 ft" | iso e2e |
| A finger on a 10 ft platform's top | lands on that cell, at 10 ft | drag unit, iso e2e |
| A flier dragged over a platform lower than it | keeps its height | drag unit |
| A party token dragged over a fogged platform | stays on the flat drawn ground, its elevation after the drop as today | drag unit |
| A ruler from a token to a platform | the same feet as Top-down | iso e2e |
| A hold-to-ping | the DM sees it at the same world point | iso e2e |
| Arrow Up at each turn | north, west, south, east | shortcuts unit |
| Q with the selected token on screen | the token stays put on screen | camera unit |
| Fit, and a pan past the scene | the whole diamond, the middle kept on the scene | camera unit |
| The builder chosen in Isometric | Top-down with its line, Isometric back on Select, one frame each way | iso e2e, bench |
| A pick, then a reload, then another scene | the pick kept on every scene of the room | view store unit, iso e2e |
| Q while following, then the DM changes the suggestion | the device still follows | view store unit |
| The DM changes the suggestion mid-drag | a following device switches after the drop | iso e2e |
| A display and a player page in one browser | separate picks | view store unit |
| Follow the DM across views and turns | the display shows the ground the DM sees | display unit |
| `scene.update` with `suggestedView: "topDown"`, undone | field removed, then restored | room reducer unit |
| A player sends `suggestedView` | refused | permissions unit |
| A label on the DM's map in Isometric, tapped with Select | the label pane opens on the drawn label | label unit, iso e2e |
| **Security:** a partly fogged goblin | flat under the fog, its press area and decor kept | stand unit, iso e2e screenshot |
| **Security:** an area wholly under fog | no pill stands, the area flat under the fog | stand unit |
| **Security:** a found trap's pill on fogged ground | flat under the fog | stand unit |
| **Security:** a label with every cell partly revealed | flat under the fog | stand unit |
| **Security:** a ghost whose eased path crosses fog between two allowed frames | flat and clipped on the fogged frames | stand unit |
| **Security:** an edge with one sub-cell revealed each side, facing each other | a quarter of the wall stands | wall unit |
| **Security:** one sub-cell revealed on one side only | that quarter stands | wall unit |
| **Security:** a platform and a wall under fog | flat, not drawn, both standing for the DM | relief unit |

## 10. Tests

- **Units.** Every case marked unit, in `client/lib/view.test.ts` (seeded `rng`, a few thousand points a turn) and beside each module: `pickGround`, depth order, silhouettes, culling, the stand rule, wall runs, the drag adapter, camera, the view store, `arrowStep`, `labelShape`, and the scan that bans hand-written camera math.
- **Mutation checks.** Each new test fails with its rule removed: the turn's sign, the lift's sign, a tie order, the own-cell rule, the pit clip, the 1e-6 nudge, the sub-cell test of the stand rule (every sub-cell against any one), the either-side run test, the flat threshold in `drawnGround`, the rise in a bucket's cull, the grab offset, the front-to-back walk, the tap-again order, the store's room-wide pick.
- **e2e.** A new `e2e/iso.e2e.ts` (prefix ISO): the DM suggests Isometric, a player's page follows, the player drags, measures and pings on a square scene and on a hex rows scene, turns, picks Top-down and reloads. The DM opens the builder and sees Top-down, and edits a label through Select. Screen points come from the projection through the drag test hook (movement/dragTesting.ts). Plus `maps.e2e.ts` for Scene settings, the alignment files, and `reach`.
- **Bench.** `scripts/bench-iso.ts`, ISO-2's first commit, drives Chrome and reads `TaskDuration` as bench-height-pills.ts does, with rows for pan, drag, ping, switch, builder round trip, turn, and hex lines. Gates in section 11.

## 11. Cost

Measured with a throwaway Konva prototype on the house stand-in: Chrome at 4x CPU, 390 by 844 at 2x pixels. It timed draw calls, not `TaskDuration`, and software raster leaves out a phone's GPU, so ISO-2's bench takes over.

- **Typical scene** (100 by 100, 40 tokens, 4,000 wall edges, 334 raised or sunken cells) at 40 px a cell: pan 5.2 to 5.7 ms against 3.5 to 4.0. A drag frame on the drag layer under 0.2 ms against Top-down's 1.1 to 1.4.
- **500 tokens** dominate either view: Top-down's pan is already 39 to 43 ms, since tokens are not culled. Isometric adds 25 to 50%.
- **The cap scene** (200 by 200, 20,000 walls, 6,171 raised or sunken cells, 500 tokens): pan 60 to 63 ms against 38 to 42 at 40 px. At fit, 162 ms standing and 60 ms flat (ISO-D12) against 44.
- **A switch** with both trees mounted costs the target view's first frame: 4.2 ms typical, 48 ms at the caps. A remount measured 194 to 332 ms.
- **Moving marks** on the overlay alone: 1.5 ms typical, 19.7 at the caps, against 1.4 and 15.8. On the ground stage each frame would cost a full pan frame.
- **Sorting** everything: 1.6 to 2.9 ms typical, 9 to 48 ms at the caps. A turn sorts only the buckets in view.

**Gates** for `scripts/bench-iso.ts` at 4x: where Top-down's frame is under 16 ms, Isometric's pan, ping and switch frames stay under 16 ms. Above that, at most 1.75 times Top-down's (measured 1.36 to 1.64). A drag frame at most Top-down's. A turn at the caps at most 150 ms whole. Hex lines on the 200 by 200 hex scene at most 2.5 times Top-down's.

**Kept, never per frame:** the buckets with their rises, the seen sub-cells and sight darkness per tile object, the wall runs per chunk object, the silhouette set, and the ground stage's canvas, the tops' only source. Nothing animates at rest. The ground stage redraws only on a camera, map, fog, sight or static ground change.

**Risks.** Software raster may overstate the copies and understate a phone's fill. Crossing a 128 px margin step reallocates a canvas. The depth order is approximate between snapped spots (5.6). The build records one real-phone spot check in section 14: a pan on the typical scene at 40 px, both views.

## 12. Security

- **The view never changes what a device receives.** It adds no event and no projection rule. The table display's `view` event keeps its fields (now always a world envelope) and its audience.
- **One new field**, `Scene.suggestedView`, set by the DM through `scene.update`, refused for players by the existing permission, and sent with the scene. It names a view, nothing about the map.
- **A player's Isometric screen never shows more than Top-down's.** By the stand rule (5.2), anything upright stands only over wholly revealed sub-cells, else lies flat under the fog, at every eased frame for ghosts. Party members and tokens every player sees stand always, as Top-down draws them above the fog. Tops copy the ground stage, fog and sight included. `drawnGround` and `pickGround` read only seen ground, so a party token dragged over a fogged platform stays on the flat drawn ground. Its elevation after the drop is today's, so the drag adds nothing.
- **Two cell-level reaches remain, both shown today.** A column stands on a cell with any revealed sub-cell, so its faces reach up to one cell past the revealed part. The height readout already shows that cell's height (docs/design-v1-heights-readout.md 1). A wall run stands where either side's sub-cell is revealed, where Top-down already draws half the line.
- **Per-player vision:** each device reads its own fog and draws its own projection (per-player vision 6.6).
- **Tests:** the security cases of section 9, each failing with its rule removed.

## 13. Lane plan

Order: after the hex grids' H1. ISO-1, then ISO-2 and ISO-5 beside each other, then ISO-3 and ISO-4 beside each other, then ISO-5's docs commit. Isometric stays unreachable (`isoReady` false in the view store) until ISO-4's last commit turns it on.

| Lane | Owns | After |
|---|---|---|
| ISO-1 Contract | `client/lib/view.ts` (`toView`, `toWorld`, `depth`, `ViewPoint`, `drawnGround`, `pickGround`, `arrowStep`, `groundAtMiddle`) and tests, `client/lib/camera.ts`, `client/features/view/store.ts`, the camera scan test, `shared/model.ts`, `shared/protocol.ts`, `shared/migrate.ts`, `server/rooms/stateSchema.ts`, `shared/reducer/room.ts`, `shared/project.ts`, `shared/permissions.ts`, `server/rooms/undoLabels.ts`. One mechanical commit renames every camera call site to the view API with Top-down's identity and routes the hand-written sites through `groundAtMiddle`, every file listed in 4.1 plus traps/paneBox.ts, lights/paneBox.ts, builder/tool.tsx, builder/labelPaneFrame.ts, builder/heights/tap.ts, fog/tool.tsx, display/DisplayRoom.tsx and scenes/FrameView.tsx, so trunk stays green | H1 |
| ISO-2 Ground and standees | `scripts/bench-iso.ts` (first commit), `client/canvas/Stage.tsx` (stages, drag layer, scheduler, layer routing, both trees), `layers/MapLayer.tsx` (hex row spans), `TokenNode.tsx`, `TokenShadow.tsx`, `tokenShadow.ts`, `RemoteDrags.tsx`, new `client/canvas/relief/*` (pieces, runs, buckets, culling, the stand rule, silhouettes, pits), `client/features/layers.ts`, `builder/BuilderLayer.tsx` and `draw.ts` (flat-or-standing, `LabelMarks` by `labelShape`), new `builder/labelShape.ts`, `client/lib/theme.ts` | ISO-1 |
| ISO-3 Upright and moving marks | `measure/Pill.tsx`, `RulerLayer.tsx`, `RangeRingLayer.tsx`, `TurnStartLayer.tsx`, `movement/MoveLayer.tsx`, `pings/PingLayer.tsx` with its hold, `LaserLayer.tsx`, `pins/PinLayer.tsx` with its tap, `pins/rules.ts`, `attach/TetherLayer.tsx`, `areas/AreaPreviewLayer.tsx`, `TemplateLayer.tsx`, `traps/TrapLayer.tsx`, `drawings/DrawingLayer.tsx`, `outliner/FlashLayer.tsx`, `canvas/useBoardText.ts`, `textBoxes.ts`, `boardView.ts` | ISO-2 |
| ISO-4 Input | Stage.tsx's pointer, tap, box, drag adapter and nudge code and its anchors, `canvas/emptyTap.ts`, `builder/labelTap.ts`, `builder/labelPaneFrame.ts`, `labelShape`'s users in `LabelPaneHost.tsx`, `lib/group.ts`, `state/selection.ts`, `doors/tap.ts`, the slops and grab radii (6.1), `doors/DoorPill.tsx`, `heights/ReadoutHost.tsx`, `movement/StopNote.tsx`, `dm/camera.ts`, `dm/tableDisplay.ts`, `display/logic.ts`, `encounter/followTurn.ts`, the forced Top-down for the four tools, then `isoReady` | ISO-2, beside ISO-3 |
| ISO-5 Choice and docs | `client/features/view/ViewMenu.tsx`, `pages/RoomChrome.tsx`, `pages/Room.tsx`, `scenes/SceneSettings.tsx`, `display/DisplayRoom.tsx` (its menu), `state/shortcuts.ts`, `components/Icon.tsx`, `e2e/iso.e2e.ts`, alignment roots, then FEATURES.md and the docs | ISO-1, its docs commit after all |

ISO-4 stacks on ISO-2 for Stage.tsx. ISO-3's edits are mechanical and suit a lighter model. H3's brief adds hex columns and the hex walk (4.4).

**Docs to update:** FEATURES.md (Scenes and maps: an "Isometric view" subsection, Height and elevation, Walls and doors, Fog and vision, Building maps' Top-down line, The table display, This device, and the Shortcuts tables), docs/features.md (section 19's "Hex and isometric grids" later item), docs/design.md (13.3 and 14.2), docs/dm-guide.md (an Isometric view section with a screenshot, Suggested view, the four Top-down tools), and README.md's update note (reload open pages). New rows, in the Keys table `| I | Switch between top-down and isometric | everyone |` and `| Q, E | Turn the isometric view left, right | everyone |`, and in the Mouse and touch table `| Tap a standee again | Pick the one behind it, in isometric | everyone |`.

## 14. As built

Filled by each lane's docs commit, with every place the build went its own way, and the real-phone spot check (11).

## 15. Review round 1

| Finding | Where it went |
|---|---|
| ISO-OP-1, ISO-OP-5, ISO-OP-19, ISO-FR-1, ISO-FR-3, ISO-FR-10, ISO-ASTRA-02, Opus question 2 | the stand rule (5.2, D-261026-5), 5.3, 12, security cases |
| ISO-ASTRA-01, ISO-FR-2 | quarter-cell wall runs (5.5), 12, cases |
| ISO-ASTRA-05 | the derived set's split, the bounded wedge (5.6), crossing cases, the corrected behind and in front case |
| ISO-ASTRA-03, ISO-OP-3 | the drag adapter (6.3), cases |
| ISO-OP-2, ISO-ASTRA-04 | `drawnGround` (4.3), ISO-D12, threshold cases |
| ISO-ASTRA-06, ISO-FR-6 | culling by rise (5.7), the flier case |
| ISO-OP-4, ISO-FR-7, ISO-FR-8 | own cells and the pit clip (5.5, 5.6), cases |
| ISO-OP-6, ISO-FR-4 | the drag layer (5.1), gates from data (11), section 2 |
| ISO-OP-7 | moving marks on the overlay (5.1, 5.3), the ping row |
| ISO-FR-5 | one scheduler, one draw a frame (5.1) |
| ISO-FR-12 | `TaskDuration` bench in ISO-2's first commit (10), the spot check (14) |
| ISO-FR-13 | turns sort only buckets in view (5.6), the turn's whole cost (8) |
| ISO-OP-8 | both trees mounted (ISO-D15), switch and round-trip rows, first mount behind the indicator (8) |
| ISO-ASTRA-07, ISO-OP-12 | the world envelope (4.2), `rvtt.displayView` (7) |
| ISO-OP-11, Opus question 1 | the room-wide pick, turns never a pick (ISO-D2, 7) |
| ISO-ASTRA-08 | `labelShape` (6.2), lane owners |
| ISO-OP-9, ISO-OP-18 | ISO-1's rename, `groundAtMiddle` and its scan, every file owned, `isoReady`, FEATURES tables (13) |
| ISO-ASTRA-09, ISO-FR-11, ISO-OP-15 | row spans, grid-owned walk, lines for the hex design (4.4) |
| ISO-ASTRA-10, ISO-OP-10 | the walk bound (4.3), the lift cap and cut stem (5.4) |
| ISO-OP-13 | drawn heights while dragging (12), the fogged platform case |
| ISO-OP-14 | sight darkness on faces and walls (5.5) |
| ISO-OP-16 | slops in view distance (6.1) |
| ISO-OP-17 | pits flat at the threshold (ISO-D12), pillars and the derived set (5.5), the facing tick (5.4), runs that do not listen (6.2) |
| ISO-FR-9 | the DM's dimmed standees (5.4) |

## Appendix A. Measurements

A throwaway prototype outside the repository: Konva 10.7.1 (the app's), headless Chrome, 390 by 844 at 2x pixels, CPU throttled 4 times through the DevTools protocol. Median draw time per frame over 40 frames inside requestAnimationFrame, from up to three rounds. It drew a 4096 px map, a grid, 4 px a cell fog and sight images, 512 px token art in clipped circles, and a name and HP bar per token. Isometric used two stages, a 256 px margin, culled relief pieces without buckets, and standing walls 0.5 cell high.

| Scene, zoom | Top-down pan | Isometric pan | Top-down drag | Isometric drag |
|---|---|---|---|---|
| Typical, 40 px | 3.5, 4.0, 3.7 | 5.2, 5.5, 5.7 | 1.1, 1.3, 1.4 | 2.8 in the relief, 0.0 on a drag layer |
| Typical, fit | 4.3, 4.0 | 13.6, 13.8 (walls flat 10.3, 9.8) | 1.6, 1.6 | 9.4, 8.8 (walls flat 5.3, 4.5) |
| 500 tokens, 40 px | 42.6, 38.9 | 53.0 (52.0 without outlines) | 20.3, 17.4 | 25.7 |
| 500 tokens, fit | 46.8, 46.2 | 68.3 | 21.9, 20.6 | 33.8 |
| Caps, 40 px | 41.9, 38.5 | 60.5, 63.0 | 15.6, 15.3 | 31.9, 31.3 in the relief, 0.1 on a drag layer |
| Caps, fit | 43.6 | 162.2 (flat 59.7) | 18.5 | 103.2 (flat 27.3) |
| Caps with 40 tokens, 20 px | 6.1 | 12.7 | 1.3 | 8.3 |

| Other rows | Top-down | Isometric |
|---|---|---|
| Overlay alone (a ping), typical and caps | 1.4, 15.8 | 1.5, 19.7 |
| A switch's first frame, both trees mounted, typical and caps | 3.3, 33.1 | 4.2, 47.9 |
| Every node rebuilt (a remount), 500 tokens and caps | | 160 to 220, 194 to 332 |
| Sort of every piece, typical (4,374) and caps (26,671) | | 1.6 to 2.9, 9 to 48 |

- A copied top costs about 15 µs. The caps at 20 px walked all 26,671 pieces to cull them, which the buckets avoid.
- A screenshot of the prototype is in the screenshots folder `raccoon-vtt/iso`.
