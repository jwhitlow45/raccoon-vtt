# raccoon-vtt v1: keep the relief picture across a pan

Status: design, draft 1, for lane HXPERF-2. Code references are to main at `2d73a8a5`. This follows the hex relief design (`docs/design-v1-iso-hex-relief.md`), whose section 9 sets the gate and whose As built (section 11) records the misses this note closes. The relief code lives in `client/canvas/relief/`. Client only: no server, protocol or stored data change.

## 1. Why

There are no owner's words for this run. It is the coordinator's follow-up D-261030-532 (amending D-261030-529): raised hexes shipped at about 40 frames a second zoomed out on a slow phone, and the 12 px pan misses design 9's gate on both hex orientations. The owner plays on phones, wants full quality there and dislikes visible regressions. The gate stays as design 9 has it: each frame metric at most `max(16 ms, 1.75 × matched Top-down)`, no loosening.

## 2. The answer in short

- **Keep the relief layer's own canvas as the picture.** A pan scrolls it by whole pixels and paints only the strips the move uncovers: every piece and standee meeting a strip, in depth order, clipped to it. No new canvas and no margin past the view.
- **Repaint whole on anything else.** A mark on the relief or the ground that the camera did not make, a turn, a zoom, a new size or pixel ratio, or a jump past the canvas repaints the view whole. A whole repaint costs what every frame costs today.
- **The camera reaches Konva without React in Isometric.** A live camera slot and an applier move both stages. The board renders once per 128 px cull step and once when the gesture ends. Only the chrome hung on map points renders each move, and only while it shows.
- **Whole CSS pixels.** The isometric camera's translation reaches Konva rounded to a whole CSS pixel, so a scroll is an exact copy and nothing blurs at rest.
- **Outlines stay.** Skipping them below 16 px saved nothing measurable. No look change, so no screenshots.
- **The pattern snapshot needs no fix:** 0.1 ms a pan frame. **The map row's rise** is single steps of garbage collection over about 7.8 MB more live heap, not the snapshot (section 7.3).
- **Areas:** a frame that publishes standing areas runs no build slice, and the ground comparison after a fog change reads only the fog tiles that changed.

## 3. Decided, with rejected options

These guesses are logged as D-261030-540 to D-261030-549.

- **D-261030-540 The kept picture:** the relief layer's canvas keeps its pixels between draws. A camera-only move copies the canvas onto itself by the shift in device pixels and paints the uncovered strips (section 5). Rejected: a kept canvas wider than the view with a whole refill at its edge (by section 4's costs scaled to its area, a 25 to 40 ms frame at each crossing, two to four a second in a fast pan, and 15 to 60 MB more canvas at DPR 2), Konva's node cache (whole refills only), moving the relief canvas by CSS (its hit graph and the stage's other layers would part from it), and dirty rectangles for content changes (needs every standee's own update attributed, section 5.3).
- **D-261030-541 What repaints whole:** marks made inside the scheduler's camera move are camera marks. Every other mark on the relief or ground layer repaints whole. Rejected: attributing marks to their sources (a standee updates itself from the store and from its image load), a repaint on a timer after a pan.
- **D-261030-542 Whole-pixel camera:** in Isometric the translation the stages get is rounded to a whole CSS pixel, the camera the gestures keep is not. Rejected: subpixel scrolls (resampling blurs the picture at rest), a whole repaint when a pan stops (an extra full frame every time).
- **D-261030-543 The live camera:** a room-scoped slot holds the camera. In Isometric a move at the same scale and turn inside the rendered cull step goes to the slot and the applier, not to React state. The board renders on a cull step, at the gesture's end and on any other change. The chrome over the map reads the slot. Rejected: rendering the board every move behind more memo walls (React alone is 2.9 ms in Top-down's pan), moving the chrome by CSS (its edge clamping breaks), changing Top-down's camera path (out of scope, its pans meet their budgets).
- **D-261030-544 The pattern snapshot:** keep one pattern per ground draw, made when the first top is copied. Rejected: an `ImageBitmap` of the ground (one more copy each ground draw for the same main-thread cost).
- **D-261030-545 Outlines:** keep every outline at every zoom. Rejected: dropping them below 16 px a cell (a visible change for a saving inside the noise, section 7.2).
- **D-261030-546 The map row:** no change in this lane. The bench reports its largest step and the page's live heap beside it. Rejected: trimming the kept shapes' memory now (the median is unchanged and the shapes carry the 12 px pan gains of HXPERF).
- **D-261030-547 Area frames:** a frame that publishes newly standing areas runs no build slice, and the next frame resumes. Rejected: a smaller slice for every frame (every area stands later), publishing less often (areas come in later).
- **D-261030-548 The ground comparison:** fix it in this lane. `groundChanges` reads only the cells under fog tiles that differ, when both heights come from the same chunks, grid, bounds, feet and stand. Rejected: a follow-up (a 200 by 200 hex scene pays about 90 ms at full CPU speed on every fog change while an area stands).
- **D-261030-549 Delivery:** one lane, HXPERF-2, with bench rows on both grids, then its docs commit. Rejected: separate lanes for the picture and the camera (both own `IsoBoard.tsx` and `scheduler.ts`).

