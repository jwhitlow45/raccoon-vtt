# raccoon-vtt design: finding a map's drawn grid on import

Status: design and prototype, for the project owner's decision. Nothing here ships yet. The prototype is `client/features/grid/detect.ts` with its tests, and the numbers below come from it.

The project owner asked: "it would also be sick to have a feature that detects pre-drawn lines on import and then aligns the grid to them automatically (adjustable after the fact of course). Please let me know if this is a feasible feature or very difficult/computationally expensive."

Short answer: feasible, and cheap. On this Mac (M1 Pro) it takes 23 ms for a 1000 px map and under 0.3 s for an 8000 px one, in a browser Worker as fast as in Node. That is less than the upload itself, so it can run while the map uploads. On maps with a drawn grid it finds the right squares to a few hundredths of a percent and the right lines to a third of a pixel. The hard part is not speed. It is knowing when not to believe it. A floor of square tiles is a drawn grid to any method that looks at lines, so the found grid should always arrive in Line up grid, where the DM sees it and can put it right with one tap.

## 1. What exists

- A map upload answers with its canonical size and, from a name like `crypt_30x20.jpg`, a cellPx (`server/assets/kinds.ts` `cellPxHint`, `client/features/scenes/upload.ts`). Otherwise `initialMap` guesses about 30 squares on the long side, origin 0 (`client/features/scenes/create.ts`).
- A new map scene without a size in its name opens Line up grid (`NewScene.tsx` `createFromAsset`). The tool fits the grid by a 3 by 3 box, its corners and Nudge, or by counting squares (`client/features/grid/`). That flow is how the DM adjusts afterwards.
- The app's grid is square and axis-aligned: one `cellPx` and an `originPx` (`shared/model.ts` `SceneMap`). There is no hex grid and no rotated grid. A Universal VTT import brings its own grid (`client/features/uvtt/batch.ts`).
- There is no batch upload of several maps today. New scene takes one file.

## 2. The method

`detectGrid(pixels, { hintCellPx })` takes decoded pixels (gray, RGB or RGBA) and returns the square size in px (sub-pixel), where a pair of lines cross, a confidence from 0 to 1, and each axis's measures, or "no grid" with the reason. It is pure and synchronous, with no dependency.

