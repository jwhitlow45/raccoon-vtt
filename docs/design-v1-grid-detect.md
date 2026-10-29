# raccoon-vtt design: finding a map's drawn grid on import

Status: shipped for squares. Section 10, hex grids, is built: every search looks for squares and hexes (10.11). Section 6.1 is what the build and its review changed. Sections 6 to 9 are the proposal and its questions as they went to the project owner, kept as history: the answers are in 6.1. The detector is `client/features/grid/detect.ts` with its tests, and the numbers below come from it.

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
- Not supported, by design: turned grids answer no grid. Hex grids were not searched before phase H3. Since H3 every search looks for squares and hexes, on square and hex scenes alike, and only a sure find of one shape alone switches the scene (section 10). Squares taller than wide answer no grid: the app's squares are square, and a hair of difference from a resized image (up to 1.5%) is averaged, as counting squares does. The smallest square looked for is 10 px, or the long side over 200, the scene limit. A grid in a color with the same brightness as the art under it is invisible to the filter.

Every one of these lands in Line up grid (section 6), where the DM sees the box on the art.

## 6. The product, as proposed

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

### 6.1 What the build changed

The project owner answered section 9: a grid found with high confidence goes on the scene at once, with Line up grid open on it and Use default one tap away, and a size in the file name wins.

- **The name wins by not searching.** A file whose name gives a size is not searched at all, and a name whose counts the server refuses is searched once the upload says so. The "name's size borne out" path is gone.
- **The guess first, then the found grid.** The scene is made with today's first guess, and a found grid follows at once as one undo step: `scene.setGrid` and the scene's size together (`dispatchGesture`). One undo, or Use default, puts the guess back. `create.ts` makes scenes as before.
- **Find the grid**, asked for after this note, sits in Line up grid's options and beside Line up the grid in the scene's Grid settings, for any scene with a map, at any time. It fetches the scene's phone-sized copy (at most 4096 px, the full image if that fails) into the same Worker, gives it 30 s, and says "Looking for a grid…" meanwhile. High confidence applies as one undo step, medium places the box, and none says "No grid found. Drag a box over 3 by 3 squares instead." It runs whatever the file's name or kind, but on a scene that came with its own grid from a Universal VTT file it never applies: at any confidence it places the box and says "This scene came with its own grid.", since that grid is exact and the walls stand in its squares. The import marks its scene (`Scene.gridFromFile`, op version 9 and snapshot version 13), so the protection holds whatever the DM changes later, Automatic walls included, and an ordinary map with automatic walls off is searched and applied as any other. A scene imported before the mark counts by the one sign only the import leaves, a first grid line before the image (`cameWithGrid`).
- **Apply and a move of the box end a running Find the grid**, as closing the tool does (`endFinding`): a drag, a tap or a nudge. An answer that still comes is dropped unless the scene shows the same image with the same grid and size as when the search began, so a grid applied meanwhile, on this device or another, is never overwritten. A grid found and dropped so is said on the options line: "The scene changed, so the grid found was not applied." One that found no grid on a scene changed meanwhile leaves the line's hint as it was.
- **A found grid keeps its measured origin** (`calibrationFromFind`). The 5% snap a hand-drawn box gets (LP5-OPS-4) moved a line found 6 px in onto the image's edge, off the drawn lines. Only an origin within 1 px or 1% of a square under a whole square, whichever is larger, folds to the edge, so a line found just before the edge keeps the art's first row and column in the scene. The box a search left stands for that grid, in Apply and the drawn lines, until it moves.
- **The decode is sized by the upright picture.** The browser turns a JPEG by its EXIF orientation before it resizes, as the server turns its copy, so for orientations 5 to 8 the header's sides swap (`decodeSize`). Asked for the unturned size, it squashed the picture and no grid was found.
- **A phone or an iPad decodes a picked file only up to 4096 px a side.** WebKit decodes the whole picture before it resizes it, and an 8192 px map's full decode in the middle of its upload could end the tab. So a file larger on either side, or one whose header gives no size, is searched on the server's phone-sized copy once the upload answers, as Find the grid searches (`importSearchFrom`). The copy alone: a phone or an iPad never falls back to the full image when the copy fails, which would be that same decode, so there it is no grid found, for Find the grid too (`copyUrls`). The 2 s wait after the upload holds, but a search of the copy that has not answered by then goes on after the scene opens, in Line up grid, which says "Looking for a grid…" (`ImportWait.later`, `landSearch`). It lands as Find the grid's late answer does: only on an unchanged scene, a sure find as one undo step with the note and Use default, a doubtful one by the box. Leaving the scene and Line up grid's own actions end it. A computer, and a small file anywhere, keep the search from the pick, which the wait ends.
- **Use default puts back the grid and the scene's size** from before the find, not a size fitted to the old grid. A battle mat that took its first image, or a scene that took new art, had a size of its own.
- **Replacing a map image** searches the new file while it uploads. Since FU35-B (10.11) the same file keeps the grid unsearched, and art of the old image's shape keeps the grid, scaled, and only offers a find that differs from it (`replacement` and `sameImageShape` in `create.ts`). Before, art of the old shape was taken for the old art at another size and never searched. A grid found on other art opens Line up grid, as on a first image. With none found, the replacement keeps today's behavior. On a scene that came with its own grid, new art keeps the mark, since the imported walls stay and stand in the file's grid, so its search only offers, as Find the grid's does (`replacementFound`).

## 7. Building it, as planned

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

## 9. Questions for the project owner, answered in 6.1

1. With high confidence, should the found grid go on the scene at once, with Line up grid open to check it (recommended, as asked), or only fill the box until the DM taps Apply?
2. When the file name's size and the drawn lines disagree, which wins? Recommended: the name, since someone typed it, with Line up grid open and the strip offering the drawn lines' size.

## 10. Hex grids (H3)