## 4. Where a pan frame's time goes today

Measured on main `2d73a8a5`: the bench's fixtures and pan (16 touch moves of 9 by 4 px, a warm round, then 3 rounds), Chrome 156 headless with its canvas hardware accelerated, CPU 4 times slower, 390 by 844 at DPR 2. A scratch copy of the bench wrapped each Konva layer's `draw`, the scheduler's message tasks (React's renders and commits), `requestAnimationFrame` callbacks and `createPattern` with timers, and took a sampled CPU profile mapped through the build's source maps. Load average 1.5 to 3.1 during these rows. Means of 48 moves, in ms. "Rest" is the task time no wrapper holds: input, Konva's transform cache clearing, garbage collection and the browser's frame work.

| Pan | Iso median (mean) | Relief layer | React | Overlay | Ground | Pattern | Rest | Top-down median (mean) | Budget |
|---|---|---|---|---|---|---|---|---|---|
| Hex rows, 12 px | 22.3 (22.8) | 11.5 | 4.5 | 1.2 | 0.65 | 0.10 | 4.8 | 8.1 (9.4) | 16.0 |
| Hex columns, 12 px | 20.9 (21.0) | 10.0 | 4.5 | 1.2 | 0.57 | 0.14 | 4.7 | 7.1 (8.0) | 16.0 |
| Hex rows, 40 px | 15.7 (16.3) | 6.1 | 4.7 | 2.0 | 0.45 | 0.07 | 2.9 | 8.8 (10.0) | 16.0 |
| Hex rows, fit | 10.2 (11.1) | 2.4 | 4.2 | 0.9 | 0.50 | 0 | 3.0 | 7.1 (8.0) | 16.0 |
| Squares (caps), 12 px | 20.0 (21.5) | 9.9 | 5.3 | 0.4 | 0.22 | 0.20 | 5.7 | 4.9 (6.1) | 16.0 |
| Squares (caps), 40 px | 7.7 (9.3) | 2.0 | 3.2 | 0.7 | 0.16 | 0.15 | 3.3 | 8.5 (9.5) | 16.0 |
| Hex rows, 24 px Low power | 20.2 (20.4) | not split | | | | | | not measured | 16.0 if Top-down is under 9.1 |

A second round of the 12 px rows gave 21.8 on rows and 26.0 on columns. Squares at 12 px miss too, and hexes at 24 px in Low power almost surely do. The bench has no row for either yet.