1. **A thin-line filter.** A pixel counts toward a vertical line when it is darker than both pixels `d` to its left and right, by the smaller difference, capped at 64 gray levels. Light lines are counted apart. A step edge (a wall's side, a shadow, the rim of a room) has one side level with the pixel and counts for nothing, so most art drops out here. `d` grows with the image, from 3 to 6 px, so a line and its antialiased edge always fit inside it.
2. **Profiles.** Those responses summed down each column and along each row: four profiles (two axes, two polarities). A line that runs the map's length adds up over thousands of rows, and art that does not line up from row to row averages away. Large maps sample every second to fifth row, which loses nothing measurable (section 4).
3. **Period and phase.** Candidate periods from each profile's autocorrelation. For each, the period is refined by the Fourier magnitude near it, the phase comes from the Fourier argument, every predicted line is looked for, and a robust line fit (Theil-Sen, then least squares on the lines it keeps) gives the square size to a hundredth of a pixel or better. A line's center is the centroid of its response, so lines that fall between pixels, as 70.4 px squares do, are found where they are.
4. **Checks before it is believed**, on both axes at one square size: enough lines (4), strong against the profile's noise (5 times), at least 60% of the predicted lines found, evenly spaced, and nothing as strong halfway or a third of the way between them (or the squares are smaller). Odd lines much weaker than even ones on both axes mean the squares are twice the size. The two axes may differ by 1.5% at most. Sizes that pass are grouped into families of a pattern and its whole multiples, and each family is judged by its smallest member, so 5 squares cannot pass as one.
5. **A last look along the lines.** A drawn line runs on from one square to the next. The joints of staggered bricks stop at every course, and a grid turned 45 degrees shows only at its crossings, so their sides take turns or scatter. The lines must also sit in the same place in both halves of the image. A turned grid's lines move, and more than 3 px across the map (or 1% of a square, on large squares) is refused, since the app cannot turn its grid.

A size from the file name is tried first. If the image bears it out, the result says so and gives the origin, which the name cannot. If not, the image is searched as usual and the result says the two differ. In the evaluation all 10 right names were borne out, one of them on a map whose grid was missed without the name, and both wrong names that met a found grid were reported as differing.

## 3. Accuracy

Right means the square size within 1% and the origin within 1 px of the truth. Confidence of 0.6 and over is "high", 0.3 to 0.6 is "medium", and under 0.3 is no grid.

**Code-drawn maps (270).** Procedural noise, gradients, tiles, planks, bricks, checkers and hex grids from `synthetic.ts`, plus 66 maps composited from CC0 textures (Poly Haven) and the repo's own credited textures and stamps, with rooms, walls and grids drawn as SVG in seven styles. Squares of 18 to 300 px, half of them fractional, origins anywhere, JPEG or WebP at quality 15 to 92, some resized to put the squares off whole pixels.

| Maps | Count | Right | No grid | Missed | Wrong, high | Wrong, medium |
| --- | --- | --- | --- | --- | --- | --- |
| Drawn grid: noise, faint, dashed, floor only, margin | 88 | 87 | | 1 | | |
| Drawn grid over tiles, planks, bricks | 18 | 14 | | 3 | | 1 |
| Drawn grid on textured maps | 36 | 27 | | 9 | | |
| Drawn grid, size in the file name, 10 right and 4 wrong (maps from the rows above) | 14 | 12 | | 2 | | |
| No grid: noise, gradient, JPEG blocks, planks, bricks, checkers | 49 | | 49 | | | |
| No grid: hex, turned 0.2 to 45 degrees, unsquare | 23 | | 23 | | | |
| No grid: textured maps (6 with walls on an unseen grid) | 30 | | 29 | | | 1 |
| No grid, size in the file name (maps from the row below) | 2 | | 2 | | | |
| No grid: square floor tiles edge to edge | 10 | | | | 10 | |
| **All** | **270** | **140** | **103** | **15** | **10** | **2** |

Of the 140 right, the square size is off by 0.0013% at the median and 0.04% at worst, and the origin by 0.08 px at the median and 0.34 px at worst. Eight of the 15 misses are the two faintest styles (1 px lines at 15% black, or 1 px dashes at 25%, over busy textures, often downscaled), which the eye barely sees either. Three are bricks whose mortar lines, a quarter of a square apart, are as strong as the grid.

**Real maps (30), openly licensed, for evaluation only and not committed.** Seventeen with a square grid (Dungeondraft exports whose `.dd2vtt` states the size, Dyson Logos and Spears of the Dawn maps checked by eye at both far corners), ten without, three hex.

| Maps | Count | Right | No grid | Missed | Wrong |
| --- | --- | --- | --- | --- | --- |
| Square grid | 17 | 13 | | 2 | 2 |
| No grid | 10 | | 9 | | 1 |
| Hex grid | 3 | | 3 | | |

The 13 right include a hand-drawn wobbly grid on a 7200 px cave, grids under heavy hatching, dotted Dungeondraft grids over planks and stone tiles, and a grid on only half the page. The three wrong are in section 5, all with high confidence. Sources and licenses are in the report for this stage.

## 4. Cost

On this Mac, one core, maps of the given side, JPEG at quality 85. "Detect" is the median of five runs. Chrome is headless Chrome in a module Worker: fetch, `createImageBitmap`, an `OffscreenCanvas` and `getImageData`, then `detectGrid`.

| Side | Node detect | Every row | Chrome Worker detect | Chrome decode and pixels | Chrome extra memory |
| --- | --- | --- | --- | --- | --- |
| 1000 | 23 ms | 22 ms | 23 ms | 5 ms | 33 MB |
| 2000 | 66 ms | 63 ms | 67 ms | 16 ms | 39 MB |
| 4000 | 156 ms | 238 ms | 157 ms | 59 ms | 187 MB |
| 8000 | 286 ms | 820 ms | 285 ms | 242 ms | 597 MB |
| 8000, decoded at 2048 | | | 76 ms | 219 ms | 335 MB |

- Detection itself needs about 20 MB beyond the decoded pixels (Node, 8000 px: 22 MB). The pixels are the cost: 244 MB of RGBA at 8000 px, and Chrome holds the bitmap and the canvas too.
- The pass that builds the profiles is half to two thirds of the time (8000 px: 138 of 273 ms). The rest is fitting candidates and the look along the lines. So a coarse pass on a downscaled copy, then a refinement at full size, saves nothing: the refinement is another full pass. What pays is sampling fewer rows (8000 px: 820 to 286 ms, same answer) and decoding small. A 2048 px copy of the 8000 px test map gives the size within 0.01% and the origin within 0.34 px after scaling, so no refinement is needed.
- On the real maps over 4096 px, a 4096 px copy agrees with full size within 0.25 px on four, finds no grid on the same two as full size, keeps the faint tavern's wrong half size, and is 2.2 px off on the hand-drawn cave, whose lines wobble that much. One flips: the lich tomb, right at full size and at 2048, takes the half size at 4096, where its tile seams sit near the halfway threshold. At 2048 two faint dotted grids are lost.
- Phones were not measured. Expect two to four times slower: still about a second in a Worker for the largest map.

## 5. What fools it

- **Square floor tiles laid edge to edge with no drawn grid** read as a grid of the tile size, with high confidence: 10 of 10 code-drawn tile floors and the one real tile room. Tile seams are drawn lines. No measure tried (brightness steps across lines, line contrast) told them apart on real maps: walls drawn on grid lines look the same.
- **Tiles half a square wide over most of the map** pick the half size when the grid itself is faint. One real map: an ornamental tavern floor under a very faint dotted grid gave 64 px squares for 128 (confidence 0.76). Where tiles fill only a room, the clear space elsewhere keeps the true size (the lich tomb, right).
- **Few squares under busy art** can be right in size and a couple of pixels off in place: a 10 by 10 map of 256 px squares on diamond tiles was 0.2% off in size and up to 2.8 px off at its edges.
- **Two drawings on one page, each with its own grid out of step with the other** (two floors stacked, two buildings) answer no grid. The scene has one grid, so the DM lines up the part they need.
- **Very faint or sparse lines** under busy art answer no grid rather than a guess.
- Not supported, by design: hex grids (the app has none) and turned grids answer no grid. Squares taller than wide answer no grid: the app's squares are square, and a hair of difference from a resized image (up to 1.5%) is averaged, as counting squares does. The smallest square looked for is 10 px, or the long side over 200, the scene limit. A grid in a color with the same brightness as the art under it is invisible to the filter.

Every one of these lands in Line up grid (section 6), where the DM sees the box on the art.

## 6. The product

**Where it runs: in a Worker on the DM's device, while the map uploads.** The upload is bound by the network and the detection by the processor, so they overlap and the DM waits for neither. The repo already decodes large maps in a Worker for the Universal VTT import (`client/features/uvtt/worker.ts`), with the same limits. On the server it would cost the shared box 0.1 to 0.3 s of JavaScript per map on the thread that serves every room, unless a worker thread were added, and the upload answer would change. The client costs the server nothing and changes no data, protocol or API.

**The steps**, when the DM picks a map file in New scene:

1. Start the Worker on the file at once. It decodes at most 4096 px on the long side (`createImageBitmap` with `resizeWidth` and `resizeHeight`, oriented from the file's EXIF as the server orients it), which also keeps within the 16.7 million pixels iOS will draw. It runs `detectGrid` with the size from the file name if there is one.
2. When the upload answers, scale the result by the canonical width over the decoded width (the server shrinks maps over 8192 px). If the Worker is not done, wait up to 2 s more, saying "Looking for a grid…" with the upload's busy indicator, then go on without it. A decode that fails (a phone out of memory) is the same as no grid. Cancel ends the Worker.
3. Make the scene by the result:
   - **High confidence, or the name's size borne out:** the scene starts with the found `cellPx` and `originPx`, sized to the squares (`fitBounds`). Line up grid opens with the box on 3 by 3 found squares near the middle, and the strip says "Found a grid of 70.4 px squares." with **Use default** beside Apply. Use default sends one `scene.setGrid` back to today's first guess, and undo takes it back too. For a name whose size the image bears out, Line up grid stays closed, as it does for a hinted name today, but the origin is now the image's.
   - **Medium:** the scene starts with today's guess. Line up grid opens with the box already on the found squares, not applied, and the strip says "These lines may be the map's grid: 70.4 px squares. Check the box, then Apply."
   - **No grid:** today's flow.
4. Replacing a scene's map image does the same when the new image is not the old one at another size (`replaceMap` falls back to `initialMap`).

**Several maps at once** does not exist yet. When it comes, one Worker takes the files one at a time (memory, not speed, is the limit), each scene is made by its own result, and the list marks each map "grid found", "check the grid" or "line up the grid".

**A Universal VTT import never runs it.** The file states its grid exactly.

## 7. Building it

The prototype's method stays. The build is the plumbing and the strip.

| Part | Files | Size |
| --- | --- | --- |
| Detector, with its tests and code-drawn maps | `grid/detect.ts`, `detect.test.ts`, `synthetic.ts` | about 1,260 lines, written |
| Worker: decode at 4096, detect, post | `grid/detectWorker.ts` | about 80 lines |
| Client side: start, wait with a deadline, cancel, scale, a randomized test of cancel, timeout and late answers | `grid/findGrid.ts` and its test | about 200 lines |
| New scene and replace image | `scenes/NewScene.tsx`, `create.ts` (`initialMap` takes a found grid), `SceneSettings.tsx` | about 80 lines and tests |
| Line up grid: the found box, the strip's line, Use default | `grid/tool.tsx`, `Options.tsx`, `store.ts` | about 70 lines |
| e2e: a code-drawn gridded map through New scene | `e2e/maps.e2e.ts` | about 60 lines |
| FEATURES.md and the DM guide | | a few lines |

About 500 lines of new code and tests beyond the detector: one build lane and one review round.

## 8. Tests

- `client/features/grid/detect.test.ts` (18 tests, about 2 s): fractional squares off the image's edge, RGBA as a canvas gives it, light lines on dark art, a faint grid under busy art, a grid on the floor of rooms only, a grid inside a margin, dashed lines, a grid over tiles half its size. No grid on noise, JPEG-like blocks, staggered bricks, staggered planks, a hex grid, a turned grid, or squares taller than wide. A file name's size borne out, and one the image does not bear out. Every image is drawn by code (`synthetic.ts`).
- The evaluation of section 3 and the timing of section 4 ran from scripts outside the repository, with the downloaded maps. The build keeps the unit tests and adds one e2e step (section 7).

## 9. Questions for the project owner

1. With high confidence, should the found grid go on the scene at once, with Line up grid open to check it (recommended, as asked), or only fill the box until the DM taps Apply?
2. When the file name's size and the drawn lines disagree, which wins? Recommended: the name, since someone typed it, with Line up grid open and the strip offering the drawn lines' size.
