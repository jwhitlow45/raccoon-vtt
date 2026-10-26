# raccoon-vtt v1: an isometric view of the board

Status: draft 1, decided as D-261026-1, not yet reviewed. Code is cited from main at `8b23756c`. Nothing is built. The build starts after the hex grids' H1 lands and after per-player vision, since all three change what the board draws.

## 1. The owner's words

The project owner, 2026-10-26: "Also if possible adding an option for an isometric view of the board would be great wherever that fits in".

D-261026-1 sets the scope: a per-device view choice, Top-down (today's board, the default) or Isometric, remembered per device. The DM may set a scene's suggested view, which a device follows until its user picks one. Play works in it with the same rules. Map building tools may switch the board to Top-down while in use, each with a reason. Tokens stand up as standees with their existing art, heights the app already knows show as height, and the view turns in 90 degree steps. The projection is the common 2:1 game "isometric" unless measured against. Asking the owner is off, so every other choice below is a guess at the owner's likely answer, listed with the options it rejects.

## 2. The answer in short

- **A view, never a change to the map.** Isometric is drawing only. Every rule, op and distance stays in world cells. The pointer becomes a world point once, and from there everything runs as in Top-down.
- **2:1 dimetric.** The ground turns 45 degrees and halves in height, and heights rise √3/2 of a cell per cell. Four turns.
- **Standees.** Each token's own art stands upright on its ring, at its elevation, in depth order with raised ground and walls. A standee something covers shows its outline over it, and a second tap there picks the one behind.
- **Heights stand.** Raised ground the viewer can see becomes columns whose tops carry the map, grid, areas and fog. Pits open. Walls stand half a cell high.
- **Four DM tools show Top-down while in use:** the map builder, fog, line up grid and traps.
- **The choice** is a View button beside Fit, keys I, Q and E, a per-scene pick on each device, and a DM's "Suggested view" in Scene settings.
- **Cost.** In a typical scene a pan frame costs about 1.5 ms more than Top-down on the 4x CPU stand-in for a mid phone. At the caps it costs about 40% more, with standing walls and columns dropped below 12 px a cell (Appendix A).
- **Security.** One new scene field, the suggestion, which hides nothing. A player's device never shows more in Isometric than its Top-down shows (section 12).

## 3. Decisions, with rejected options

- **ISO-D1 Projection:** 2:1 dimetric with heights at K = √3/2 view units per cell, the camera's own 30 degree tilt that halves the ground. A 10 ft ledge looks as tall as the map's scale says. Rejected: true isometric (cells would not be 2:1, the decision's default), heights at 1 per cell (ledges look taller than the map's scale), a free angle (depth order and turns would need general 3D).
- **ISO-D2 Where the choice lives:** on each device, per room and scene: the user's pick for the scene, else the scene's suggestion, else Top-down. Rejected: one pick per device for every scene (a DM's suggestion would stop reaching anyone who ever switched), a server-side preference (a member field the server keeps for a device's taste).
- **ISO-D3 The suggestion:** a scene setting, DM only, view only, no turn. A following device starts at turn 0 and follows a change once any gesture in progress ends. Rejected: a suggested turn (one more setting for one key press), forcing the view (D-261026-1).
- **ISO-D4 Standees:** the token's art in its circle (square for objects), upright, never turned by `token.rotation`, on its disposition ring drawn on the ground at its elevation. Rejected: art turned with the token (a tilted portrait reads as a fallen creature), flat discs (D-261026-1), cutting a figure out of the art (needs new art).
- **ISO-D5 Ground heights:** seen raised cells stand as columns whose tops copy the ground's own pixels, and pits open. Rejected: outlines only (heights read weakly and the art stays flat), plain tops (hide the art on every platform), tops that copy only the map (they would drop the fog off a half-fogged cell, a leak).
- **ISO-D6 Walls:** standing, half a cell high, doors and windows in their colors, open doors flat. Rejected: full height (whole rooms hide and a phone turns all the time), flat (rooms read flat and doors are hard to find).
- **ISO-D7 Covered creatures:** true depth order, an outline over what covers them, a second tap to pick them. Rejected: standees always on top (a goblin behind a wall looks in front of it), no outline (a creature behind a wall is lost until a turn).
- **ISO-D8 Map labels and text drawings:** upright when every cell of their box is seen, else flat on the ground under the fog. Rejected: always upright (would show words Top-down's fog hides), always flat (turned and squashed text).
- **ISO-D9 Tools:** the builder, fog, line up grid and traps show Top-down while in use (6.4). Rejected: every tool in Isometric (edge and cell picking on half-height diamonds, and heights rising under the brush), a view without interaction (D-261026-1).
- **ISO-D10 Turns:** instant, about the selected token or the middle, keys Q and E, buttons in the View menu. Rejected: an animated turn (a re-sort and a label layout every frame), a two-finger twist (a pinch would turn the map by accident).
- **ISO-D11 Arrow keys follow the screen:** Up moves toward the map edge that faces up and to the right. Rejected: world axes (Up would go any of four ways after turns).
- **ISO-D12 Level of detail:** below 12 px a cell (24 in Low power) walls and columns lie flat, drawn as Top-down draws them. Rejected: always standing (the cap scene at fit measured 162 ms a frame).
- **ISO-D13 The ground stage:** a second Konva stage under the board, taller by the lift, whose canvas the tops copy. Rejected: redrawing the ground once per height (a full ground draw per level per frame).
- **ISO-D14 Keep in view:** in Isometric the ground under the clear area's middle stays on the scene. Rejected: the 64 px rule on the scene's box (the box's empty corners would let the map leave the screen).
- **ISO-D15 The table display** picks its own view like any device. Rejected: mirroring the DM's view (the DM may build in Top-down while the table watches Isometric).

## 4. The projection

### 4.1 Arithmetic

World units are cells as today, x right and y down the map. A height z is in cells: feet over the room's feet per cell. **View space** is the stage's own coordinates before the camera. Today it equals the world. The camera stays `{ x, y, scale }`: screen = view × scale + (x, y).

| Turn q | c | s | The map's top edge faces |
|---|---|---|---|
| 0 | r | r | up and to the right |
| 1 | -r | r | down and to the right |
| 2 | -r | -r | down and to the left |
| 3 | r | -r | up and to the left |

r is `Math.SQRT1_2` and K is `0.8660254037844386`, written as a literal. Turning right adds 1 mod 4, so the map turns clockwise.

```ts
toView(x, y, z)  = (c*x - s*y, (s*x + c*y) / 2 - K*z)
toWorld(u, v, z) = (c*u + s*w, c*w - s*u)   where w = 2*(v + K*z)
depth(x, y)      = s*x + c*y                // larger is nearer the viewer
```

- Top-down is `toView(x, y, z) = (x, y)`, z ignored.
- A cell shows as a diamond √2 wide and √2/2 tall. A circle d across on the ground shows as an ellipse d wide and d/2 tall at every turn, so a standee d wide sits on its own ring.
- In Konva the ground is two groups: `scaleY 0.5` outside `rotation 45 + 90q`. Their inverse, for upright parts inside, is one group with `rotation -(45 + 90q), scaleY 2`. A unit test pins Konva's absolute transform to `toView` within 1e-9 px.
- **No exactness is needed.** No rule reads the view. A press becomes a world point once (4.3), and snapping, distances and ops run on world cells as today. Round trips agree within 1e-9 cells.
- **The compiler lists the callers.** `ViewPoint` is a branded point. `worldToScreen` and `screenToWorld` become `viewToScreen` and `screenToView` and take or return it, as do `zoomAt`, `fitRect`, `cameraForView` and `keepInView`. So every one of the 40-odd sites that hands the camera a world point fails the typecheck until it goes through `toView`, as the hex design's required grid did.

### 4.2 Pan, zoom, fit and turns

- **Pan, pinch and wheel** are unchanged, in view space.
- **Fit** fits the view box of the target: the box of its four corners through `toView` at 0, its top raised by the lift of the highest seen ground inside. `sceneMinScale` reads the same box.
- **Keep in view.** In Isometric the ground point under the clear area's middle is clamped into the scene's rectangle in world cells and mapped back. `barShift` pans by its dy and clamps the same way.
- **A turn or a view switch** keeps one world point still on screen: the selected token's ground center while it is on screen, else the ground under the clear area's middle (4.3). The scale stays.
- **Boxes.** `boardViewOf` returns view-space boxes, so upright pills slide as today. A new `groundBox` is the world box under the canvas, grown toward the viewer by the largest seen lift, for culling ground work.
- **World points with a zoom** (a starting view, Follow me, Bring everyone here, Look here, follow the turn, Find my token) keep their meaning. Each device centers the point in its own view.

### 4.3 What lies under the pointer

`pickGround(screen)` gives the world point a press means. In Top-down it is `toWorld(screenToView(screen))`.

1. Let `v = screenToView(screen)`. Walk the ray from the highest seen ground in the scene (or 0) down to the lowest (or 0). Its trace on the ground, `toWorld(v, z)`, runs from near the viewer to far, 2K cells of trace per cell of height.
2. Visit the cells it crosses in that order by a grid walk. Cells outside the scene and cells not seen count as ground 0.
3. In each cell, the ray enters at height `zIn` and leaves at `zOut`. If `zIn` is at or below the cell's ground, the press is on the cell's near face: return the entry point, moved 1e-6 into the cell. If the ground lies between, the press is on the top: return `toWorld(v, ground)`.
4. The walk is at most 2K × 60 cells for the model's −100 to 200 ft at 5 ft a cell, so about 104 cells.

Standees are found first, by Konva's hit canvas. Tools then read heights from the world point as today (`seenGround`, the ruler's z, an area's origin), so a press on a platform's top measures from the platform.

### 4.4 Hex scenes

The projection knows no grid. H1's hex lines draw on the ground under the ground group, and footprints keep their boxes (hex design 4.2), so standees and decor need nothing more. HX-D18's culling reads `groundBox`, about twice the screen's cells, so hex lines cost up to twice as much in Isometric. A bench row checks the 200 by 200 hex scene. H2's free walls stand as section 5.4 says. H3's heights stand as hex columns, each hex's three sides facing the viewer as faces, sorted by hex center depth. H3's brief carries it, with a depth order test. Arrow keys turn first (6.5), then HX-D15's zigzag applies.

## 5. What draws how

### 5.1 Structure

In Isometric the board is two stages, one over the other:

1. **The ground stage** never listens. It is taller than the canvas by the lift margin: the lift of the highest seen ground in view, in 128 px steps, at most one canvas height. One layer holds the ground group, which holds, in order: background, map, grid, the `board` layers, sight, fog, then the overlay layers marked ground.
2. **The main stage** holds the relief layer (the ground group again, holding the depth list of 5.5) and the overlay layer (view space: upright layers, silhouettes, decor passes).

Every ground draw makes the relief draw at once after it (the layer's `draw` event), so a top never copies stale pixels. Top-down keeps today's four layers. `LayerDef` (client/features/layers.ts) gains `iso: "ground" | "upright" | "off"`.

### 5.2 Each layer

| Thing | Isometric |
|---|---|
| Background, map image, grid (MapLayer) | ground, lifted onto columns with their tops |
| Floors, pit terrain, stair treads, difficult ground, stamps (drawBuild) | ground |
| Relief tint and shadow (relief.ts) | off where columns stand, else ground |
| Walls, doors, windows | standing pieces (5.4), flat on the ground under ISO-D12 |
| Map labels | upright or flat by ISO-D8 |
| Drawings | ground, their text by ISO-D8 |
| Areas (TemplateLayer) | ground, so they drape over columns. Name pill upright |
| Traps | ground. Name pill and badge upright |
| Tethers | upright, a line between the two standees' bases |
| Sight with its memory, fog | ground. Tops copy them, so a column never shows what the fog covers |
| Explored outline, outliner flash (DM) | ground |
| Range rings, turn start, hold mark, pings | ground, above the fog. Pills upright |
| Area previews | shading and outline on the ground above the fog. Grips and range line upright at the origin's height |
| Rulers, a drag's path and label, laser | upright lines through each point's height: a free point's seen ground, a token stop's elevation. Pills upright |
| Pins | upright at the pin's seen ground |
| Drop ghost, other members' drags | standees at 0.6 on top of the relief. Name pill upright |
| Fog draft, height marks, light reach, stamp handles, line up grid | off: their tools show Top-down (6.4) |
| Tokens | standees (5.3) |
| Chips, badges, HP bar, notch, lock, AC, number, label, plate | upright passes, laid out on the standee's box as today on the token's box |
| Silhouettes | upright: the art outline of a covered standee, at 0.35 |
| Action bar, its dock, door pill, height readout, stop note | HTML chrome as today, anchored by `toView`: the bar under the standee's ring and label (`worldAnchor`, `belowLabel`), `tokenRise` the art box's height. The dock and the bar's clearing move work in screen px and stay as they are |

### 5.3 Standees

- **Box.** The art box is the footprint's w by h in view units, its bottom middle on the footprint's center at the base height. So `TokenText.widthPx`, `boardSizes` and every decor layout keep their numbers. Label layout (`useBoardText`, `textBoxes.ts`) reads boxes as view × scale px, pan left out as today.
- **Ring and base.** The disposition ring is the footprint's ellipse on the ground at the base, filled 25% black so it reads on any art. The selected and active outlines are ground ellipses around it at today's gaps.
- **Art** in its circle or square as today, with the dead, dying and stable tints, the dead mark, initials and icon glyphs.
- **Height.** The base stands at elevation over feet per cell, K view units per cell up. A creature above the ground under it (`tokenLift`) draws a shadow ellipse on the seen ground under its footprint and a 1 px stem up to its ring. This replaces Top-down's drifting shadow. A creature inside the ground stands at its elevation, so the column hides it and its outline shows.
- **Carried tokens** draw after their holder (`drawOrder`, attach/groups.ts), standing half the holder's art height up on it, inset by `COVER_INSET` when they cover its footprint, so a rider sits on its mount. Holder middles (`pressBoxes`) become the rider's art box.
- **The node** sits at the token's world x and y inside the relief's ground group, its upright parts in one inverse group at the footprint's center. So `node.x()` and `node.y()` stay world cells (6.3).

### 5.4 Raised ground and walls

- **Seen ground.** A cell stands at its ground when `seenGround` (client/features/builder/heights/ground.ts:36) gives a value for this viewer, and lies flat at 0 otherwise. The DM's device stands every cell.
- **Columns.** A cell above 0 draws its sides that face the viewer (outward normal of positive depth), from the neighbor's seen ground or 0 up to its own, the left face lighter than the right (two new theme tokens). Then its top: the ground canvas's pixels under the cell, copied up by the lift (ground × K × scale px), clipped to the lifted diamond, read only from the source box. Neighboring tops with one lift share one clip and one copy.
- **Pits.** A cell below 0 is an opening. Inside its diamond at 0 it draws its floor (the ground pixels copied down), then its far sides from its ground up to the neighbor's, at most 0.
- **Stairs** are columns, and their treads come up with their tops. Connected stair edges draw no face.
- **Past the margin.** A top whose source lies below the ground stage, such as a 100 ft tower at the bottom edge zoomed in, fills with the face tone until it is panned up.
- **Walls.** Each edge wall, free wall (cut into pieces at most 1 cell long), door and window stands as a face `WALL_RISE` = 0.5 cell high, from the higher seen ground beside it. Walls take the wall color, a closed door its leaf color, a window the pane color at half opacity. Locks, secret outlines and "S" marks stay the DM's, as today. An open door lies flat with its swing.
- **For a player** a wall piece stands only where the doors' test passes (`doorSeen`, client/features/doors/doors.ts:93: ground on either side out of that player's fog), and is not drawn otherwise. So no wall stands above the fog, and on a per-player scene each device reads its own fog, as doors already do.

### 5.5 Depth order

- **Pieces.** A column or pit keyed by its cell's center, a wall piece by its midpoint, a standee by its footprint's center, each by `depth`.
- **Ties:** column, pit, wall, standee, then a carried token after its holder, then id.
- **Why it holds.** Columns are unit cells on one grid, so center depth orders them. A standee is a flat picture through its footprint's center, which a snapped token puts on a cell's center or corner. Between snapped spots (mid-drag, or with snapping off) a column within one cell's depth may draw on the wrong side of it for that moment. Accepted.
- **Silhouettes.** A standee whose art box meets the screen box of anything drawn after it gets one, found with the sort.
- **The dragged standee** draws on top until it lands.
- **Kept per chunk.** Pieces live in 16 by 16 chunk buckets, each sorted, merged while drawing only the chunks in `groundBox`. A token move re-inserts one standee. A bucket is rebuilt on a turn, and when its heights, walls, doors or the viewer's seen cells change (fog tile objects, as `mergedOf` keys them).
- **Runs.** Neighboring pieces that are not standees draw in one Konva Shape, so the node count is about twice the standees in view.

## 6. Input

### 6.1 Pointer to map

`ToolPointer.world` (client/features/tools.ts:58) is `pickGround(screen)` in Isometric. `screen` is as today. Every px-to-cell slop goes through `slopCells(px)`: px / scale in Top-down, 2 px / scale in Isometric, since the view halves the ground's height and a target must keep at least its pixels every way. Grab radii that compare a world distance times scale with px (AreaTool.tsx:150 and 176, DrawTool.tsx:187 and 203, ruler.ts:153) compare view distances instead.

### 6.2 Taps and overlaps

- A standee takes a press on its art box or its ring, by Konva's hit canvas, so the front one wins.
- **Tap again.** A tap on the selected standee, where another standee's art or ring also lies under the press, selects the next one behind, front to back, round again. No hold. With Shift, Ctrl or Cmd the front one is added or removed as today (`tapToken`, client/state/selection.ts:34). The outlines show what is behind.
- **Box select** takes tokens whose ring center, through `toView` at the base, lies in the screen box (`tokensInBox` gains a view-space form).
- **An empty tap** (emptyTap.ts) reads `pickGround`'s point: a door by its standing face or its ground line within the slop, then the height readout. A pin by its upright marker box (`pinUnder`).
- **Hold to ping** pings at `pickGround`'s point (PingLayer.tsx:177's hand-made math goes).

### 6.3 Drags

Standee nodes sit in the ground group, so Konva maps the finger's moves into world cells and every reader of `node.x()` and `node.y()` keeps working: Stage.tsx's `dragMove`, movement/stageHooks.ts, RulerLayer.tsx's listener and the followers. The finger keeps its place on the art. The standee rises and falls with the landing height as it crosses ground (`tokenLift` with `at`). Snapping, routes, legs, labels, refusals and drops are unchanged.

### 6.4 Tools

| Tool | In Isometric | Why |
|---|---|---|
| Select, several at once | works | 6.2 |
| Ruler, Straight and Walking | works | points by `pickGround`, heights by `seenGround` as today |
| Area | works | origin by `pickGround`, aimed in the ground plane at the origin's height |
| Ping, laser | works | `pickGround` |
| Draw | works | points by `pickGround`. Rectangles and ellipses are world shapes and show as diamonds and ellipses |
| Add token, Pin | works | one point each, and the pin's pane anchors at its marker |
| Doors, action bar, turns, Fit, Find my token, View as a player | works | |
| Map builder, every mode | Top-down while in use | it paints cells and picks edges, which shrink to half-height diamonds and standing faces, Heights would raise the ground under the brush mid-stroke, and its panes and handles are square to the map |
| Fog | Top-down while in use | it paints the ground the fog lies on, and a reveal behind a column could be neither seen nor reached |
| Line up grid | Top-down while in use | it lines a box up with the image's own axes |
| Trap | Top-down while in use | zones are rects of cells and wires end on half-cell points, as the builder's |

Choosing one of the last four shows Top-down at once, centered on the same ground point. Choosing any other tool brings Isometric back. The device's pick does not change.

### 6.5 Keys

Keys go through the registry (client/state/shortcuts.ts), rebindable, for everyone:

- **I** switches the view. **Q** and **E** turn left and right. In Top-down, Q and E say "Turning needs the isometric view." While a tool shows Top-down, I records the pick and says "The map builder works top-down. Isometric comes back when you switch tools." (that tool's name).
- **Arrow keys** in Isometric move by the screen. Up goes toward the map edge that faces up and to the right, Right toward the one down and to the right, and so round. At turn 0, Up is north. At turn 1 it is west, at 2 south, at 3 east. Stage.tsx:837's nudge turns the direction through the projection (`arrowStep`).

## 7. The choice

- **View button.** In the top bar before Fit (RoomChrome.tsx:283), 44 px, on every layout. Its icon is a square grid for Top-down, and for Isometric a diamond with its top edge marked, turned with the view. It keeps its place as the strip and the others give way first.
- **View menu.** A popover on wide screens and a bottom sheet on phones. A radio group "View" with "Top-down" and "Isometric", and in Isometric two buttons, "Turn left" and "Turn right". A line under them says where the view comes from (8).
- **Remembering.** `rvtt.view.<roomId>` in localStorage, as `{"v":1,"scenes":{"<sceneId>":{"view":"isometric","turn":1,"at":17}}}`. A pick or a turn writes the scene's entry. At most 100 scenes, the oldest `at` dropped. Every read and write is in try/catch, and an unreadable value reads as no pick.
- **Suggested view.** Scene settings, This scene, after Starting view: "Suggested view", a segmented choice of "Top-down" and "Isometric", DM only. A Starting view saved in either view is a ground point and a zoom, which both views read.
- **Table display.** Its menu gets the same View rows, stored the same way. In Follow the DM, an Isometric DM device sends the ground under its canvas's middle and its canvas size over its scale, the `view` event's fields as today (dm/tableDisplay.ts:53-62, dm/camera.ts:41). The display fits that size around that point in its own view.

```ts
// Scene: the view a device shows here until its user picks one. Absent reads as Top-down.
suggestedView?: "isometric";
```

- **Op.** `scene.update`'s patch takes `suggestedView: "topDown" | "isometric"`. "topDown" removes the field, so stored scenes and their undo hashes never change. DM only, as `scene.update` is. Reducer: shared/reducer/room.ts beside `defaultView`. Undo label: "changing the suggested view of the scene Crypt".
- **Players** receive it in the scene copy (`projectSceneCtx`, shared/project.ts:999-1020). Duplicate and the room export copy it with the scene.
- **Versions.** The next free op and snapshot pair at build time, identity steps as shared/migrate.ts practice, so an older build refuses a room that may hold the field.

## 8. UI checklist

- **Words shown.** View button: aria-label "View: Top-down" or "View: Isometric", tooltip "Change the view". Menu: "View", "Top-down", "Isometric", "Turn left", "Turn right" (aria "Turn the map left", "Turn the map right"). The line under them: "This scene suggests Isometric." or "This scene suggests Top-down." while following, "Your pick for this scene." after a pick, and "The map builder works top-down. Isometric comes back when you switch tools." while a tool forces it (the tool's own name: "Fog", "Line up grid", "Traps"). The same line shows in that tool's options. Scene settings: "Suggested view", help "Each device shows this view on this scene until its user picks one." Display menu: the same rows.
- **Loading.** Nothing new is slow. A turn or a switch is one sort (at most 48 ms measured at 4x CPU) and one draw, so no indicator. The map's loading notice is unchanged, and the ground stage reports through it.
- **Keys and focus.** The View button opens the menu with focus on the checked radio. Arrow keys move within it, Tab reaches the turn buttons, Escape closes it with focus back on the button. A forced Top-down keeps focus where it is. Keys I, Q and E in the sheet.
- **Screen readers.** A polite status for each change: "Isometric view.", "Top-down view.", "Turned right. The map's top edge faces down and to the right.", and once per tool choice the forced line. The canvas's own labels are unchanged.
- **Large interface sizes.** At 130% on a 320 px phone the radio rows wrap rather than cut a word, and the turn buttons stack.
- **Touch.** 44 px targets. No hold anywhere. Tap again picks the standee behind.
- **Alignment.** The top bar with the View button, the View menu in both views, Scene settings' new row and the display menu's rows are measured with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px. Their roots join e2e/alignmentRoom.ts's screens functions.

## 9. Cases

| Case | Expected | Test |
|---|---|---|
| Any device after the deploy | Top-down, nothing changed | view store unit, reach |
| A world point through each turn and back | the same point within 1e-9 cells, z from −20 to 40 | view unit |
| Konva's ground group against `toView` | within 1e-9 px at each turn | view unit |
| A hex rows and a hex columns center through each turn | round trips, hex lines on the diamond | view unit, hex scene in iso e2e |
| Turn 0, north edge | faces up and to the right, and clockwise with each right turn | view unit |
| A press on a 10 ft platform's top | that cell, z 10 ft | pickGround unit |
| A press on its near face | the platform's cell | pickGround unit |
| A press over a pit | the pit's floor or its far side | pickGround unit |
| A press over a fogged platform (player) | the ground behind at 0 | pickGround unit |
| A Medium behind a wall, beside it, in front | drawn after, before, before the wall | depth unit |
| A Large next to a raised cell on its right | the cell draws after it | depth unit |
| A rider and its mount | rider after mount, half the mount's height up | depth unit |
| A goblin wholly behind a column | outline shown | depth unit |
| Two standees under one tap, then a tap again | front, then the one behind, then front | selection unit, iso e2e |
| A player drags a token 4 cells in Isometric | lands where the same move does in Top-down, "20 ft" | iso e2e |
| A drag onto a 10 ft platform | the standee rises, lands at 10 ft | iso e2e |
| A ruler from a token to a platform | the same feet as in Top-down | iso e2e |
| A hold-to-ping in Isometric | the DM sees it at the same world point | iso e2e |
| Box select | the tokens whose rings are in the box | group unit |
| Arrow Up at each turn | north, west, south, east | shortcuts unit |
| Q with the selected token on screen | the token stays put on screen | camera unit |
| Fit in Isometric | the whole diamond in the clear area | camera unit |
| A pan past the scene | the middle stays over the scene | camera unit |
| The builder chosen in Isometric | Top-down, the line shown, Isometric back on Select | iso e2e |
| A player's pick, then a reload | the pick kept for that scene only | view store unit, iso e2e |
| The DM changes the suggestion mid-drag | a following device switches after the drop | iso e2e |
| 101 scenes picked | the oldest pick dropped | view store unit |
| Unreadable stored value | no pick, no error | view store unit |
| A player: a platform under fog | flat, no faces | relief unit |
| A player: a wall under fog | not drawn, the DM's stands | relief unit |
| A player: a column half fogged | stands, its top carries the fog | relief unit, iso e2e screenshot |
| A label with one cell under fog | flat under the fog, upright for the DM | label rule unit |
| A flier 30 ft over the ground | stem to a shadow on the ground | standee unit |
| Zoomed out under 12 px a cell | walls and columns flat | relief unit, bench |
| Hex scene: drag, measure and ping | as on squares | iso e2e |
| Table display in Follow the DM, DM in Isometric | frames the DM's middle | display unit |
| `scene.update` with `suggestedView: "topDown"` | field removed, undo restores it | room reducer unit |
| A player sends `suggestedView` | refused | permissions unit |
| A new device on a scene that suggests Isometric | Isometric | view store unit |

## 10. Tests

- **Units.** Every case marked unit: `client/lib/view.test.ts` (round trips with a seeded `rng`, a few thousand points a turn, Konva's transform), `pickGround`, the depth order and silhouettes, the seen rules for columns, walls and labels, camera fit, keep in view and the turn pivot, the view store, `arrowStep`, `slopCells`.
- **Mutation checks.** Each new test fails with its rule removed: the turn's sign, the lift's sign, a tie order, the 1e-6 nudge into a face's cell, the seen test for columns and for walls, the label's whole-box test, the front-to-back walk, the tap-again order, the store's cap.
- **e2e.** A new `e2e/iso.e2e.ts` (prefix ISO): the DM suggests Isometric, a player's page follows, the player drags, measures and pings on a square scene and on a hex rows scene, turns with Q and the buttons, picks Top-down and reloads. The DM opens the builder and sees Top-down. Screen points come from the projection through the drag test hook (movement/dragTesting.ts). Plus `maps.e2e.ts` for Scene settings, the alignment files, and `reach`.
- **Bench.** `scripts/bench-iso.ts`, the prototype's scenes on the real board, as bench-height-pills.ts drives Chrome. Rows and gates in section 11.

## 11. Cost

Measured with a throwaway Konva prototype (Appendix A) on the house stand-in for a mid phone: Chrome with the CPU slowed 4 times, 390 by 844 at 2x pixels. GPU raster is not captured.

- **Typical scene** (100 by 100 cells, 40 tokens, 4,000 wall edges, 334 raised or sunken cells): a pan frame 5.2 to 5.5 ms against Top-down's 3.5 to 4.0 at 40 px a cell, and a drag frame 2.8 ms against 1.1 to 1.3.
- **500 tokens** dominate either view: Top-down's pan frame is already 39 to 43 ms there, since tokens are not culled. Isometric adds about 25 to 50%, mostly from the extra ring and outline per standee.
- **The cap scene** (200 by 200, 20,000 wall edges, 6,171 raised or sunken cells, 500 tokens) at fit measured 162 ms with everything standing and 60 ms flat (ISO-D12), against Top-down's 44.
- **Sorting** every piece took 1.6 to 2.9 ms on the typical scene and 10 to 48 ms on the cap scene. Rebuilding every node on a turn took 160 to 330 ms, so the build reorders nodes rather than make new ones.
- **A copied top** costs about 15 µs.

Gates for `scripts/bench-iso.ts`, at 4x CPU: on the typical scene, an Isometric pan or drag frame at most 3 ms over Top-down's at 40 px a cell, and at most 12 ms at fit. On the cap scene, at most 1.5 times Top-down's frame at every zoom, a turn's sort at most 50 ms, and the 200 by 200 hex scene's lines within 2 times Top-down's.

**Kept, never per frame:** the depth buckets (5.5), the seen cells per fog tile object, the wall pieces per chunk object, the silhouette set, and the ground stage's canvas, which is the tops' only source. Nothing animates at rest. The ground stage redraws only on a camera, map, fog, sight or ground layer change.

**Risks.** Software-rasterized numbers may overstate the copies and understate a phone's fill. The 128 px margin steps reallocate a canvas while zooming across a step. The depth order is approximate between snapped spots (5.5).

## 12. Security

- **The view never changes what a device receives.** It adds no ephemeral event and no projection rule. The table display's `view` event keeps its fields and its audience.
- **One new field**, `Scene.suggestedView`, set by the DM through `scene.update` (DM only, refused for players by the existing permission), and sent with the scene to everyone on it. It names a view, nothing about the map.
- **A player's screen never shows more than Top-down's.** Raised ground stands only where `seenGround` says seen. Walls stand only where the doors' test passes for that player. Tops copy the ground canvas, fog and sight included. Map labels and text drawings stand upright only when their whole box is seen. Silhouettes and standees come only from tokens the device holds, and a standee stands over the fog as a token's name already does: every token a player holds is at least partly in sight (design 13.4), so its picture over the fog shows nothing new. `pickGround` reads only seen ground. So nothing the fog hides in Top-down shows in Isometric, on a whole-party scene or a per-player one (each device draws its own projection, per-player vision 6.6).
- **Tests:** the fogged platform, fogged wall and half-fogged label cases (section 9), each failing with its rule removed.

## 13. Lane plan

Order: after the hex grids' H1 lands and per-player vision has deployed. ISO-1, then ISO-2 and ISO-5 beside each other, then ISO-3 and ISO-4 beside each other, then ISO-5's last commit.

| Lane | Owns | After |
|---|---|---|
| ISO-1 Contract | `client/lib/view.ts` (turns, `toView`, `toWorld`, `depth`, `ViewPoint`, `pickGround`, `slopCells`, `arrowStep`) and its tests, `client/lib/camera.ts`, `client/features/view/store.ts`, `shared/model.ts`, `shared/protocol.ts`, `shared/migrate.ts`, `server/rooms/stateSchema.ts`, `shared/reducer/room.ts`, `shared/project.ts` (the allowlist), `shared/permissions.ts`, `server/rooms/undoLabels.ts` | H1 |
| ISO-2 Ground and standees | `client/canvas/Stage.tsx` (the two stages, layer routing), `layers/MapLayer.tsx`, `TokenNode.tsx`, `TokenShadow.tsx`, `tokenShadow.ts`, `RemoteDrags.tsx`, new `client/canvas/relief/*` (pieces, buckets, draw, silhouettes), `client/features/layers.ts`, `builder/BuilderLayer.tsx` and `draw.ts` (no flat walls or relief tint where they stand, labels by ISO-D8), `client/lib/theme.ts` (the two face tokens) | ISO-1 |
| ISO-3 Upright marks | `measure/Pill.tsx`, `RulerLayer.tsx`, `RangeRingLayer.tsx`, `TurnStartLayer.tsx`, `movement/MoveLayer.tsx`, `pings/PingLayer.tsx` (with its hold), `LaserLayer.tsx`, `pins/PinLayer.tsx` (with its tap), `pins/rules.ts`, `attach/TetherLayer.tsx`, `areas/AreaPreviewLayer.tsx`, `TemplateLayer.tsx`, `traps/TrapLayer.tsx`, `drawings/DrawingLayer.tsx`, `canvas/useBoardText.ts`, `textBoxes.ts`, `boardView.ts` | ISO-2 |
| ISO-4 Input | Stage.tsx's pointer, tap, box, drag and nudge code and its HTML anchors (`worldAnchor`, `tokenRise`, `belowLabel`), `canvas/emptyTap.ts`, `lib/group.ts`, `state/selection.ts`, `doors/tap.ts`, the tool slops and grab radii (6.1), `doors/DoorPill.tsx`, `heights/ReadoutHost.tsx`, `movement/StopNote.tsx`, `dm/camera.ts`, `dm/tableDisplay.ts`, `encounter/followTurn.ts`, the view-center spawns (CharacterCard.tsx:304, CompanionsSection.tsx:276, EncountersPanel.tsx:328, grid/tool.tsx:24), the forced Top-down for the four tools | ISO-2, beside ISO-3 |
| ISO-5 Choice and docs | `client/features/view/ViewMenu.tsx`, `pages/RoomChrome.tsx`, `pages/Room.tsx` (top bar), `scenes/SceneSettings.tsx`, `display/DisplayRoom.tsx`, `state/shortcuts.ts` (I, Q, E, arrows, the tap-again row), `components/Icon.tsx`, `e2e/iso.e2e.ts`, `scripts/bench-iso.ts`, alignment roots, then FEATURES.md and the docs in its last commit | ISO-1, and its last commit after all lanes |

ISO-4 stacks on ISO-2 for Stage.tsx. The upright layers' edits in ISO-3 are mechanical and suit a lighter model. H3's brief adds hex columns to `relief/*`.

**Docs to update:** FEATURES.md (Scenes and maps: an "Isometric view" subsection, Height and elevation, Walls and doors, Building maps' Top-down line, The table display, Shortcuts' Keys and Mouse and touch rows), docs/features.md (section 19's "Hex and isometric grids" later item), docs/design.md (14.2's layers and 13.3), docs/dm-guide.md (a short Isometric view section with a screenshot, Suggested view, the four Top-down tools), and README.md's update note (reload open pages).

New FEATURES.md rows, in the Keys table's style:

```
| I | Switch between top-down and isometric | everyone |
| Q, E | Turn the isometric view left, right | everyone |
| Tap a standee again | Pick the one behind it, in isometric | everyone |
```

## 14. As built

Filled by each lane's docs commit, with every place the build went its own way.

## Appendix A. Measurements

A throwaway prototype outside the repository: Konva 10.7.1 (the app's), headless Chrome, 390 by 844 at 2x pixels, CPU throttled 4 times through the DevTools protocol, as scripts/bench-height-pills.ts does. Each number is the median draw time per frame over 40 frames inside requestAnimationFrame, from two rounds where two are given. It drew a 4096 px map, a grid path, 4 px a cell fog and sight images, 512 px token art in clipped circles, a name and an HP bar per token. Isometric used the two stages, a 256 px margin, chunk-free culling of relief pieces and standing walls 0.5 cell high.

| Scene, zoom | Top-down pan | Isometric pan | Top-down drag | Isometric drag |
|---|---|---|---|---|
| Typical, 40 px | 3.5, 4.0 | 5.2, 5.5 | 1.1, 1.3 | 2.8, 2.8 |
| Typical, fit | 4.3, 4.0 | 13.6, 13.8 (walls flat 10.3, 9.8) | 1.6, 1.6 | 9.4, 8.8 (walls flat 5.3, 4.5) |
| 500 tokens, 40 px | 42.6, 38.9 | 53.0 (52.0 without outlines, 70.2 and 56.6 unculled) | 20.3, 17.4 | 25.7 |
| 500 tokens, fit | 46.8, 46.2 | 68.3 | 21.9, 20.6 | 33.8 |
| Caps, 40 px | 41.9 | 60.5 | 15.6 | 31.9 |
| Caps, fit | 43.6 | 162.2 (flat 59.7) | 18.5 | 103.2 (flat 27.3) |
| Caps with 40 tokens, 20 px | 6.1 | 12.7 | 1.3 | 8.3 |

- **Sort** of every piece: typical 1.6 to 2.9 ms (4,374 pieces), caps 10.3 to 47.7 ms (26,671 pieces).
- **Turn** with every node rebuilt: 160 to 220 ms with 500 tokens, 194 to 332 ms at the caps.
- **Copies:** 400 tops cost about 6 ms at fit, about 15 µs each.
- **Caps, 20 px** walked all 26,671 pieces to cull them. Chunk buckets (5.5) avoid that walk.
- A screenshot of the prototype is in the screenshots folder `raccoon-vtt/iso`.
