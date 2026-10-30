# raccoon-vtt v1: keep the relief picture across a pan

Status: design, draft 3, revised for design review rounds 1 and 2, for lane HXPERF-2. Code references are to main at `2d73a8a5` (no cited file differs at `677cf341`). This follows the hex relief design (`docs/design-v1-iso-hex-relief.md`), whose section 9 sets the gate and whose As built (section 11) records the misses this note closes. The relief code lives in `client/canvas/relief/`. Client only: no server, protocol or stored data change.

## 1. Why

There are no owner's words for this run. It is the coordinator's follow-up D-261030-532 (amending D-261030-529): raised hexes shipped at about 40 frames a second zoomed out on a slow phone, and the 12 px pan misses design 9's gate on both hex orientations. The owner plays on phones, iPhones included, wants full quality there and dislikes visible regressions. The gate stays as design 9 has it: each frame metric at most `max(16 ms, 1.75 × matched Top-down)`, no loosening. Per D-261030-536 and D-261030-538 a pan's largest move is held to it too on the 40 by 40 budget fixtures, and reported on the 200 by 200 caps.

## 2. The answer in short

- **Keep the relief layer's own canvas as the picture.** A pan scrolls it by whole device pixels and paints only what the move uncovers, plus the cells whose ground copy can change: every piece and standee whose painted bounds meet a strip, in depth order, clipped to it. No new canvas and no margin past the view.
- **Repaint whole on anything else.** A mark the camera did not make, a turn, a zoom, a new size or pixel ratio, or a jump past the canvas repaints the view whole. A whole repaint costs what every frame costs today.
- **A cull step is a whole repaint at today's cost** (D-261030-538): the board renders and relays out once per 128 px step, as every frame does today.
- **The camera reaches Konva without React in Isometric.** A live camera slot, the single source of truth, and an applier move both stages. The chrome and the sliding pills read the slot, each only while it shows something, and the HTML chrome renders the camera the canvas last drew, so it moves in the canvas's frame.
- **The device grid.** The stages get the camera's translation rounded to the canvas's own device pixels, so a scroll is an exact copy at any pixel ratio and nothing blurs at rest.
- **Outlines stay.** Skipping them saved nothing measurable. No look change, so no screenshots.
- **The pattern snapshot needs no fix:** 0.1 ms a pan frame. **The map row's rise** is single steps of garbage collection over about 7.8 MB more live heap (section 7.3).
- **Areas:** one per-frame background budget, owned by the frame scheduler, keeps every build slice out of a whole repaint's frame, and the ground comparison after a fog change reads only the fog tiles that changed.

## 3. Decided, with rejected options

These guesses are logged as D-261030-540 to D-261030-549, with round 1 and round 2 addenda.