Status: built. The finder, `client/features/grid/detectHex.ts`, was measured and reviewed to consensus in three rounds (HX9A-ASTRA-01 to 04, HX9A-OPUS-01 to 06), and HX-9c wired it into Find the grid and new scenes as 10.7 says, with the changes in 10.11. Phase H3 of docs/design-v1-hex-grids.md asked for "a hex detector for Find the grid, measured on the evaluation's code-drawn hexes and its three real hex maps before it may apply anything". The project owner added: "The grid detection in particular should automatically detect square or hex so the user does not have to pick which one".

Short answer: hexes are found as surely as squares, and a square grid is never read as hexes. On 92 code-drawn hex maps it finds 91, to 0.04% in size and a quarter pixel in place. Over square grids, triangle grids, turned hexes, hexes 1.1% or more out of shape and art without a grid it answers no grid every time. Hex tiles under a square grid are hexes to it, so when both shapes are found the surer is only offered. On real maps it finds the 4 regular hex grids it can see, refuses the 2 drawn out of shape, and finds no hexes on 13 real square-grid exports. All three looks (squares, hex rows, hex columns) take about 0.6 s on a 4096 px map on this Mac (an M5 Pro), in the Worker that already runs.

### 10.1 The method

`detectHex(pixels, { orient })` takes the same decoded pixels as `detectGrid` and the orientation to look for. It answers the cell (the distance between hex centers across the flats, the app's cell), the hex center nearest the image's middle, a confidence from 0 to 1, and Line up grid's box on that hex and its six neighbors (HX-D12: 3 by 2.89 cells on hex rows, 2.89 by 3 on columns), or "no grid" with the reason. It is pure and synchronous, with no dependency. Hex columns are hex rows with x and y swapped, so their image is read transposed and every step below is written for rows.

1. **Three families of sides.** Each family lies on parallel lines half a cell apart, and each line is drawn for a third of its length: a side, then two thirds through hexes. The upright sides are found with section 2's thin-line filter across x. The sloped sides, 30 degrees off level, with the same filter across y, reaching 1 / cos 30 farther since a sloped line is that much thicker down than across.
2. **Three profiles.** The upright responses summed by x, and the sloped ones by the distance along each family's normal, each response shared between the two nearest bins so a line keeps its place to a fraction of a pixel. Sides of the other two families smear across a whole period and add only an even floor.
3. **Period and phase**, as section 2 fits an axis, for each profile. The three periods must agree within 1%. The three families' lines nearest the image's middle, each placed by its own period, must meet at one point: the upright line's place is the difference of the sloped ones', within 1.5 px or 5% of the period, whichever is larger. Measured at the middle, a slight difference in period cannot add up to a miss there. On small hexes the line's reach shrinks with the period, so lines half a cell apart stay apart, and the shortest periods nearly as strong as the strongest are always tried, since every multiple of a period peaks as high.
4. **Which lattice holds the centers.** Where the three families cross are hex centers and both kinds of corner, three lattices a corner's distance apart. Each predicts different sides, and every predicted side is looked at in the image, less the same line a quarter cell inward. The lattice whose sides are drawn wins. Its sides must be at least twice as strong as the best other lattice's (`broken` 0.5 or more), or the lines run on through the hexes and are not hexes. The confidence is the profiles' confidence times how cleanly the sides break, from 0 at `broken` 0.5 to 1 at 0.8, and a find under 0.3 after that is refused. Every fit that passed the profiles is looked at, and the surest after the look is kept. The center is the hex center nearest the image's middle, which on staggered rows may be in the row above or below the nearest row.
5. **Turned grids and hexes out of shape**, from how each family's lines lean: each line found in both the top and bottom halves of the image is compared with itself, its move along the normal over how far apart its two parts lie down the image, measured from where its responses lie. A turn leans the upright sides, so they must move under 3 px across the map, as section 2's lines must. Hexes stretched or squeezed across or down leave the upright sides upright and lean both sloped families the same way, by cos 30 times the stretch, where a turn leans them opposite ways. So half the sum of the two sloped leans, over cos 30, is the stretch whatever the turn, and 1% or more is refused. The profiles' periods cannot tell this: a leaning line moves along its normal as it crosses the map, and its period over the whole map depends on the map's shape.
6. **A second look at half size**, only when the first found nothing and saw no grid turned or out of shape. Lines wider than about 6 px, twice the filter's 3 px reach on maps up to 4096 px, have their middle no darker than the pixels the filter compares it with, and show only as two edges. At half size they fit inside it. The limits in pixels (the meeting point, the turn, the even spacing's 1 px floor) halve, so the second look is no looser in the image's pixels.

### 10.2 Accuracy