Inside the relief layer at 12 px on hex rows, the profile gives `drawRun` about 73% of the scene draw: the tops' pattern fills and their outlines about 45% of it, sides about 26%, pit floors and their clips about 10%. The standees' Konva shapes take about 23% of the scene draw, and the hit graph (standees only) about 1.3 ms. React's 4.5 ms is `MapStage` and `IsoBoard` rendering (2.6 profiled) and their commit (2.8), of which react-konva's own reconcile of both stages is 1.8. On squares at 12 px, a relayout on each 128 px cull step adds 15 to 18 ms, profiled, to about one move in 10 (`ReliefIndex.layout` over the caps' 169 buckets). Top-down pays 2.9 ms of React and 3.5 ms of layer draws a move.

So a 12 px pan frame is half relief raster calls, a fifth React, and a fifth everything else: input, garbage collection and the browser's frame work. The ground draw and the pattern are small on these fixtures.

## 5. The kept relief picture

### 5.1 What is kept

A new `client/canvas/relief/kept.ts` (`KeptRelief`) holds, for the relief layer, what its pixels were drawn at: the stage position in whole CSS pixels, scale, turn, canvas size, pixel ratio and stage key, and a `whole` flag. The relief layer is set `clearBeforeDraw(false)`. The scheduler owns the `KeptRelief` and replaces the layer's `drawScene` and `drawHit` with own properties, as it already replaces `batchDraw` (`scheduler.ts:38`), and deletes them in `detach`. A `drawScene` given another canvas (`toDataURL`, the bench's parity images, the guide's pictures) takes the whole path into that canvas.

### 5.2 A pan frame

`FrameScheduler` gains `moveCamera(apply)`: it sets a camera flag, runs `apply` (the applier setting both stages' positions, section 6.2), then clears it. A `batchDraw` mark made while the flag is set is a camera mark. The frame then runs as today: the ground draws if marked, then the relief.

The relief's draw scrolls when its only marks since the last draw were camera marks, the ground drew only for the camera, and scale, turn, size, ratio and stage key are the kept ones. Otherwise it repaints whole.

- **Scroll.** The shift is `(dx, dy)` device pixels, whole numbers. With `|dx|` and `|dy|` under the canvas's width and height, the canvas is drawn onto itself at the shift (identity transform, composite `copy`). The uncovered strips are a band `|dx|` wide at the left or right edge and a band `|dy|` tall at the top or bottom, at most two rectangles in device pixels.
- **Strips.** Clip to the strips' union, clear it, and draw the relief root's children in order. `dc.view` becomes the strips' rectangles in view units, so `drawRun` (`drawRelief.ts:444`) skips every piece that meets neither. A standee draws only when its layout box, grown by its ring and shadow as the board's frames are (`IsoBoard.tsx` `frames`), meets a strip.
- **Hit graph.** The hit canvas redraws whole, as today: it holds only the standees' hit shapes, about 1.3 ms profiled.
- **The camera at draw time.** `dc` reads the camera from the main stage when it draws, not from the board's render (`IsoBoard.tsx:443`), so a strip and its pattern use the applied camera.

There is no margin to run out of: each frame paints what its own move uncovers, however far the pan goes. At the bench's pan, 9.8 px a move, the strips are about 3% of the canvas. The expected relief cost is one pass of box tests over the layout's pieces and the strips' fills, about 1 to 1.5 ms at 12 px, against 11.5 today. With the board's render gone too (section 6), the expected 12 px pan frame is about 7 to 10 ms: relief 1 to 1.5, its hit graph about 1, overlay 1.2, ground 0.65, the applier and Konva's transform clearing about 1, and the rest 3 to 4. The budget is 16.

### 5.3 What repaints whole

Everything not a camera mark repaints the view whole, at today's cost:

- **The relief:** any commit into its tree (the board's layout after an edit, a fog change, a cull step, areas standing, a selection, a drag's start and drop moving a standee between the relief and the drag layer), a standee's own update (its character or image arriving), a texture or tint arriving.
- **The ground:** any ground draw the applier did not cause: the map, fog, sight, board layers, creatures lying flat, still marks, and a ground canvas made again or resized. Tops copy the ground, so a ground change is a relief change.
- **The view:** scale (each pinch frame, as today), turn, canvas size, pixel ratio, stage key, the board shown again, and a shift as large as the canvas on either axis (Find, follow the turn, a new scene).

Frames between those draw only what moves: a local drag redraws the drag layer alone, and a remote ghost or ping the drag and overlay layers, as today. Dirty rectangles for content would cut a cube's publish frame further (section 8), but need every standee's own update reported with its box. That is a follow-up, not this lane.

### 5.4 Depth order while the picture is reused

A strip redraws every item of the current layout that meets it, in the layout's order, clipped to it. Each pixel in a strip therefore gets what a whole draw would give it. Pixels outside the strips are a whole draw's pixels moved by whole device pixels at the same scale and turn, and nothing drawn there changed, or the frame would have repainted whole. Standees are children of the relief root in that same order, and walls, pits and area bands are pieces of its runs. The drag layer and the overlay still draw above the relief every frame.

The layout covers the cull box, at least 128 screen px past the view on every side (`IsoBoard.tsx:273`). Within a cull step every strip lies inside it. The move that crosses a step asks for one board render (section 6.2), whose relayout repaints whole.

Tops copy the ground drawn in the same frame at the same camera, so a strip's tops read the ground under them. A scrolled top keeps the ground it read, and a camera-only ground draw gives the same pixels moved by whole device pixels: map, grid, fog and sight are drawn by the same transform shifted by a whole pixel. GPU raster may differ in the last bit at antialiased edges, so the e2e compare allows 2/255 a channel and reports the largest difference it finds (section 10.3).

### 5.5 Memory

No canvas is added. Today's isometric canvases at 390 by 844 and DPR 2 are the ground stage, 780 by up to 3,376 device px (10.5 MB at most, 8.5 MB at 12 px on the hex fixture), the main stage's three layers at 5.3 MB each, and hit canvases at ratio 1 (1.3 MB each): about 28 MB. Top-down's stage is 0 by 0 while Isometric shows. The copy onto itself may take a transient copy inside the browser. The cap stays as it is: Konva's pixel ratio at most 2, the ground's lift margin at most one canvas height. Past it nothing new happens: a larger screen gets larger canvases, as today.

### 5.6 The ground stage

The ground keeps its rules: taller by the lift margin, redrawn whenever its camera moves, as Top-down redraws its own layers on a pan. The applier moves it, so a pan renders none of its React layers. Its one camera-reading consumer in Isometric, the measure pill's board view (`features/measure/Pill.tsx`), reads the cull box's board view, which changes once a step.

## 6. No board render per camera move

### 6.1 What renders on a pan today

`scheduleCam` (`Stage.tsx:966`) sets `MapStage`'s camera state each frame. That renders:

- `MapStage` itself, with a new `layerProps` (`:1633`), `boardView` (`:1635`), `live` (`:1643`) and `pick`.
- Every controller, through the new `live`.
- `IsoBoard`, whose camera prop changed: its body (cull box, middle, `dc`), both stages' trees through react-konva, the iso layers given the new `layerProps`, `UprightLabels` with a new `ground` function each render, and every standee's and decor's element.
- The chrome over the map: the token and group action bars and the label, light, pin, trap, door pill, readout and stop note hosts.

That is the 4.5 ms of section 4 at 12 px.

### 6.2 How the camera reaches Konva

- A room-scoped `liveCameraSlot` (new `client/state/liveCamera.ts`) holds the camera on screen, with `subscribe`.
- `IsoBoard` registers an applier through its `onStage` path. It runs `scheduler.moveCamera`, which positions the ground stage and the main stage at the camera rounded to a whole CSS pixel, and answers whether the camera stays inside the rendered cull step.
- In Isometric, `scheduleCam`'s frame sends a move at the same scale and turn to the slot, `camRef` and the applier. When the applier answers no, or the move changes scale or turn, and for every Top-down move, it sets state as today.
- The isometric stages take no `x`, `y` or scale props, so a later render can never write a stale camera back. The applier sets them in a layout effect after each board render as well.
- Picks read the applied camera, the one Konva draws with, so a press and the drawing agree.
- When the gesture ends, `MapStage` sets its state to the final camera once.

### 6.3 What still renders, and why

- **`MapStage` and `IsoBoard`, once per cull step** (128 screen px of travel): the layout, the culling of decor and areas, and the area build's middle are React-owned. At 9.8 px a move that is one move in 13, costing today's frame.
- **The same, once when the gesture ends:** picks, `live` for the controllers, and the saved and followed views then read the final camera.
- **The chrome hung on map points,** each move while shown: one component in `Stage.tsx` reads the slot and renders the bars and hosts with it. Their HTML clamps to the screen's edges, so they cannot move rigidly.
- **The DM's camera controller** (`features/dm/CameraLayer.tsx`) subscribes to the slot without rendering, and publishes the focus and the table display's view as often as it does now.
- **A zoom** renders every frame, as today: scale changes standee shapes, the stand rule and the area octave.

## 7. The pattern, the outlines and the map row

### 7.1 The pattern snapshot

`createPattern` took 0.07 to 0.20 ms a pan move at 4x CPU, one to three calls a move. One is the ground's (`groundPattern`, `drawRelief.ts:337`), made once a ground draw. On an accelerated canvas the snapshot is a copy on the GPU, outside the main thread. The kept picture keeps the rule: one pattern per ground draw, made when a strip first copies a top. No fix of its own.

### 7.2 Outlines below 16 px

The review's lead was half of 5,384 strokes a frame. A scratch run skipped every stroke in the outline color (`theme.relief.edge`) and timed the same pans in the same session:

| Pan | With outlines | Without |
|---|---|---|
| Hex rows, 12 px | 21.8 | 22.1 |
| Hex columns, 12 px | 26.0 | 26.5 |
| Hex rows, 24 px Low power | 20.2 | 20.7 |
| Squares (caps), 12 px | 22.3 | 20.5 |

The differences are inside the round-to-round spread. A stroke is a recorded call, rasterized on the GPU. With the kept picture a pan draws outlines only in its strips. Outlines stay at every zoom, so there is no look change and no before and after pair.

### 7.3 The map row

"A map image set and taken away" times, in Top-down with the isometric tree mounted and hidden, a 1,600 px map set and cleared four times a round on the caps. Seven interleaved pairs of the build before HXREL-1 (`2c30f933`) and after (`2d73a8a5`), each run in its own browser, gave medians of 18.2 to 26.0 ms before (middle 19.5) and 19.3 to 25.0 after (middle 19.9), with one run of the build after at 37.9 under a load of 5.9 left out.

The rise is in single steps. Every run of the build after had a step of 29 to 45 ms, against three of seven before. Profiled, the slow step holds 18 to 22 ms of garbage collection that the same step before lacks. After a forced collection, the page's live heap with the caps shown in Isometric and then hidden is 27.4 MB before and 35.2 MB after: HXREL-1's kept shapes (a `Path2D`, bounds and sides per piece per turn) hold about 7.8 MB, so each major collection marks more and comes sooner. With the heap profiler attached, which slows every allocation, the medians rose by about 3.5 ms (19.8 to 23.4, 24.3 to 27.8), the size of the rise the HXPERF report saw. The ground pattern plays no part: a hidden board draws no ground. The row stays inside its own gate. The bench reports the row's largest step and the live heap beside it (D-261030-546).

## 8. Area frames and the ground comparison

**A cube's frames.** As built gives a 40 ft cube on alternating hex heights at 40 px one build frame of 21 to 25 ms, in which it stands, and an arrival frame of 55 to 56 ms against 1.75 times Top-down's 41 to 53. The standing frame holds a 6 ms build slice and the publish (`setVolumeTick`, `IsoBoard.tsx:353`): the board's render and relayout, then a whole repaint. A scratch run of four arrivals, which could not part the arrival from its build frames, found up to 12 ms of React, 7 to 10 of relief, 2.3 to 3.3 of overlay and 0.6 to 1.5 of ground in them together, the rest in the socket and the store. With D-261030-547 a frame that publishes runs no slice, and the slice resumes the frame after. The publish frame keeps a whole repaint, about 6 ms at 40 px, with the board's render and the overlay: 13 to 16 ms expected. The cube stands about one frame later. The kept picture cannot reuse that frame, since a 40 ft cube covers most of a phone's view at 40 px. If the publish frame still passes 16 ms, the lane reports it with its parts, as design 9 says.

**The ground comparison.** `groundChanges` (`volumes.ts:203`) walks every cell of the scene on each sync whose heights are new, and on a player's board every fog change makes new heights. Timed in Node at full speed with real chunks and fog tiles, cold as after a fog change: 45,885 hexes on a 200 by 200 hex rows scene took 83 to 95 ms, about four times that at the bench's slowdown, and the 40 by 40 fixture's 1,778 took 3.4 ms. One 16 by 16 fog tile grown by a cell, 448 hexes, took 1.1 ms. So `DrawnHeights` carries its source (chunks, fog tiles, grid, bounds, feet and stand), and when two snapshots share all but their tiles, `groundChanges` reads only the cells meeting a tile whose bits differ or that one side lacks, grown by one cell, since a hex's sub-cells can reach into the next tile. Any other difference keeps the whole pass.

## 9. The bench

`scripts/bench-iso.ts` adds, in both views, under one load, before and after interleaved as the HXREL-1 bench did, with the load average beside each round:

- **Pans** on hex rows, hex columns and a new fully raised 40 by 40 square fixture made by the hex fixture's generator on squares: at fit, 12 px, 23 and 24 px in Low power (flat, then standing) and 40 px. Low power rows reload the page with the setting on. The caps get a 12 px pan row too.
- **Counters,** each pan move in Isometric on an untimed pan: whole repaints, strip area as a share of the canvas, board renders (a test hook counts `IsoBoard` and `MapStage` commits), ground draws, patterns made, fills and strokes. Expected at 12 px: under 0.1 whole repaints a move, strips under 5%, board renders under 0.1, ground draws 1, patterns at most 1.
- **The largest move** of every pan row, reported beside its median, so a cull step's frame shows.
- **A 40 ft cube** on alternating heights, on both hex orientations and on the square fixture: the frame it lands in in both views, each frame until it stands with every frame gated, the publish frame named, and the time from sending until it stands.
- **A fog change on a player's board:** the harness can hold a player, through the join API `e2e/areas.e2e.ts` uses (`/api/rooms/:id/join` and `/join/complete` with the room's password), in a second browser context. The bench sets a password when it makes the room, gives the player a PC with darkvision on a fogged scene, and times the player's page while the DM's socket reveals one fog tile a step. Rows: the 40 by 40 hex rows fixture with its four areas standing, and the 200 by 200 hex rows scene with the 500 ft emanation standing, in both views.
- **Parity:** `--parity` and `--compare` must still match pixel for pixel in Top-down. Isometric images move by up to half a CSS pixel where the camera was not whole, so they are looked at, not compared.

The gate is design 9's, unchanged: each frame metric at most `max(16 ms, 1.75 × matched Top-down)`, a warm turn at most 150 ms, every area-building frame held. A row that still misses goes to review with its numbers.

## 10. The lane

### 10.1 One implementation lane

HXPERF-2 owns the whole change, in this order, tests beside each step.

| Part | Owned production files and reason |
|---|---|
| Kept picture | New `client/canvas/relief/kept.ts`, `scheduler.ts` (`moveCamera`, the layer's `drawScene` and `drawHit`), `drawRelief.ts` (strips as `dc.view`, the camera read at draw time), `IsoBoard.tsx` (no camera props on the stages, the applier, standee boxes for strips, the cull box's board view) |
| Live camera | New `client/state/liveCamera.ts`, `client/canvas/Stage.tsx` (`scheduleCam`, the gesture's end, the chrome component), `client/features/dm/CameraLayer.tsx` (subscribe to the slot) |
| Area frames | `IsoBoard.tsx` (the publish frame), `client/canvas/relief/volumes.ts` (`groundChanges`), `client/lib/view.ts` (`DrawnHeights` source) |
| Acceptance | Unit files beside each, `e2e/iso.e2e.ts` with the HXPERF2 step prefix, `scripts/bench-iso.ts` and its test |
| Docs commit | This note's As built, `docs/design-v1-iso-hex-relief.md` section 11 (the misses closed or reported), `docs/design-v1-isometric-view.md` 5.1 (the scheduler's rules) |

No visible change is intended, so FEATURES.md and the DM guide need no edit. If the build changes anything a person can see, FEATURES.md takes it in the docs commit.

### 10.2 Tests

- **Kept picture units** (`kept.test.ts`): each whole-repaint cause of 5.3 repaints whole, a camera-only move scrolls, the strips for each sign of `dx` and `dy` and both, a shift as large as the canvas, a mark inside and outside `moveCamera`, a ground draw for the camera and for content, the rounding to whole CSS pixels, and the path for another canvas.
- **One randomized test** (`kept.random.test.ts`, seeded): 400 sequences of 40 events on hex rows, hex columns and squares, each a small, large or canvas-sized pan, a zoom, a turn, a height or wall edit, a fog reveal, an area standing, a selection, a token moved or a texture arriving, through the board's real `ReliefIndex.layout` and `drawRun` on a canvas that rasterizes at points, as `reliefOracle.test.ts` does, extended with clip rectangles, whole-pixel translation and a copy onto itself. Invariants: after every frame the kept canvas equals a whole draw of the same state at every sample point. A camera-only move paints at most `|dx|·H + |dy|·W` pixels. Any other mark repaints whole.
- **Live camera units:** a pan inside a step sets no `MapStage` state, so the board renders at most once per cull step, a step's crossing and the gesture's end set it once, Top-down sets it every move, the chrome reads the slot, and the camera controller publishes on each move without a render.
- **Area units:** a publish frame runs no slice and the next one does. `groundChanges` by changed tiles equals the whole pass on random chunks and fog, for both hex orientations and squares, including a hex whose sub-cells cross into the next tile.
- **Mutation checks,** each to be killed: a scroll by the unrounded shift, a strip one pixel short, the second strip dropped, a ground content draw taken as a camera move, every mark taken as a camera move, scale, turn or pixel ratio left out of the kept key, a standee culled by its art box without its ring, strips drawn from the layout before a step, no whole repaint for a canvas-sized shift, camera props back on the stages, the chrome reading the rendered camera, a publish frame that also slices, the tile pass used when chunks differ, a tile not grown by a cell.

### 10.3 E2E

`e2e/iso.e2e.ts` step HXPERF2, on hex rows, hex columns and squares at 390 by 844 and DPR 2: pan in 37 small moves and back, then compare the relief canvas with a whole repaint at the same camera, forced through the test hook (`relief/isoTest.ts`), within 2/255 a channel, and report the largest difference. Again with a height edit from the DM's socket mid-pan, with a fog reveal on a player's page, and with a turn. The selected token's action bar stays under its token through a pan, within 1 px at each sampled move, at 100% and 130% interface size.

Run `iso`, `hex`, `areas`, `traps`, `pervision`, `vision`, `fogedge`, `alignment`, `alignment-wide` and `reach`: the relief, both grids, areas over relief, trap names, per-player boards, sight, the fog's edge and the alignment sweeps. Also `display` (the table display follows the DM's pan), `bardock` (the bar's docking through a pan), `swipe` and `keyboard` (gesture and key pans).

### 10.4 UI checklist

- **Words shown:** none new. "Loading the isometric view" and "Building area shapes" stay.
- **Loading:** unchanged. A whole repaint is today's frame, so nothing new waits.
- **Keys, touch and focus:** unchanged. Arrow keys, pinch, two-finger and one-finger pans keep their behavior. A pan moves no focus.
- **Screen readers:** unchanged. The canvas adds no focus target and announces nothing new.
- **Large interface sizes and alignment:** no DOM layout change. The chrome takes its camera from the slot through the same zoomed conversions (`cameraInZoomed`), checked by the e2e bar step at 100% and 130%. The alignment sweep's roots already cover the action bar and hosts in `e2e/alignmentRoom.ts`. The lane confirms that and adds a root only if one is missing.

### 10.5 Cases

| Case | Expected | Test |
|---|---|---|
| A pan of whole-pixel moves within a cull step, hex rows, hex columns and squares | Strips only, canvas equals a whole draw, no board render | kept units, randomized test, iso e2e |
| A move crossing a cull step | One board render, one whole repaint, layout covers every later strip | randomized test, bench counters |
| A pan right, down, left, up and diagonally | Two strips at most, each the right side and size | kept units |
| A jump as large as the canvas (Find, follow the turn) | Whole repaint | kept units |
| Pinch zoom, a turn, Low power toggled, the interface size changed | Whole repaint each time, as today | kept units, iso e2e |
| A height edit, a wall, a fog reveal, a map set mid-pan | Whole repaint that frame, then strips again | randomized test, iso e2e |
| A standee's own update (an image arriving, its character changing) | Whole repaint | kept units |
| A local drag, a remote ghost, a ping during a still camera | Relief not drawn, as today | bench ground counters, iso e2e |
| An area standing while panning | Whole repaint on its publish frame, no slice in it | area units, bench cube rows |
| The action bar, door pill and readout during a pan | Follow the map every move, clamped as before | live camera units, iso e2e, bardock |
| The table display following the DM | Same views sent as now | display e2e |
| Bench parity in Top-down | Pixel for pixel | `--compare` |
| A fog change on a player's board with an area standing, 40 by 40 and 200 by 200 | Comparison reads only changed tiles, same answer as the whole pass | area units, bench fog rows |

### 10.6 Real phones

No real-phone timing is claimed. The copy of a canvas onto itself is specified for every browser, but only Chrome runs here. A browser that drew it wrongly would need a second canvas of the relief's size (5.3 MB at DPR 2). The coordinator's phone pass checks Safari on an iPhone.

## 11. As built

To be filled in by the builder in the lane's docs commit, with every place the build went its own way, its checks, its mutation results and its bench rounds.