- **D-261030-540 The kept picture:** the relief layer's canvas keeps its pixels between draws. A camera-only move copies the canvas onto itself by the shift in device pixels and paints the uncovered strips and the cells whose ground copy changes (section 5). Strip culling tests painted bounds, never geometric ones, and the scroll path draws only the children that meet a painted region. Rejected: a kept canvas wider than the view refilled whole at its edge (by section 4's costs scaled to its area, a 25 to 40 ms frame at each crossing, two to four a second in a fast pan, and 15 to 60 MB more canvas at DPR 2), Konva's node cache (whole refills only), moving the relief canvas by CSS (its hit graph and the stage's other layers would part from it), dirty rectangles for content changes (every standee's own update would need attributing, a follow-up).
- **D-261030-541 What repaints whole:** marks made inside the scheduler's camera move are camera marks. Every other mark, a cull step's relayout included, and any ground draw the scheduler's counter does not account for, repaints whole. Rejected: attributing every mark to its source, a repaint on a timer after a pan.
- **Dropped in round 2 (D-261030-538):** the cull-step machinery of draft 2 (a sliced layout job outside React, a transition commit, a layout-only verdict through Konva's subtree observer, four seam bands), since each round found new defects in it, against a hitch only the largest scenes zoomed out show.
- **D-261030-542 The device grid:** in Isometric the stages get `x = round(x·r)/r` with `r` the layer canvas's pixel ratio, and picks read that applied camera. Rejected: whole CSS pixels (a 1 CSS px move is 1.5 device px at ratio 1.5), subpixel scrolls (resampling blurs the picture), the whole path at fractional ratios (common phones would lose the gain).
- **D-261030-543 The live camera:** a room-scoped slot holds the camera on screen. Every camera path writes it, `camRef` reads it, and the applier positions the stages from it. A move at the same scale and turn inside the rendered cull box renders no board. The chrome and the sliding pills subscribe only while they show something, and the HTML chrome renders from the slot's snapshot of the camera last drawn, on every render. Top-down keeps its camera path. Rejected: rendering the board every move behind more memo walls, moving the chrome by CSS (edge clamping breaks), changing Top-down too.
- **D-261030-544 The pattern snapshot:** one pattern per ground draw, made when a strip first copies a top. Rejected: an `ImageBitmap` of the ground (one more copy each ground draw).
- **D-261030-545 Outlines:** every outline at every zoom. Rejected: dropping them below 16 px a cell (a visible change for a saving inside the noise, section 7.2).
- **D-261030-546 The map row:** no change in this lane. The bench reports its largest step and the page's live heap. Rejected: trimming the kept shapes' memory now (the median is unchanged and the shapes carry the 12 px pan gains of HXPERF).
- **D-261030-547 Area frames:** the frame scheduler owns one background budget a frame, shared by every background job, and runs the jobs in its own callback after it draws. The budget is zero in a frame that repainted whole or began with a repaint pending, so callback order cannot put a slice in a repaint's frame. Rejected: a smaller slice for every frame (every area stands later), publishing less often (areas come in later), skipping the publish's own frame (the repaint lands in the next one), asking only whether a repaint is pending (the scheduler may have drawn already).
- **D-261030-548 The ground comparison:** fix it in this lane. `groundChanges` reads only the cells under fog tiles that differ when both heights share scene id, chunks, grid, bounds, feet and stand. Rejected: a follow-up (a 200 by 200 hex scene pays about 90 ms at full CPU speed on every fog change while an area stands).
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

A new `client/canvas/relief/kept.ts` (`KeptRelief`) holds, for the relief layer, what its pixels were drawn at: the stage position on the device grid, scale, turn, canvas size, pixel ratio and stage key, the screen boxes of last draw's toned cells (5.3), and a `whole` flag. The scheduler owns it and replaces only the relief layer's `drawScene` with an own property, as it replaces `batchDraw` (`scheduler.ts:38`), and deletes it in `detach`. `clearBeforeDraw` stays true, so Konva's hit path is untouched: the hit canvas clears and redraws whole each draw, as today (standees only, about 1.3 ms profiled). The override's whole path is Konva's own `drawScene`. Its scroll path copies, clips and clears the painted regions, then walks the relief root's children itself and draws only those whose painted bounds meet a region, firing the layer's draw events as Konva does. A `drawScene` given another canvas (`toDataURL`, the bench's parity images, the guide's pictures) takes the whole path into that canvas.

**The self-copy probe** (D-261030-537). The override runs it at its first draw with a nonzero canvas size, before anything paints: it paints a known 2 by 2 block, copies the canvas onto itself shifted by one device pixel, reads both pixels back and clears. A stage mounted at 0 by 0 (a stage-key remount while hidden, `IsoBoard.tsx:532`) or a readback that throws means probe again at the next draw. Only a completed wrong read turns scrolling off for that board: every draw then takes the whole path, today's behavior. The coordinator's phone pass confirms it on an iPhone.

### 5.2 A pan frame

`FrameScheduler` gains `moveCamera(apply)`: it sets a camera flag, runs `apply` (the applier positioning both stages, section 6.2), then clears it. A `batchDraw` mark made while the flag is set is a camera mark. The frame then runs as today: the ground draws if marked, then the relief.

The relief scrolls when its only marks since the last draw were camera marks, the ground drew only for the camera, and scale, turn, size, ratio and stage key are the kept ones. "The ground drew only for the camera" is decided from the ground layer's draw counter (`groundCopy.version`, `IsoBoard.tsx:461`, counted on every path that draws it, Konva's resize included) against the scheduler's own camera draws of the ground: any draw it did not make is a content draw. Otherwise the relief repaints whole.

- **Scroll.** The shift `(dx, dy)` is whole device pixels by 6.2's rounding. With `|dx|` and `|dy|` under the canvas's width and height, the canvas is drawn onto itself at the shift (identity transform, composite `copy`).
- **What is painted.** The band `|dx|` wide at the left or right edge, the band `|dy|` tall at the top or bottom, and the toned-cell boxes of 5.3. Each is tested on its own, a piece or standee drawing when its painted bounds meet any of them. They are painted through one clip of their union, cleared first, so an overlap is painted once.
- **Painted bounds.** A relief piece's cull box is its geometric bounds (`pieces.ts:163`) grown by half the widest stroke it draws plus 1 device px for antialiasing: half a device px for terrain outlines (`drawRelief.ts:263`, `:353`, `:409`), 1.25 CSS px for a selected area's 2.5 px outline (`:505`, `:705`). A standee's is its `StandeeShape.bounds` (`standee.ts:75`), which holds the ring, shadow, outlines, caught rings and facing tick with the decor's reach. The strip clip stays exact.
- **The camera at draw time.** Every camera-derived field of `dc` (camera, view box, strips) is computed in the override from the main stage when it draws, on the whole path too, never from the board's render (`IsoBoard.tsx:443`, `:449`). A whole repaint between renders therefore culls by the view on screen.
- **Batches.** Tops batch by the layout, not by what a draw culls: a batch is a run of consecutive equal-height columns of a run piece list, broken by any other piece whether or not it draws. A draw fills each batch's members that meet its region as one path at the batch's place. A strip and a whole repaint of one layout then fill the same unions, so their pixels match at the shared edges of tops too, where a separate fill would leave a faint conflation seam.

There is no margin to run out of: each frame paints what its own move uncovers, however far the pan goes. At the bench's pan, 9.8 px a move, the strips are about 3% of the canvas. The expected relief cost is one pass of box tests over the layout's pieces and the strips' fills, about 1 to 1.5 ms at 12 px, against 11.5 today. With the board's render gone too (section 6), the expected 12 px pan frame is about 7 to 10 ms: relief 1 to 1.5, its hit graph about 1, overlay 1.2, ground 0.65, the applier and Konva's transform clearing about 1, and the rest 3 to 4. The budget is 16.

### 5.3 Ground copies near the ground canvas's edges

A top or a pit floor copies the ground canvas through a bounded, non-repeating pattern, and takes the face tone where its source lies past the canvas (`drawRelief.ts:296` to `:343`). The ground canvas is the view's width and starts at the screen's top, so a pit floor near the top, whose source lies above it by its depth, and a top near the bottom when the lift margin is capped at one canvas height (`IsoBoard.tsx:434`) can change between tone and ground as the camera moves, well inside the canvas. A pure scroll would carry the old pixels.

- The tone decision is made per cell, from the cell's own source box, not from the batch's union. Today a batch straddling the canvas's edge tones all its members, so a top's look would depend on its batch-mates and so on the region drawn. Where the ground canvas is opaque under a member, as it is inside a scene, the pattern covers the tone and nothing changes.
- `drawRun` records the screen box (painted bounds) of each cell that took the tone branch.
- A scroll paints, besides the bands, last draw's toned boxes moved by the shift (cells that may now gain ground) and the boxes of cells whose source box crosses the ground canvas's edge at the new camera (cells that may now lose it). The second set comes from the same pass of box tests, run once before the clip is set.
- If measuring shows the boxes cost more than bands, the fallback is a top band as tall as the deepest pit on screen and, when the margin is capped, a bottom band as tall as the highest lift past it, on any `dy`.

### 5.4 What repaints whole

Everything not a camera mark repaints the view whole, at today's cost:

- **The relief:** any commit into its tree (the board's layout after an edit, a fog change, a cull step, areas standing, a selection, a drag's start and drop moving a standee between the relief and the drag layer), a standee's own update (its character or image arriving), a texture or tint arriving.
- **The ground:** any ground draw the scheduler did not make for the camera: the map, fog, sight, board layers, creatures lying flat, still marks, a ground canvas made again or resized. Tops copy the ground, so a ground change is a relief change.
- **The view:** scale (each pinch frame, as today), turn, canvas size, pixel ratio, stage key, the board shown again, a shift as large as the canvas on either axis (Find, follow the turn, a new scene), and a failed probe.

Frames between those draw only what moves: a local drag redraws the drag layer alone, and a remote ghost or ping the drag and overlay layers, as today.

### 5.5 Depth order while the picture is reused

A painted region gets every item of the current layout whose painted bounds meet it, in the layout's order, clipped to it. Each pixel there gets what a whole draw would give it. Pixels outside are a whole draw's pixels moved by whole device pixels at the same scale and turn, and nothing drawn there changed, or the frame would have repainted whole. Standees are children of the relief root in that order, and walls, pits and area bands are pieces of its runs. The drag layer and the overlay still draw above the relief every frame.

Tops copy the ground drawn in the same frame at the same camera. A scrolled top keeps the ground it read, and a camera-only ground draw gives the same pixels moved by whole device pixels, except where 5.3 repaints. GPU raster may differ in the last bit at antialiased edges, so the e2e compare allows 2/255 a channel and reports the largest difference it finds (section 10.3).

### 5.6 The cull step

The layout covers the cull box, at least one 128 px step past the view on every side (`IsoBoard.tsx:273`). The applier answers "inside" while the view's snapped cull key is the rendered one, so a strip always lies inside the layout. The move that changes the key sets state (section 6.2): the board renders, relays out and repaints whole, at today's cost (D-261030-538). At the bench's 9.8 px a move that is about one move in 13. The render commits a task later, and until then strips still lie in the old cull box, which reaches a step past the view that changed the key. A move that would take the view out of the rendered cull box itself renders the board with `flushSync` in that frame, before the scheduler draws. The randomized test models the commit delay.

Per D-261030-538 the largest move is gated on the 40 by 40 budget fixtures by the frame rule, against `max(16 ms, 1.75 × matched Top-down's largest move)`, and the caps report theirs. A cull step's frame costs what today's does, so today's largest moves stand in for it until the lane measures. On hex rows they were 30.8 ms at 12 px, 25.4 at 40 px and 26.0 at 24 px in Low power, and on hex columns 25.2 at 12 px. Top-down's matched largest moves were 26.6, 31.2, not measured and 26.0, so the budgets are 46.6, 54.6, unknown and 45.5 ms. The gate takes the median of the three rounds' largest moves, so a row misses when at least two of three rounds do. Two single moves in today's runs were past their budgets: 57.1 ms at fit on hex rows against 40.6 (Top-down's 23.2), and 97.4 at 12 px on hex columns in a run whose Top-down match was not taken, so it cannot be classed yet. No relief stands at fit, so the cause of that move is not the relief draw. Neither recurred in the other runs here, and neither has been profiled. A miss the build before shows too is marked as existing on main. The lane profiles any largest move past its budget and reports it with its parts for review before adding machinery, as D-261030-538 says.

### 5.7 Memory

No canvas is added. Today's isometric canvases at 390 by 844 and DPR 2 are the ground stage, 780 by up to 3,376 device px (10.5 MB at most, 8.5 MB at 12 px on the hex fixture), the main stage's three layers at 5.3 MB each, and hit canvases at ratio 1 (1.3 MB each): about 28 MB. Top-down's stage is 0 by 0 while Isometric shows. The copy onto itself may take a transient copy inside the browser. The cap stays as it is: Konva's pixel ratio at most 2, the ground's lift margin at most one canvas height. Past it nothing new happens: a larger screen gets larger canvases, as today.

### 5.8 The ground stage and the sliding pills

The ground keeps its rules: taller by the lift margin, redrawn whenever its camera moves, as Top-down redraws its own layers on a pan. The applier moves it, so a pan renders none of its React layers. Its pills keep their points (`slide={false}`), so it takes the cull box's board view, which changes once a step.

The upright and moving places' pills slide into the clear part of the screen by the board view (`measure/Pill.tsx:18`): pin labels, area and trap names, turn start, move pills and ruler readouts. In Isometric a small provider around the overlay and drag layers subscribes to the slot and recomputes `boardViewsOf` each move, so an edge label keeps sliding through a pan. Those pills render each move, and only they.

## 6. No board render per camera move

### 6.1 What renders on a pan today

`scheduleCam` (`Stage.tsx:966`) sets `MapStage`'s camera state each frame. That renders:

- `MapStage` itself, with a new `layerProps` (`:1633`), `boardView` (`:1635`), `live` (`:1643`) and `pick`.
- Every controller, through the new `live`.
- `IsoBoard`, whose camera prop changed: its body (cull box, middle, `dc`), both stages' trees through react-konva, the iso layers given the new `layerProps`, `UprightLabels` with a new `ground` function each render, and every standee's and decor's element.
- The chrome over the map: the token and group action bars and the label, light, pin, trap, door pill, readout and stop note hosts.

That is the 4.5 ms of section 4 at 12 px.

### 6.2 How the camera reaches Konva

- A room-scoped `liveCameraSlot` (new `client/state/liveCamera.ts`) holds the camera on screen, with `subscribe`. It is the single source of truth: every camera path writes it, the setCam calls at `Stage.tsx:350`, `:398`, `:425`, `:501`, `:546`, `:557`, `:575`, `:584`, `:600`, `:613` and `:978` included. `camRef` reads the slot and is no longer assigned from state on each render (`:296`), so a render mid-pan cannot hand picks, `keepInView` or a second finger an older camera.
- `IsoBoard` registers an applier through its `onStage` path. It runs `scheduler.moveCamera`, which positions both stages at the slot's camera with its translation rounded to the device grid, `round(x·r)/r` with `r` the layer canvas's pixel ratio, and answers whether the view's snapped cull key is still the rendered one.
- In Isometric, `scheduleCam`'s frame writes a move at the same scale and turn to the slot and the applier. When the applier answers no, or the move changes scale or turn, and for every Top-down move, it also sets state as today.
- The isometric stages take no `x`, `y` or scale props. A layout effect after each board render applies the slot's camera, so a render can never write an older camera back.
- Picks read the applied camera, the one Konva draws with, so a press and the drawing agree.
- **Same frame for chrome and canvas.** The canvas shows a camera only when the scheduler draws it, a frame after the applier's marks or after a React commit's own (react-konva's attribute changes call `batchDraw`). So the slot keeps two values. `camera` is the latest, written at once, and gestures, picks, the applier and Konva-side readers (the sliding pills' provider of 5.8) read it. `drawn` is the camera the canvas last drew, advanced by the scheduler's `run` right after it draws the ground and relief at a new camera. The HTML chrome reads `drawn` on every render, whatever caused it: a camera-only move, a cull step, a zoom, or a parent render for some other reason. It subscribes through `useSyncExternalStore`, so the scheduler's notice renders it synchronously, before that frame's paint. In Top-down `drawn` follows the rendered camera, as today.
- When the gesture ends, `MapStage` sets its state to the final camera once.

### 6.3 What still renders, and why

- **`MapStage` and `IsoBoard`, once per cull step** (5.6): the layout, the culling of decor and areas and the area build's middle are React-owned.
- **`MapStage` and `IsoBoard`, once when the gesture ends:** `live` for the controllers and the saved and followed views then read the final camera.
- **The chrome hung on map points,** each move while it shows: the token and group action bars, rendered by a component in `Stage.tsx`, and the door pill, readout, stop note and the DM's label, light, pin and trap pane hosts. Each subscribes to the slot only in the part it mounts when it has something to show, so a mounted host showing nothing costs nothing. Their HTML clamps to the screen's edges, so they cannot move rigidly.
- **The sliding pills** of 5.8, each move.
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

**A cube's frames.** As built gives a 40 ft cube on alternating hex heights at 40 px one build frame of 21 to 25 ms, in which it stands, and an arrival frame of 55 to 56 ms against 1.75 times Top-down's 41 to 53. The standing frame holds a 6 ms build slice and the publish's repaint. The publish (`setVolumeTick`, `IsoBoard.tsx:353`) runs in React's default lane after the tick, and its commit's mark asks the scheduler for the next frame, where the tick requested earlier runs its slice first. A scratch run of four arrivals, which could not part the arrival from its build frames, found up to 12 ms of React, 7 to 10 of relief, 2.3 to 3.3 of overlay and 0.6 to 1.5 of ground in them together, the rest in the socket and the store. The repaint frame keeps a whole repaint, about 6 ms at 40 px, with the overlay: 13 to 16 ms expected once it carries no slice.

**One background budget** (D-261030-547). `FrameScheduler` owns the frame loop for background work as well as for drawing. A job registers with it (`scheduler.background(job)`), area builds now and any later job, and the scheduler asks for frames while any job has work. In each of its frames it first draws what is marked, then runs the jobs in turn with one budget shared between them: `max(0, min(6, start + 12 − now))` ms, `start` being when its callback began, so a heavy draw leaves the jobs less. It records, per frame, whether it performed a whole repaint and whether one was pending when the frame began. A frame that did either gives the jobs nothing. A mark that arrives after the scheduler's callback, from React's commit or another frame callback, is drawn in the next frame, which then gives the jobs nothing. So no slice lands in a repaint's frame whatever order the browser runs its callbacks in. The area tick's own `requestAnimationFrame` loop (`IsoBoard.tsx:339` to `:359`) becomes such a job. Panning across a cull step among standing areas restarts their build (its effect lists `cullKey`, `IsoBoard.tsx:359`), so pan frames slice too: a strip frame of about 8 ms plus a slice of at most 6 stays under 16, and the step's own frame, a whole repaint, slices nothing. The cube stands about one frame later. If that frame still passes 16 ms, the lane reports it with its parts, as design 9 says.

**The ground comparison.** `groundChanges` (`volumes.ts:203`) walks every cell of the scene on each sync whose heights are new, and on a player's board every fog change makes new heights. Timed in Node at full speed with real chunks and fog tiles, cold as after a fog change: 45,885 hexes on a 200 by 200 hex rows scene took 83 to 95 ms, about four times that at the bench's slowdown, and the 40 by 40 fixture's 1,778 took 3.4 ms. One 16 by 16 fog tile grown by a cell, 448 hexes, took 1.1 ms. So `DrawnHeights` carries its source (scene id, chunks, fog tiles, grid, bounds, feet and stand). When two snapshots share all but their tiles, `groundChanges` reads only the cells meeting a tile whose bits differ or that one side lacks, grown by one cell, since a hex's sub-cells can reach into the next tile. Any other difference keeps the whole pass.

## 9. The bench

`scripts/bench-iso.ts` adds, in both views, under one load, before and after interleaved as the HXREL-1 bench did, with the load average beside each round:

- **Pans** on hex rows, hex columns and a new fully raised 40 by 40 square fixture made by the hex fixture's generator on squares: at fit, 12 px, 23 and 24 px in Low power (flat, then standing) and 40 px. Low power rows reload the page with the setting on. The caps get a 12 px pan row too. Each pan row's median is gated. Its largest move is gated on the 40 by 40 fixtures against `max(16 ms, 1.75 × matched Top-down's largest move)` and reported on the caps (D-261030-538): the median of the three rounds' largest moves is gated, the single worst is reported, a miss the build before shows is marked existing, and every row, the 24 px Low power one included, takes Top-down's largest move from the same interleaved run.
- **Pans with a bar shown:** the 12 px and 40 px hex rows pans again with a selected token's action bar showing, on the DM's page and on a player's, gated like the rest.
- **Pans with pills:** the 12 px hex rows pan with about 30 pin labels and the four area names showing, gated like the rest.
- **Pans while areas build:** the 40 px hex rows pan long enough to cross two cull steps among the four areas, each step restarting their build, with every move gated and the moves that sliced named.
- **Counters,** each pan move in Isometric on an untimed pan: whole repaints, painted area as a share of the canvas for the scroll's strips, for the ground-edge repair of 5.3 and for their union, toned boxes, board renders (a test hook counts `IsoBoard` and `MapStage` commits), slices run in a frame that repainted whole, ground draws, patterns made, fills and strokes. Expected at 12 px: whole repaints and board renders about 0.08 (one a cull step), strips about 3%, ground-edge repair under 1%, union under 4%, slices in repaint frames 0, ground draws 1, patterns at most 1.
- **A 40 ft cube** on alternating heights, on both hex orientations and on the square fixture: the frame it lands in in both views, each frame until it stands with every frame gated, the repaint frame after the publish named, and the time from sending until it stands.
- **A fog change on a player's board:** the harness can hold a player, through the join API `e2e/areas.e2e.ts` uses (`/api/rooms/:id/join` and `/join/complete` with the room's password), in a second browser context. The bench sets a password when it makes the room, gives the player a PC with darkvision on a fogged scene, and times the player's page while the DM's socket reveals one fog tile a step. Rows: the 40 by 40 hex rows fixture with its four areas standing, and the 200 by 200 hex rows scene with the 500 ft emanation standing, in both views.
- **Parity:** the parity cameras move to translations whole in device pixels at DPR 2, so `--parity` and `--compare` stay mechanical in both views. Top-down must match pixel for pixel. Isometric may differ only where a batch straddled the ground canvas's edge (5.3), and where 5.2's batch rule breaks a batch at a culled piece that today's draw skipped before any flush (`drawRelief.ts:484` to `:487`), moving a seam. The compare lists both.

The gate is design 9's, unchanged: each frame metric at most `max(16 ms, 1.75 × matched Top-down)`, a warm turn at most 150 ms, every area-building frame held, and per D-261030-538 the largest pan move on the 40 by 40 fixtures. A row that still misses goes to review with its numbers.

## 10. The lane

### 10.1 One implementation lane

HXPERF-2 owns the whole change, in this order, tests beside each step.

| Part | Owned production files and reason |
|---|---|
| Kept picture | New `client/canvas/relief/kept.ts`, `scheduler.ts` (`moveCamera`, the relief's `drawScene` and its probe, the ground draw counter, the chrome's drawn notice, the background budget), `drawRelief.ts` (painted-bounds culling, layout batches, per-cell tone and its boxes), `IsoBoard.tsx` (no camera props on the stages, the applier, standee paint bounds for the child walk, the sliding pills' provider) |
| Live camera | New `client/state/liveCamera.ts`, `client/canvas/Stage.tsx` (every camera path, `camRef`, the bar component), `features/dm/CameraLayer.tsx`, the hosts' files: `builder/LabelPaneHost.tsx`, `lights/LightPaneHost.tsx`, `pins/PinPaneHost.tsx`, `traps/TrapPaneHost.tsx`, `doors/DoorPill.tsx`, `builder/heights/ReadoutHost.tsx`, `movement/StopNote.tsx` |
| Area frames | `IsoBoard.tsx` (the area build as a scheduler job), `client/canvas/relief/volumes.ts` (`groundChanges`), `client/lib/view.ts` (`DrawnHeights` source) |
| Acceptance | Unit files beside each, `e2e/iso.e2e.ts` with the HXPERF2 step prefix, `scripts/bench-iso.ts` and its test |
| Docs commit | This note's As built, `docs/design-v1-iso-hex-relief.md` section 11 (the misses closed or reported), `docs/design-v1-isometric-view.md` 5.1 (the scheduler's rules) |

No visible change is intended, so FEATURES.md and the DM guide need no edit. If the build changes anything a person can see, FEATURES.md takes it in the docs commit.

### 10.2 Tests

- **Kept picture units** (`kept.test.ts`): each whole-repaint cause of 5.4 repaints whole, a camera-only move scrolls, the regions for each sign of `dx` and `dy` and both, a shift as large as the canvas, a mark inside and outside `moveCamera`, a ground draw by the scheduler for the camera, by it for content and by Konva directly, the device-grid rounding at ratios 1, 1.25, 1.5 and 2 with repeated reversals, the path for another canvas, the scroll path skipping children whose painted bounds meet no region, and the probe: run at the first draw with a nonzero size before anything paints, run again after a 0 by 0 draw or a thrown readback, and only a completed wrong read leaving whole repaints from then on.
- **Ground edge units:** a connected pit near the screen's top and a top under a capped margin, panned down and up, each repainting the cells that gain and lose ground, and a batch straddling the canvas's edge toning only its own edge cells.
- **Cull step units:** the move that changes the cull key sets state once and repaints whole, and a move inside it renders nothing.
- **One randomized test** (`kept.random.test.ts`, seeded): 400 sequences of 40 events on hex rows, hex columns and squares at ratios 1.5 and 2, each a small, large or canvas-sized pan, a cull step, a zoom, a turn, a height or wall edit, a fog reveal, an area standing, a selection, a token moved or a texture arriving, through the board's real `ReliefIndex.layout` and `drawRun` on a canvas that rasterizes at points, as `reliefOracle.test.ts` does, extended with clip rectangles, translation on the device grid, a copy onto itself, strokes with their widths, standees by their paint bounds, and a ground canvas of its real extent whose out-of-canvas pattern samples are transparent. Invariants: after every frame the kept canvas equals a whole draw of the same state at every sample point. A camera-only move paints at most `|dx|·H + |dy|·W` pixels plus the toned boxes' area. Any other mark repaints whole.
- **Live camera units:** a pan inside the cull box sets no `MapStage` state, a `MapStage` render mid-pan neither moves the stages nor resets `camRef`, every camera path writes the slot, the gesture's end sets state once, Top-down sets it every move, a host showing nothing does not subscribe, the HTML chrome renders the drawn camera after a camera-only move, a cull step, a zoom and an unrelated `MapStage` render, and moves only when the scheduler has drawn, the pills' provider hears at the write, a move leaving the rendered cull box renders the board with `flushSync` in its frame, a press reads the applied camera, and the camera controller publishes on each move without a render.
- **Background budget units:** a frame that repaints whole, or began with one pending, runs no job, with the mark landing before the scheduler's callback and after it, and with the publish's commit landing in either frame. Two jobs share one 6 ms budget. A strip-only frame runs jobs.
- **Area units:** `groundChanges` by changed tiles equals the whole pass on random chunks and fog, for both hex orientations and squares, including a hex whose sub-cells cross into the next tile, and keeps the whole pass for two equal-sized scenes sharing the room's chunk object.
- **Mutation checks,** each to be killed: a shift on whole CSS pixels at ratio 1.5, a strip one pixel short, the second strip dropped, strips tested as one bounding box, culling by geometric bounds, standees culled by frame and ring, toned boxes recorded per batch, the losing-ground boxes dropped, a whole repaint culling by the render's view, a ground draw by Konva taken as a camera draw, every mark taken as a camera move, scale, turn or pixel ratio left out of the kept key, batches by the region drawn, the scroll path drawing every child, the probe failing on a 0 by 0 first draw, no whole repaint for a canvas-sized shift, camera props back on the stages, `camRef` assigned from state, the chrome reading the rendered camera, the HTML chrome reading `camera` rather than `drawn` on a cull step or a zoom, chrome subscribing through `useState` in an effect, background jobs given 6 ms whatever the draw took, a slice in a frame that repainted whole, a slice in a frame that began with a repaint pending, the tile pass used across scene ids, a tile not grown by a cell.

### 10.3 E2E

`e2e/iso.e2e.ts` step HXPERF2, on hex rows, hex columns and squares at 390 by 844 and DPR 2, and on hex rows at DPR 1.5: pan in 37 small moves and back by touch, by Space with the left button and by the middle button, then compare the relief canvas with a whole repaint at the same camera, forced through the test hook (`relief/isoTest.ts`), within 2/255 a channel, and report the largest difference. Again across two cull steps, with a pit floor by the screen's top, with a height edit from the DM's socket mid-pan, with a fog reveal on a player's page, and with a turn. Through a pan, the selected token's action bar stays under its token within 1 px at each sampled move, reading the bar's rectangle and the token's position in the same frame, from the last drawn camera (the test hook) or the canvas's pixels, never a Konva node's transform, through a pan, a cull step and a pinch, at 100% and 130% interface size, and a pin label at the screen's edge stays in view.

Run `iso`, `hex`, `areas`, `traps`, `pervision`, `vision`, `fogedge`, `alignment`, `alignment-wide` and `reach`: the relief, both grids, areas over relief, trap names, per-player boards, sight, the fog's edge and the alignment sweeps. Also `display` (the table display follows the DM's pan), `bardock` (the bar's docking through a pan) and `swipe` (touch pans).

### 10.4 UI checklist

- **Words shown:** none new. "Loading the isometric view" and "Building area shapes" stay.
- **Loading:** unchanged. A whole repaint is today's frame, so nothing new waits.
- **Keys, touch and focus:** unchanged. Pinch, one- and two-finger pans and mouse pans (Space with the left button, the middle or right button, `mousePanRef`) keep their behavior. A pan moves no focus.
- **Screen readers:** unchanged. The canvas adds no focus target and announces nothing new.
- **Large interface sizes and alignment:** no DOM layout change. The chrome takes its camera from the slot through the same zoomed conversions (`cameraInZoomed`), checked by the e2e bar step at 100% and 130%. The alignment sweep's roots already cover the action bar and hosts in `e2e/alignmentRoom.ts`. The lane confirms that and adds a root only if one is missing.

### 10.5 Cases

| Case | Expected | Test |
|---|---|---|
| A pan within the cull box, hex rows, hex columns and squares, ratios 1, 1.25, 1.5, 2 | Regions only, canvas equals a whole draw, no board render | kept units, randomized test, iso e2e |
| A move that changes the cull key | One board render, whole repaint, largest move gated on the 40 by 40 fixtures | cull step units, randomized test, bench largest move |
| A pit floor by the top, a top under a capped margin, panned | Cells gaining and losing ground repainted | ground edge units, randomized test, iso e2e |
| A selected area's outline or a standee's caught ring crossing a strip's edge | Drawn by its painted bounds, clipped exactly | kept units, randomized test |
| A jump as large as the canvas (Find, follow the turn) | Whole repaint | kept units |
| Pinch zoom, a turn, Low power toggled, the interface size changed | Whole repaint each time, as today | kept units, iso e2e |
| A height edit, a wall, a fog reveal, a map set mid-pan | Whole repaint that frame, then strips again | randomized test, iso e2e |
| A standee's own update, a ground draw outside the scheduler | Whole repaint | kept units |
| The self-copy probe: a 0 by 0 first draw, a thrown readback, a wrong read | Probe again, probe again, whole repaints from then on | kept units |
| A local drag, a remote ghost, a ping during a still camera | Relief not drawn, as today | bench ground counters, iso e2e |
| An area standing while panning, a pan across cull steps among building areas | Whole repaint after its publish, no slice in any frame that repaints whole, in either callback order | background budget units, bench cube and building rows |
| The action bar, door pill, readout and an edge pin label during a pan | Follow the camera the canvas last drew, every move, clamped and sliding as before | live camera units, iso e2e, bardock |
| A `MapStage` render mid-pan | Stages and `camRef` keep the slot's camera | live camera units |
| The table display following the DM | Same views sent as now | display e2e |
| Bench parity at device-aligned cameras | Top-down pixel for pixel, Isometric listed | `--compare` |
| A fog change on a player's board with an area standing, 40 by 40 and 200 by 200 | Comparison reads only changed tiles, same answer as the whole pass | area units, bench fog rows |

### 10.6 Real phones

No real-phone timing is claimed. The copy onto itself is probed at the first sized draw on every browser, with today's whole repaints as the fallback, and the coordinator's phone pass checks Safari on an iPhone.

## 11. As built

To be filled in by the builder in the lane's docs commit, with every place the build went its own way, its checks, its mutation results and its bench rounds.