Right means the cell within 1% and the center (and the box's middle) within 1 px of a drawn hex center. Confidence tiers are section 3's: 0.6 and over high, 0.3 to 0.6 medium, under 0.3 no grid.

**Code-drawn maps (192 maps, 280 runs).** `synthetic.ts` draws hex grids as the app lays them, either orientation, any cell and center, line weight, gray, floor only and turn. Maps of 760 to 2000 px, hexes of 14 to 300 px, half of them fractional. Out-of-shape maps are drawn taller or shorter and resized to the map's height. A map with hexes is asked for its own orientation, and a map without is asked both ways.

| Maps | Runs | Right | No grid | Missed | Wrong |
| --- | --- | --- | --- | --- | --- |
| Hexes on noise, lines 1 to 3 px wide | 30 | 30 | | | |
| Hexes faint (15 to 25%), or light lines on dark art | 10 | 10 | | | |
| Hexes over square tiles, planks, bricks, checkers | 12 | 11 | | 1 | |
| Hexes on the floor of rooms only | 8 | 8 | | | |
| Hexes as JPEG at quality 15 to 92, half resized to 0.6 to 0.9 | 20 | 20 | | | |
| Hexes turned 0.05 to 0.1 degrees (lines within 3 px) | 8 | 8 | | | |
| The older hex art in `synthetic.ts` | 4 | 4 | | | |
| Hexes 0.3 to 0.9% out of shape (found is right) | 12 | 12 | | | |
| No hexes: hexes turned 0.5 to 20 degrees | 24 | | 24 | | |
| No hexes: hexes 1.1 to 5% out of shape | 24 | | 24 | | |
| No hexes: square grids, plain, JPEG, over square tiles | 60 | | 60 | | |
| No hexes: art without a grid (noise, gradient, JPEG blocks, planks, bricks, checkers, tiles, rooms) | 32 | | 32 | | |
| No hexes: triangle grids, lines in the hexes' three directions | 12 | | 12 | | |
| Square grids over a floor of hex tiles (the tiles are hexes) | 24 | | 15 | | 9 |
| **All** | **280** | **103** | **167** | **1** | **9** |

Of the 91 right on regular hexes, the cell is off by 0.0013% at the median and 0.039% at worst, the center by 0.03 px and 0.23 px. The miss is 75 px hexes over 49 px square tiles. No run found the wrong orientation. The 9 wrong are hex tiles found as hexes under a square grid, on 9 of 12 such maps, at 0.62 to 0.89: they are drawn hexes, and 10.6 says what keeps them from replacing the squares.

**The shape picked** (`pickShape`, 10.6) over the same maps, from all three looks on each:

| Kind | Maps | Right shape | No grid | Other shape | Contested |
| --- | --- | --- | --- | --- | --- |
| Regular hexes, all kinds above | 92 | 91 | 1 | | 4 |
| Hexes 0.3 to 0.9% out of shape | 12 | 12 | | | |
| Square grids, plain, JPEG, over square tiles | 30 | 29 | 1 | | |
| Square grids over hex tiles | 12 | 9 | | 3 | 8 |
| No grid: turned hexes, hexes 1.1% or more out of shape, triangle grids | 30 | 30 | | | |
| No grid: art (squares found on 2 tile floors, section 5) | 16 | 14 | | 2 | |

Of the 3 square maps over hex tiles that went to hexes, 2 are contested, so they are only offered. In the third the square finder missed the squares, and the tiles alone would apply as hexes at 0.62.

**Real maps.** Section 3's 30 real maps were kept outside the repository on an earlier machine and are not on this Mac, so they could not be run again. Seven openly licensed hex maps were found for this section, for evaluation only and not committed. No openly licensed raster battle map with a regular hex grid turned up, so these are diagrams, wargame maps and a game screenshot. The truth is measured at the found hex from pairs of opposite sides, and the found grid was drawn over each whole map and checked by eye at its far corners.

| Map | License | Hexes | Answer |
| --- | --- | --- | --- |
| Sechseckraster (Wikimedia Commons) | public domain | columns, 178 px, labels | right: 0.2%, 0.04 px, confidence 0.67 |
| Cosim amphibious (Commons, SVG drawn at 1750 px) | CC BY-SA 4.0 | columns, 204 px, island and counters | right: 0.4%, 0.05 px, 0.87 |
| Battle of the Trebia (Commons, SVG drawn at 2081 px) | GPL | rows, 176 px, 5 px lines under a battle map | right on the second look: 0.1%, 0.45 px, 0.79 |
| A4 hex page (Commons, SVG drawn at 1624 px) | CC0 | rows, 95 px, blank | right: 0.07%, 0.02 px, 0.88 |
| Hex Grid Movement (Commons) | CC BY-SA 4.0 | columns drawn 3.6% too wide | no grid, as it should |
| Battle for Wesnoth screenshot (Commons) | GPL | columns 15% too tall, the game's own shape | no grid, as it should |
| Hex grid for roleplaying maps (Openclipart) | public domain | columns, 24 px, lines only in the alpha channel | missed: the finders read gray and ignore alpha. Drawn on white, right |

`detectGrid` answers no grid on all seven, and the shape picked is the right hexes on the four found. Each map turned a quarter turn, which swaps rows and columns, gives the same answers in the other orientation.

As the real false-positive test against squares, all three looks ran on the 13 real Universal VTT exports kept for the importer's tests (Dungeondraft, Dungeon Alchemist and Arkenforge), each decoded at most 4096 px as the Worker does, its square size stated in the file:

| Maps | Runs | Hexes found | Squares at the stated size | Squares at another size | No squares |
| --- | --- | --- | --- | --- | --- |
| Universal VTT exports, 256 to 6956 px | 26 hex, 13 square | 0 | 5 (confidence 0.38 to 1.00) | 0 | 8 |

Whether the 8 without squares have a grid drawn in the image was not checked: many exports carry the grid in the file and not in the picture.

### 10.3 Cost

On this Mac (M5 Pro), one core, Node, a JPEG at quality 85 of a map with 70 px hex rows, the median of seven runs taken in turn with the round-1 build, since other lanes loaded the machine. Hex columns there find nothing, so that column includes the second look.

| Side | Hex rows, found | Hex columns, no grid | Squares | All three |
| --- | --- | --- | --- | --- |
| 1000 | 32 ms | 33 ms | 14 ms | 79 ms |
| 2000 | 85 ms | 101 ms | 53 ms | 239 ms |
| 4096 | 228 ms | 275 ms | 126 ms | 629 ms |
| 8000 | 480 ms | 621 ms | 249 ms | 1350 ms |

Confirming every passing fit and measuring where lines lie down the map cost about a quarter more than round 1's build. On the 13 real exports all three looks took 13 ms (256 px) to 1.07 s (3840 by 2640, busy art). The finder keeps one gray copy of the image (12.6 MB at 4096 by 3072) and a quarter of that for the second look. Its profiles are under 2 MB. The Worker decodes at most 4096 px, so 8000 is never searched in the app. A browser Worker was not measured: section 4 found Chrome's Worker as fast as Node for the same kind of loops. Phones, two to four times slower, take 1.3 to 2.5 s for all three, within Find the grid's 30 s and past the import's 2 s wait, which the late answer of section 6.1 already handles.

### 10.4 What fools it

- **Hex tiles under another grid** are hexes to it, as square tiles are squares to section 2 (10.6).
- **Hexes drawn out of shape**, stretched or squeezed by 1% or more, answer no grid when their sides' lean can be measured: 24 of 24 from 1.1 to 5%, and 12 of 12 from 0.3 to 0.9% found, 7 of those only offered since FU37-B (10.11): their stretch reads within its error of the limit. Where it cannot, the find is held to medium and only offered (the last point below). The app's hexes are regular, and a regular grid over hexes 1% out of shape misses their lines by pixels across a map. Both such real maps did so.
- **A grid only in the alpha channel** (a transparent overlay) is invisible to both finders. Flattening on white before searching would find it, follow-up HEX-ALPHA, for squares and hexes alike.
- **Hexes over square tiles** of a similar size can fail the meeting check (one of 12). Lines too faint, or only on a few hexes under busy art, answer no grid rather than a guess.
- **Small hexes**: under 12 px, or the long side over 200, are not looked for, as the scene limit says.
- **How much of the map the sides cover** is reported, not checked: a grid on the floors of a few rooms is still the grid.
- **Large hexes on a small map, or on a few rooms**, can show fewer than 4 lines of a family in both halves of the image, so that family's lean, and with it the turn or the shape, cannot be measured. Before round 2, hexes 1.1% out of shape passed so at 0.92 (150 px on 760 by 600). Such a find is held to medium (0.5 at most, `checked` false): offered, never applied. In the evaluation 5 of the 8 grids on the floors of rooms only (129 to 166 px hexes) are held so, and no other find.

### 10.5 What applies and what is offered

Section 3's tiers: a high-confidence find applies as one undo step with Line up grid open on it and Use default beside Apply, a medium one only places the box, and under 0.3 is no grid. Two changes for shapes: a find of another shape than the scene's switches the shape only when it is high, the switch is allowed and the find is not contested (10.6), and a contested find is only offered, at any confidence. A hex find whose turn or shape could not be measured (10.4) is at most medium, so it too is only offered and never switches the shape, as is a find on any look whose stretch reads within its measure's error of the limit (10.11, FU37-B), and a third-look find measured on a half frame under 600 px down (FU35-B). No run of the evaluation found hexes where none are drawn, so a lone hex find earns the same trust as squares. The real maps found came at 0.67 to 0.88.

### 10.6 The guard between squares and hexes

- **Squares are never hexes.** A square grid has no sloped sides, so its sloped profiles hold no lines at its size. Lines in all three of a hex grid's directions that run on through the hexes, a triangle grid, fail step 4: every lattice sees the same lines. Crossings of a triangle grid line up in the other orientation's directions, and the sloped filter's longer reach keeps them from passing as sides. Tested on 60 square-grid runs, 26 runs on real Universal VTT exports, 12 triangle-grid runs, the unit tests and the real hex maps.
- **Hexes are never squares.** `detectGrid` needs lines that run the map's length at one size across and down, which hexes do not draw. It found squares on no hex grid, only on square tiles under one.
- **Both shapes found**, as on a floor of tiles under another grid: the surer wins (`pickShape`), and the find is contested. A contested find never applies and never switches the scene's shape, at any confidence: Line up grid places the box on the scene's own shape's find when there is one, and the line names both. Hexes do not simply win: on squares over hex tiles the squares were the surer on 9 of 12. A sure winner over a doubtful other is not safe either: hex tiles beat a square grid at 0.69 against 0.57.

### 10.7 The wiring the build will do

1. **One search, three looks.** `searchRun.ts` runs `detectGrid`, then `detectHex` for rows and for columns, on the same pixels, and the answer carries all three. `pickShape` (written, in `detectHex.ts`) takes the shape: the surest find, contested when another shape was found too.
2. **A hex calibration from a find.** `calibrationFromHexFind` turns the center into the scene's origin as HX-4's `hexCalibration` does (calibrate.ts): the first row at or after the image's top-left, modulo the row spacing (cos 30 cells), the row's parity carried into the other coordinate as half a cell, so Apply and the box agree. It folds only within `FOUND_SNAP`, as `calibrationFromFind` keeps a square find's measured origin, never the box's 5% `ORIGIN_SNAP`. `foundGrid` scales the cell, center and box by the canonical size over the decoded one.
3. **New scenes.** A map picked, uploaded or put in place of a scene's art is searched whatever the room's shape (`searchOnImport` loses its `hex` flag). A sure, uncontested find sets the new scene's shape with its grid, so a hex map in a square room starts on hexes and a square map in a hex room on squares. A doubtful or contested find of another shape changes nothing and says so. A name's size still wins by not searching, except on a hex scene, where names are not read (D-261028-05).
4. **Find the grid on any scene.** On in Line up grid and in Map image and grid on hex scenes too. A sure find of the scene's shape applies, and a sure, uncontested find of another shape switches the scene's shape with the grid, one undo step, when `switchRefusal` allows it. Use default puts back the shape too. A refused switch, a doubtful find of another shape or a contested find only says what was found.
5. **The late answer** of section 6.1 lands only on a scene with the same image, grid and shape as when the search began. `outcome.ts`'s rule that drops every find on a hex scene goes.
6. **Words.** HX-4's "Find the grid finds square grids only. Line up the hexes with the box." (`HEX_LIMITS.findGrid`) goes, and Options gives hexes their own lines (10.8).

| Part | Files | Size |
| --- | --- | --- |
| The finder, the shape pick, their tests, hex maps drawn by code | `grid/detectHex.ts`, `detectHex.test.ts`, `synthetic.ts` | written, about 1,300 lines |
| Shared helpers: the profile and fit code the two finders repeat | `grid/detect.ts`, `grid/profile.ts` | a refactor, about 200 lines moved |
| Three looks, the hex calibration | `searchRun.ts`, `findGrid.ts`, `calibrate.ts` and tests | about 150 lines |
| New scene, a new image, Find the grid, the shape switch | `NewScene.tsx`, `SceneSettings.tsx`, `outcome.ts`, `Options.tsx`, `words.ts` | about 170 lines and tests |
| e2e: a code-drawn hex map through New scene in a square room, and Find the grid on a hex scene | `e2e/hex.e2e.ts` | about 80 lines |

One build lane, after LP23-B's fixes to `client/features/grid/` land.

### 10.8 UI checklist

- **Loading:** unchanged. The same "Looking for a grid…" with the shared indicator, one search, now about five times as long as a square search alone.
- **Keys and focus:** Find the grid keeps its place and focus on hex scenes. A shape switched by a find moves focus nowhere, and the Grid shape radios show the new choice.
- **Screen readers:** the found line is the options line's live status, as for squares, and names the shape.
- **Large interface sizes:** the longest new line wraps in the options strip at 130% on a 320 px phone, as section 6.1's lines do.
- **The exact words:** "Found a grid of 70.4 px hexes." / "Found hex columns of 70.4 px. The grid is hex columns now." / "These lines may be the map's hexes: 70.4 px. Check the box, then Apply." / "These lines may be hex columns of 70.4 px. Change Grid shape to use them." / "The map shows squares of 70 px and hexes of 52 px. Check the box, then Apply." / "Found hex rows of 70.4 px, but " followed by the switch's refusal / "No grid found. Drag a box over 3 hexes across instead." The Map image help on hexes becomes the squares' line without its file-name sentence: "A grid drawn on the map is looked for, and you check it or line up the hexes next."

### 10.9 Cases

| Case | Expected | Test |
| --- | --- | --- |
| Hex rows or columns, any cell and center | found, 0.5% and 0.5 px | `detectHex.test.ts` |
| The box | 3 by 2.89 cells (2.89 by 3), its middle on the hex nearest the map's middle, in the next row when nearer | `detectHex.test.ts` |
| RGBA, light lines, faint lines, floors only, 16 to 150 px hexes | found | `detectHex.test.ts` |
| Lines 7 and 9 px wide | found on the second look | `detectHex.test.ts` |
| A find whose sides barely break at the corners | refused under 0.3, then found on the second look | `detectHex.test.ts` |
| Several fits pass | the surest after the look along the lines | `detectHex.test.ts` |
| Hexes 1.1% out of shape, and 0.9%, at 60 and 100 px on 760 by 600 and 150 px on 1200 by 900, both orientations | no grid, and found | `detectHex.test.ts` |
| 150 px hexes on 760 by 600, regular and 1.1% out of shape, both orientations: too few lines to measure the lean | found, held to medium, `checked` false | `detectHex.test.ts` |
| The other orientation, squares, triangle grids, art, turned 0.35 and 2 degrees, a thick grid turned 0.3 degrees, resized 5% out of proportion | no grid, with its reason | `detectHex.test.ts` |
| A hex grid to `detectGrid` | no grid | `detectHex.test.ts` |
| Squares over hex tiles | squares picked, contested | `detectHex.test.ts` |
| Hexes found on a new map in a square room | the scene starts on hexes with the grid, one undo step | build: `findGrid.test.ts`, `hex.e2e.ts` |
| A contested find | the box offered, nothing applied, the shape unchanged | build: `outcome.test.ts` |
| Find the grid finds hexes on a square scene with painted ground | the shape stays, the line says why | build: `outcome.test.ts` |
| Use default after a shape switch | shape and grid back | build: `outcome.test.ts` |
| A late hex answer on a scene whose shape changed | dropped | build: `outcome.test.ts` |

### 10.10 Decisions

Guessed where the owner's words do not settle it, logged as D-261028-30 to D-261028-39: three looks on every search (30), a find of another shape sets a new scene's shape (31), switches an existing scene's shape only when sure and allowed (32), the surer shape wins and two shapes found only offer (33, amended in round 1: hexes no longer always win), section 3's tiers unchanged (34), hexes 1% or more out of shape refused, judged by lean, and a find whose lean cannot be measured held to medium, only offered (35, amended), the second look at half size (36), the measured center kept with only `FOUND_SNAP`, reduced as `hexCalibration` reduces (37, amended), names still win on square scenes (38), and transparent overlays left to a follow-up (39).

### 10.11 As built

**HX-9c** (the wiring), built on the finder over the design pass's lanes 0 to 2. Every place the build went its own way:

- **Shared helpers.** `grid/profile.ts` holds what both finders repeated: the detrend, the sums over a line's width, the autocorrelation's peaks, the Fourier coefficient, a line's center, least squares, the noise between lines and the quantiles. Each finder keeps its own profiles, period list and fits. The two finders lose about 290 lines, and on 24 code-drawn maps every field of both answers is as before.
- **Three looks.** `searchRun.ts` answers the square finder's `result`, as before, and `hex` with both orientations. An answer without `hex` reads as no hexes, so every square test stands unchanged. `findGrid.ts` `pickedGrid` takes the shape with `pickShape` and scales the find. A contested find is held to medium, offered on the scene's own shape when that was found, and otherwise on the surer as another shape (D-261028-102), with the other shape's size for the line.
- **The hex calibration.** `calibrationFromHexFind` reduces the origin through the same code as the hex box (`hexOrigin`), folding only an origin just under a whole row or hex (`FOUND_SNAP`). The box a hex find leaves stands on the hex nearest the box the DM had, or the map's middle, under the found grid, as a square find's does, not on the finder's own box at the image's middle (D-261028-104).
- **New scenes and new art.** `searchOnImport` lost its `hex` flag: callers say `named` only on squares. On a hex scene a name the server read as a size is still searched, and a find wins over it and opens Line up grid (D-261028-106). A sure find of another shape found alone sets the new scene's shape with its grid in one undo step, the form's own Grid pick included (D-261028-100), and Use default puts back the form's shape, the first guess and the size. In Scene settings, a first image whose name gave a size fits the scene only when no grid was found and no search goes on.
- **The switch** (`outcome.ts`) sends the shape first, then the grid and the size, as one undo group. It asks `switchRefusal` of the room as it is when the answer lands (`useFindGrid.ts` `useSwitchRefusal`), and a scene that came with its own square grid refuses with the reducer's own words whatever else holds it. A refused switch is said at any confidence (D-261028-101).
- **Use default after a switch** (review H3-OPUS-03) asks `switchRefusal` for the shape it would put back before sending anything, since its ops are not one transaction: refused, as when heights stand on the hexes since, it sends nothing, the note keeps Use default, and the line says "Can't go back to squares: " and the refusal (`outcome.ts` `putBack`).
- **An offer of another shape** keeps its grid and box on the note, and Grid shape changed to that shape brings them for Apply (`store.ts` `shapeChanged`, D-261028-103). A note records the shape of its cells, and `noteFor` reads it only on that shape, which replaces the rule that dropped every note on hexes.
- **The words** are `outcome.ts` `foundLine`: 10.8's lines, and "Found squares of 70 px. The grid is squares now." after a switch to squares (D-261028-105). Another shape than the scene's is named in full ("hex rows"), and "hexes" only beside squares: "The map shows hexes of 52 px and squares of 70 px. Check the box, then Apply." on a hex scene, and "The map shows hex rows of 52 px and squares of 70 px. Change Grid shape to use them." when neither shape is the scene's. HX-4's "Find the grid finds square grids only." is gone from the tool, the settings and their help.
- **Tests.** The cases of 10.9 in `findGrid.test.ts`, `outcome.test.ts`, `searchRun.test.ts` and `calibrateHex.test.ts`, with one randomized test of finds, shape changes on this device and another, refusals and late answers. `hex.e2e.ts` hx9c-1 to hx9c-4: a code-drawn hex map through New scene in a square room starting on hex rows, Use default and two undos, Find the grid on hex rows switching to drawn hex columns in one undo step with focus kept, a refused switch on a square scene with painted ground, and the options strip with that line within 1 px at section 8's sizes, cut short and opened by a tap. Where the line is cut, it opens to four lines and scrolls the rest, as every options line does. HX4-2's and HX4-3's steps changed with the words and the button they checked.
- **Mutation checks.** Each of 27 mutants fails a test: the switch's three conditions (sure, alone, allowed), the scene's own square grid refusing, the switch op and its place first, Use default's shape, hex scenes searched, the late answer's shape rule and its note, the refusal reaching the landing (in the unit tests, and the room's refusal in hx9c-3), the contested find held to medium and offered on the scene's own shape, the hex find's scaling and its frame check, the three looks, `FOUND_SNAP` in the hex calibration, `noteFor` by shape, Grid shape bringing an offer, an offer's box on its own scene, and three of the lines.
- **Left out.** HEX-ALPHA and HEX-NAME-SCALE stay follow-ups, and the DM guide's wording is the coordinator's.

**FU35-B** (live play LP24-B's FIND-2 and FIND-3, decisions D-261029-50 and D-261029-51). Every place the build went its own way:

- **New art of the old image's shape is searched.** `sameArt` compared only the image's shape, so other art of the same size kept the old grid, scaled, and was never searched. It is `sameImageShape` now, and `create.ts` `replacement` says what a scene's new image does: the same file (the scene's own asset, since a room stores a file once) keeps the grid and drops its search, an image of the old one's shape keeps the grid, scaled, and is searched, and other art starts over as before. HX-9c's words and Use default are unchanged.
- **A find there is only offered** (`findGrid.ts` `replacementFound` with the kept grid). Every look's confidence is scaled down by one factor, so the surest stands just under `HIGH_CONFIDENCE` and `pickShape` keeps its order (`offeredOnly`): a sure find of either shape only places the box, and another shape never switches the scene. A find whose cells on the map all hold their partners among the kept grid's, within `FOUND_SNAP` (1 px at least), is no find, and Line up grid stays closed (`keptGridHolds`, the kept grid's match below). The rows' ends catch a size 0.5% off whose lines meet the kept ones at the middle.
- **A phone's search that outlives the wait** on such art goes to Line up grid with its finds only offered, as `landSearch` lands any other. The line already says "Looking for a grid…" there, so a find on the kept grid's lines showed as the box on them, until FU37-B (below).
- **A third look at a quarter of the size** (`detectHex.ts`), when the first two find nothing, its pixel limits a quarter of the image's. It never follows a grid seen turned or out of shape on an earlier look, nor two looks that both measured sides of different sizes: Hex Grid Movement, drawn 3.6% too wide (10.2), passed at a quarter at 0.60 otherwise. One look saying so does not stop it, since thick lines can read so (the Trebia map's first look does). Squares keep their one look: their line filter already reaches 6 px at 4096 px (D-261029-75).
- **The third look's find is measured again at half size** (review FU35B-ASTRA-03, D-261029-55 revised, `measuredAtHalf`). A quarter of a small map measures shape more coarsely than its limits say: hexes squeezed 1.1%, 150 px on 760 by 600, measured 0.8% there and applied at 0.83. So the half frame is read again with the line filter's reach doubled, which holds the lines the quarter saw, on the quarter's period alone, so the wider reach finds no lattice of its own. The find stands as that measure says: those hexes answer "hexes out of shape", Trebia applies at 0.78, and a find the half size cannot see is held to medium, offered only. It costs 15 to 45 ms at 4096 px, only when the third look finds hexes. Round 2 found the half measure reading thick lines' places less finely too: 100 px hex rows squeezed 1.1%, of 14 and 18 px lines on 760 by 600, read 0.64% and 0.96% on its 300 px frame and applied. So on that measure a stretch less than 1 / (H / 2) under the limit, a pixel over half the frame's height H (`STRETCH_ERROR_PX`), counts as not measured: offered, never applied. Only the half measure takes the margin. A first look reads thin lines finely, and its 0.9% stays sure. On 384 drawn runs 1.0 to 1.5% out of shape (100 and 150 px hexes, 14 and 18 px lines, 760 to 1520 px, three seeds) none applies, 21 did without the margin, and the 96 regular ones keep all 64 third-look finds that applied. Round 3 found it misreading a shifted grid by far more: 100 px hex columns from (85.85, 18.55), 14 px lines, drawn 1.1% too tall on 760 by 593, read 0.2% on a 380 px frame and applied at 0.73. So in place of one margin tuned to the latest fixture there are two rules, judged by a randomized sweep (D-261029-151). The margin is the larger of that pixel and two standard errors of the stretch, which the lines' own leans give: 1.4826 times their median deviation over the root of their count, for each sloped family, the two combined (`STRETCH_ERROR_SE`). And a third-look find applies by itself only on a half frame 600 px or more down, the side its leans are measured along (`HALF_MEASURE_MIN_PX`). On a shorter one it is offered, its box placed, since there the measure can misread by more than its lines' scatter shows.
- **The sweep that proves it** (round 3, D-261029-151): 11,000 code-drawn maps, every draw logged, 593 to 4096 px, hex rows and columns, centers anywhere in a box two cells across, lines 6 to 16% of a cell, 4 to 12 cells on the short side. 6,582 are 1.0 to 2.5% out of shape, stretched or squeezed, across or down. No third-look find of those applies (32 are offered), where 19 did with neither rule, and the margin alone already stops all 19. Of the 4,418 regular maps, 2,818 are found and 1,801 of those apply. 1,264 are found on the third look: 612 apply and 652 are offered, 392 of them by the floor alone, on frames under 600 px.
- **Left for a follow-up** (FU35B-HALF-MARGIN): the first and second looks take no margin, and near the 1% limit they still apply hexes out of shape. In the sweep 38 of the 6,582 runs did so, 4 on the first look and 34 on the second, all 1.0 to 1.1% out of shape. A margin there would change the looks 10.2 evaluated. Done in FU37-B (below).
- **What it finds**, with the half-size measure. The Trebia map drawn at 4096, 5200 and 8000 px and decoded at 4096: hex rows of 345.8 px, 0.0% off, at 0.78. The seven real hex maps answer as in 10.2, and the 13 Universal VTT exports of 10.2 find no hexes. Of 48 code-drawn regular hex grids with lines 6 to 12% of a cell on maps of 1300 to 4096 px, 29 are found, none wrong, 12 of them on the third look: 10 apply, and 2 are offered by the floor. Of 66 code-drawn runs of thick-lined hexes 1.1 to 5% out of shape, the third look takes none, where the second look already took one 1.1% out of shape at 500 by 400. A wider sweep of 80 regular grids and 160 runs 1.1 and 1.5% out of shape, 760 to 3200 px: 52 found and none wrong, 17 applied from the third look and 4 offered by the floor, and no run out of shape found.
- **Cost.** The third look reads a sixteenth of the pixels: 18 to 25 ms for each orientation on a 4096 px map on this Mac, about 45 ms of a search's 1.0 to 1.2 s, and 2 to 7 ms on maps up to 2000 px. It runs on every map where neither earlier look found hexes, most square maps included.
- **The kept grid's match** (reviews rounds 1 to 3, `keptGridHolds`). A find matches the kept grid when every cell of each with its center on the map lies within the slack of its partner in the other, partners paired by their steps from the map's middle cell. Rounds 1 and 2 compared the sizes and each of five points' nearest centers, and grids of near sizes passed: they drift apart by their sizes' difference a cell, and a whole cell's drift meets the nearest center again. 20 px squares and 19.2 px ones from (0.4, 0.4) on 980 by 980 meet at the middle and at all four corners and miss by 9.6 px between (FU35B-ASTRA-01, round 3). Two partners part by the middle pair's offset plus that drift times their distance from the middle, a straight line across the map, so only the cells at the ends of each row are measured, of each column on hex columns, and the rest lie between. The check equals a brute force over every cell, both ways, on 100,000 drawn pairs (squares and both hex orientations, maps 3 cells across or more, near sizes, one-cell slips, whole fractions and multiples, and any other), where the five points got 1,346 wrong. Measuring at the map's own corners would turn away 709 pairs that do match. Sizes are not compared apart: on a map 3 cells across, a size more than the slack off already parts a cell beside the middle from its partner by more, and so does another spacing that meets the kept one at a few points (70 px squares under kept 210 px ones, 80 px from (10, 10) under 100 px on 900 by 900). A find that also names another shape is said though its own shape matches, since either may be tiles under the other (design 10.6, FU35B-ASTRA-02). The slack's 1 px floor grows with the art's scale (D-261029-54), and its 1% of a cell with the kept cell, which is scaled already (round 2: round 1 scaled the 1% twice, 45 px on art 8 times larger where 8 px is meant): art twice the size keeps a grid found on the smaller copy, its errors doubled, and drawn hex rows whose first row sat within 1 px of the small copy's edge, folded there, missed the same lines found again by 1.35 px (2 of 72 drawn pairs).
- **Tests.** `create.test.ts`: the same file not searched, the old shape kept and searched, other shapes and names as before. `findGrid.test.ts`: a differing sure find offered and nothing applied, a matching find (sure or doubtful) none, the corners, hexes and squares on hex rows, the late search, `offeredOnly`'s order. `detectHex.test.ts`: 14 and 18 px lines found on the third look after two misses, a 1300 by 1000 map whose first look reads different sizes, a thick grid turned a third of a degree refused there, and which looks run (`onLook`). `maps.e2e.ts` fu35b-1: the same file, other art of the shape offered with the scene's grid kept, Apply, and art on its lines opening nothing. Review round 1: nested grids (210 against 70 squares, 70 against 70 / 3, 64 against 32 hex rows), a hex columns match, matching squares beside hexes naming both, art at twice the size, the scale `replacement` passes, astra's fixture refused, a sure third-look find applying and an unseen one offered, and a hex scene too small for a whole hex in its row. Review round 2: other spacings meeting at the five points (100 against 80 squares, 70 against 52.5, 100 against 80 hex rows and columns), the slack at 8 and 4 times the size, the two squeezed 100 px fixtures held under the margin, and a first look's 0.9% kept sure. Review round 3: astra's 980 by 980 slip and one built slip on each hex orientation, a hex row whose end lies inside the outer rows', a brute force over every cell of 3,000 drawn pairs that the check must equal, astra's shifted columns offered, one fixture each that only the floor, only the standard error and only the pixel decides, and a seeded sweep of 10 maps 1.0 to 1.3% out of shape.
- **Mutation checks.** Each of 21 mutants fails a test: the same file's check, the kept grid on any shape, the old unsearched rule (in `create.ts`, and in Scene settings, which fu35b-1 catches), the offer's cap, the matching find's drop, the corners, the shape comparison, the slack, the late search's cap, the scaling, the third look itself, a third look after a find on the first or second, after a grid seen whole on the first or second, without or with a looser different-sizes rule, with the half look's limits, and placed at half scale. One survives: Scene settings handing a phone's late search to Line up grid without `offeredLater`, since no e2e step replaces a large map on a phone. `offeredLater` itself is tested. Review round 1 adds 9 more, each failing a test: sizes not compared, a contested find dropped, the slack not scaled, the kept grid's scale not passed, the third look not measured again, an unconfirmed find not capped, a find measured out of shape only capped, the reach not widened, and the row's capital. One survives: trying every period at half size, since on every map tried the half size's surest fit is the quarter's lattice. One period keeps the measure's cost down and the wider filter from lattices the quarter never saw. Review round 2 adds 8, each failing a test: the 1% scaled twice, the floor not scaled, sizes not compared, round 1's 25% in their place, no margin, the margin on every look, the margin halved, and the flag that marks the half measure never set. Review round 3 adds 19, each failing a test: the nearest cell in place of the partner, either side alone, one end of each row, only the first and last rows, the drift the wrong way or none, hex columns read as rows, centers a cell off the map counted, no floor, a 300 px floor, the floor by the frame's width, no standard error, no pixel, one standard error, the error over the count, the median deviation unscaled, one family's error, and the margin on every look. Round 2's size check put back changes no case, as the match's bullet says.

**FU37-B** (follow-ups FU35B-HALF-MARGIN, FU35B-LATE-MATCH and FU35B-LATE-E2E, decisions D-261029-181 to 183). Every place the build went its own way:

- **Every look takes the margin** (`detectHex.ts` `confirm`). A stretch within its measure's error of `MAX_STRETCH` is not measured, so the find is held to medium and only offered, on the first and second looks as on the third look's half measure. The third look's margin as FU35-B built it, a pixel over half the frame's height or two standard errors of the lines' leans, still let one run of the sweep apply hexes out of shape on a first look: hex columns 1.07% too wide on 1701 by 852, read 0.79%. The stretch comes from the sloped lines' leans, and that frame is 852 px across and 1701 px down, so its sloped lines cross it in less than its height: their two parts, each where its drawn thirds lie, are 254 px apart, not 850. A pixel's error is taken over that distance now, measured (`leanOf`'s `apart`, the nearer of the two sloped families, never more than half the height), on every look, the third look's half measure included, since it reads lines the same way (D-261029-181).
- **The sweep** (FU35-B round 3's 11,000 runs, drawn again from their seeds): none of the 6,582 runs out of shape applies, where 38 did on the first and second looks. Of the 4,418 regular runs, 2,818 are found as before and 1,599 apply, where 1,801 did: 202 more are offered. The first look keeps 284 of its 288. The second look keeps 713 of its 901: every one on a half frame whose short side is 450 px or more, and 411 of the 599 under it (maps under 900 px whose lines were too thick for the first look). The third look keeps 602 of its 612. A pixel over half the height would have left one out-of-shape run applied, with 4 offers, the first look's. Replayed on the same finds, the sloped lines' whole span across the frame, in place of where their parts lie, gives no out-of-shape apply and 98 more offers than that, and two pixels over half the height 334.
- **Design 10.2's evaluation, run again.** Every regular hex find applies as before but one, 41.5 px hex columns in a JPEG resized to 464 by 366, now offered. Of the 12 maps 0.3 to 0.9% out of shape, all are found and 7 are only offered. The shapes picked are unchanged. The seven real hex maps and the 13 Universal VTT exports answer as FU35-B measured them: Sechseckraster at 0.67, Cosim at 0.85, the A4 page at 0.88, Trebia at 0.80 (0.78 drawn at 4096 to 8000 px), no grid on the other three, and no hexes in any export.
- **A phone's search that outlives the wait on art of the old image's shape** (`outcome.ts` `landSearch`). It takes the kept grid (`kept`), passed from Scene settings through `useLandLater`, in place of a search wrapped to offer its finds (`offeredLater`, gone): every find is only offered, and one on the kept grid's lines is no find, as on time (`findGrid.ts` `beside`, which `replacementFound` shares). Such a find ends "Looking for a grid…" with nothing said and no box, since the scene stands on it. A find beside another shape is still said, naming both. On a scene that changed meanwhile it says nothing either, rather than that the grid found was not applied (D-261029-182, D-261029-183).
- **Tests.** `detectHex.test.ts`: five runs of the sweep that applied hexes 1.0 to 1.1% out of shape on the first and second looks, both orientations, drawn out of proportion down and across, now offered, among them the 1701 by 852 one that only the parts' distance holds; 0.9% out of shape on a 600 px frame offered and the same hexes regular applied; regular hexes read 0.11% on a 2789 px frame whose leans scatter, which only the standard error holds; the second look's find on a 380 by 300 frame offered. `findGrid.test.ts`: the late landing with the kept grid, a sure find that differs offered, the kept grid's lines (sure and doubtful) dropped with no line and no search left, the same lines beside hexes said, and a changed scene. `maps.e2e.ts` fu37b-1 (LATE-E2E): on a phone, art of the old image's shape three times its size, past the 4,096 px a phone decodes, with the server's copy held 3 s past the 2 s wait: the kept grid's lines end the search with nothing said, and moved lines are offered with the scene's grid kept. `scenesetup.e2e.ts` fu37b-2: the Grid shape refusal names Builder room as the Fog tool's control does (GP4-GRIDSHAPE-WORDS).
- **Mutation checks.** Of 12 mutants, 11 fail a test: the pixel over half the height, no margin on the first look, none on half frames, the farther family's parts, no standard error, the late answer not offered, a matching late find said as no grid, a contested one dropped, a changed scene saying a matching find, the on-time drop gone, and Scene settings not passing the kept grid, which fu37b-1 catches (FU35-B's survivor). One survives: the parts' distance not capped at half the height. It is over half the height in 18 of 3,578 finds of the sweep, by 3% at most, so the cap only keeps the margin from ever being narrower than the third look's as decided (D-261029-151).
