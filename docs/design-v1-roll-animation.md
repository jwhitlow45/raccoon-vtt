# raccoon-vtt v1: the roll animation

Status: decided by the project owner on 2026-10-18 (section 12): 3D dice, with a choice of dice sets. Revised after design review round 1. No app code is written yet: the prototypes ran against the dev room from outside the repository.

The project owner asked on 2026-10-17, in the dice UI request: "A roll animation would also be cool but can be done after these changes." And on 2026-10-18: "Also did we ever get around to dice animations?" The dice UI pass shipped and kept a place for it (docs/design-v1-dice-ui.md 4.7), which this design read as a starting sketch, not a decision.

## 1. Summary

- **3D dice in the Dice panel's tray.** A roll tapped in the Dice panel throws three.js dice from the control that rolled into a band under the header line. They tumble and land on the server's faces. Never over the map.
- **A scripted tumble, no physics engine.** Each die eases from a spin to an orientation solved in advance, so it lands exactly on time and exactly on its face, for every die from d4 to d20 and percentile.
- **One fixed time.** The dice land 1 s after the answer reaches the device, by a timer, never by the animation. The header line and Recent rolls show the result then. The live region speaks at once, and the log, the Log panel and every other device never wait. A tap or key in the panel, a newer roll, closing or resizing the panel, hiding the page or an answer more than 3 s late ends the throw at once, and the tap or key still does its own job.
- **Nothing in the room's first load.** three.js is a lazy chunk of 125 kB gzip, fetched in the background once the room is ready. A roll that comes before the dice are ready shows its result at once.
- **Legible at phone size.** The landed face turns to the viewer and stands upright. Its number is printed in full ink, and its neighbors are printed fainter.
- **Eight dice sets**, Ivory by default, each drawn in code with its own finish, chosen in Menu, This device, Rolls and kept on the device (section 9).
- **On by default**, with a "Roll animation" switch in Menu, This device, Rolls. Low power, the switch off, no WebGL or a lost context show the result at once. Reduced motion shows the dice already at rest, with the result at once. No sound.
- **Others' rolls never fly.** A toast of someone's d20 shows a flat d20 with its face, and a natural 20 rings once. Request cards and the table display get no dice.

## 2. The options, and the choice

Every option was prototyped against the dev room (`/dev/room?as=player&rolls=1&pcstats=1&diceui=1`), by a script the page loaded from outside the repository. The script read the server's dice lines as the page parsed them, so every face in the pictures is one the fixture's server rolled. Pictures are in `screenshots/roll-animation/`, as strips of frames at fixed times after the answer.

| | A. The header line | B. 2D dice | C. 3D dice (chosen) |
|---|---|---|---|
| Look | A die turns in the 24 px total slot, chips land, the total counts up (`a-header-phone.png`) | Flat dice drawn in SVG tumble into the tray (`b-panel-*.png`), or onto the map (`b-board-*.png`) | Shaded dice tumble into the tray (`c3d-*.png`) |
| Cost | About 150 lines | About 600 lines | About 1,000 lines, and a lazy 125 kB gzip chunk |
| Risk | Low | Low in the tray, medium on the map | Medium: WebGL fallbacks and GPU memory on phones |

C keeps from the B work the tray under the header line (on the map the dice landed on tokens, `b-board-desktop.png`), the throw from the control that rolled, the timer rule, the interruptions and the cap on many dice. A's count-up is dropped everywhere: it shows totals the server never rolled.

## 3. The result is the server's

### 3.1 Which rolls throw

- **A roll tapped in the Dice panel.** Every way a panel control rolls carries its origin, `{ surface: "dice", element, tapAt }`: `useDicePanel().roll` (the formula field and Roll, the roll options), `again` (the header line's Again, Recent rolls' Again) and `noted` (a request's answer or a death save sent from the panel). All three register the tag with the store through one helper, `registerThrow(tag, origin)`. `useRollOption(…, surface)` takes the surface as an argument: RollOptions passes `"dice"`, and the tracker's `Row.tsx` passes nothing, so the tracker's Roll never throws, even with Dice open beside it.
- **One tap, one creature.** A tap's rolls for one creature throw together, up to the cap: a damage of two types, a damage with a rider, an attack's d20. A tap for several creatures (the DM's several-token options) shows at once.
- **Only a commit this panel saw coming.** The throw starts when that tag's receipt turns `committed` (`useReceipt`, docs/design-v1-dice.md 8.7), with the panel mounted at the tap and still mounted. A commit seen before the panel mounted, a refusal, `unknown`, `checking`, an offline tap, a formula that no longer parses, and a preview (View as a player, `usePreview()`) never throw.
- **The dice are the result's faces**: `throwDice(result)`, in `throw/layout.ts` with no three, pairs each face in `faces` with its die by `rolledTerms`, and marks the kept ones by `keptFaces`, as `faceChips` does. The store and the tray take the dice count and "+N" from it.

### 3.2 Landing on the face

- **Each kind of die is a model** built once: its triangles grouped into faces by their normals, each face numbered so opposite faces add to n + 1 (d6 to d20), with its center, its normal and the direction its number reads upward.
- **The landing is solved, not simulated.** The target orientation turns the result face's normal toward the viewer, then turns about the line of sight until the number is upright, plus up to 9 degrees of tilt. The tumble is that target with a rotation about the rolling axis put in front of it, whose angle shrinks to exactly 0 at 1 s. The prototype checked every face of every kind: each lands facing the viewer to within rounding.
- **No physics engine.** A simulated throw lands where and when it lands. To show a given face it must be run ahead and its faces renumbered, and it still cannot promise 1 s or a die flat inside a 112 px band. cannon-es would add 25 kB gzip for that. The scripted path reads as a throw (`c3d-panel-phone.png`): the dice travel and slow together and still turn as they arrive. Randomness only places the dice, from a generator seeded by the tag, so a test can pin a throw.

| Die | Model | How it lands |
|---|---|---|
| d4 | Tetrahedron, each corner's number printed at that corner of its three faces | On a face, seen from its side: the result's corner at the top, as a d4 is read (`c3d-faces-phone.png`) |
| d6, d8, d12, d20 | Cube, octahedron, dodecahedron, icosahedron | Result face up |
| d10 | Pentagonal trapezohedron built in code: two apexes and a zigzag ring of ten points, whose height makes each kite flat | Result kite up. The face reads "10", not "0", to match its chip |
| d100 (`d%`) | Two d10s: tens (00 to 90) and units (0 to 9) | Both from the one face the server rolled: 84 is 80 and 4, 100 is 00 and 0 |
| Any other, d2 to d1000 | A thick coin with the number on top | Top up |

### 3.3 Many dice: the tray's layout

The tray is the header line's width and 112 screen px tall at every interface size. Its layout comes from its measured width W in screen px (`getBoundingClientRect`, which includes the panel's zoom), with 8 px gaps, by one rule in `throw/layout.ts`:

1. **One row** when all n dice fit at 48 px or more, at most 60 px.
2. **Else two rows** of ceil(n / 2) when they fit at 44 px or more, at most 48 px.
3. **Else the cap**: the most columns that fit at 44 px, two rows of them less one, and a disc counting the rest ("+9").

Each kind is scaled so its outline fills its slot (a cube by its face). The d20 that decides a d20 test goes first, so it is never hidden. A d100's pair is never split: the cap shows one die fewer instead, and "+N" counts dice, a d100 as two.

| Width (viewport, interface size) | One row | Two rows | Beyond | Smallest die |
|---|---|---|---|---|
| 278 px (320, 130%) | to 5 | to 10 | 9 and a disc | 48 |
| 288 px (320, 100%) | to 5 | to 10 | 9 and a disc | 48 |
| 293 px (320, 85%) | to 5 | to 10 | 9 and a disc | 48 |
| 328 px (side panel, 100%) | to 6 | to 12 | 11 and a disc | 48 |
| 348 px (390, 130%) | to 6 | to 12 | 11 and a disc | 48 |
| 356 px (390, 100%) | to 6 | to 14 | 13 and a disc | 44 |
| 363 px (390, 85%) | to 6 | to 14 | 13 and a disc | 45 |

The prototype ran the rule at 320 x 568 at 100% and 130%, and at 390 x 844 at 130% and 85%, with 6d6, 12d6, 20d6 and 12d6+1d20+1d100: no row overflowed and the pane never scrolled sideways (`c3d-tray-width-*.png`).

### 3.4 Timing

| When | What |
|---|---|
| The tap | As today: the control is busy, and "Rolling…" shows in the header line after 200 ms |
| The answer, t0 | The live region says the result with its verdict: "Rolled 23, Critical Hit: Longsword." for a Champion's Longsword landing a 19. A critical hit is named by the Critical chip's rule (`critical()` in `options.ts`), the same rule that rings the die, since a panel Attack carries no AC and `rollVerdict` alone never names a critical hit in a wider range. Otherwise it reads `rollVerdict`'s words. The Log panel and every other device show the line. The dice leave the control. The header line stays as it was: empty, or "Rolling…" if the tap was 200 ms or more before t0 |
| t0 + 850 to 1,000 ms | The result's number darkens to full ink as the die arrives |
| t0 + 1,000 ms | The dice land. The header line shows the total, label, chips and verdict. Recent rolls shows the new row. A natural 20 rings |
| t0 + 1,000 to 1,150 ms | A dropped die dims. Then the last frame is drawn, and nothing more |
| t0 + 1,800 to 2,100 ms | The dice and scrim fade by CSS, then go |

- **1 s, fixed**, the owner's choice: long enough to watch the dice turn, short enough not to stall a fight.
- **Decided at the commit, before React renders.** `store.ts` applies the `ev` and then tells the receipt tracker in the same task, and the tracker calls its listeners at once. The throw store listens to the tracker itself, not through React, so by the first render after the commit it has decided: throw or show. `LastResult` and `recentRolls` read `held(tag)` during render, so the total never shows for a frame and then vanishes. "Rolling…" during a throw is the store's own `rolling`, set at t0 from the tap time, since `useDelayed` goes false at the commit.
- **A timer, never the animation.** The result shows at t0 + 1,000 ms by its own `setTimeout`, whatever frames the phone drops. A late frame draws the pose for its own time, so it is landed by then. A page hidden at t0 throws nothing.
- **Never late twice.** An answer more than 3 s after its tap (a reconnect, a lookup) shows at once with no throw.
- **What waits**: the header line's result and Recent rolls' new row, by the throw's tag. Two controls change at the commit as today, since the next tap needs them: a critical Attack presses its row's Critical chip, and a Recharge clears Used. A close eye can read a natural 20 from the Critical chip before the ring.

### 3.5 Interruptions

The throw ends, and the result shows, at once on: a tap or key down anywhere in the panel, a newer panel roll, the panel closing or switching away, the group save page opening, the pane resizing (a rotation, a split moved, a sheet dragged, the keyboard), the page going hidden, reduced motion or Low power turning on, or a lost WebGL context. The dice go without fading.

- **The tap or key still does its job.** The panel's root listens in the capture phase and never calls `preventDefault` or stops the event.
- **Nothing moves under a finger.** Showing the result adds Recent rolls' new row at the top and moves every row under it, and iOS Safari hit-tests the click after such a move. So for a pointer, `pointerdown` only removes the dice, and the held header result and Recent rolls row show on the panel's capture-phase `click`, which comes after the browser has chosen its target. A `pointercancel`, or a `pointerup` with no `click` within 300 ms (a scroll, a drag), shows them then. A key shows them on `keydown`.
- **Again** stays mounted while the roll waits, as a `busy` button (`Button.tsx`: it keeps focus and ignores taps), and is live from t0. So a keyboard press on Again keeps focus through the wait and the throw, and one tap during the throw shows its result and rolls again. A tap on the field focuses it, and Enter rolls.
- **Taps pass through the dice**: the canvas takes no pointer events.

## 4. Who sees what

| Roll | This device shows |
|---|---|
| A roll tapped in the Dice panel, one creature or none (3.1) | The throw, then the header line |
| A tap for several creatures, the tracker's Roll, a group save, auto initiative | No throw. Results at once in their places |
| Your secret roll (Secret pressed, or a DM's roll for a monster) | The throw on your device only, which already shows its numbers |
| Someone's secret roll, as another player sees it | The bare line's words only, "Mara rolled in secret". No die, not even a shape: the projection sends no rolls (`rolls: []`, docs/design-v1-dice.md 5.2), and only this device's own tags throw |
| A hidden creature's roll, or an initiative players did not know | Nothing for other players: the roll never reaches them (docs/design-v1-combat-flow.md 11.3) |
| Others' rolls | No flying dice. Their toast, or their Recent rolls row, lands at once as today. A toast of one d20 test (attack, save, check, initiative) leads with a flat d20 icon showing the kept face. A natural 20, or a critical hit against an AC, rings once in the accent. The toast carries `rollVerdict`'s words as hidden text for a screen reader (`logic.ts`, where it moved from `RecentRolls.tsx` so the toasts need none of that panel's code): against an AC "Critical Hit" (on 20, or on 18 or 19 in a wider range, by `hitOf`), "Hit" or "Miss", and otherwise "Natural 20" or "Natural 1" with any "Pass" or "Fail". A natural 1's icon is outlined in `danger` |
| A card's Roll: the request card, concentration, save ends, recharge | No throw. The result at once, as today. A player who wants dice can answer from the Dice panel, whose "Asked" cells send the answer |
| Advantage or Disadvantage | Both d20s fly. The dropped one dims to 42% after landing, as its chip is struck |
| A natural 20, or a critical hit in a wider range | One ring in the accent around the kept d20, clear of it by a 6 px gap of scrim, that grows and fades over 520 ms (`c3d-nat20-phone.png`). Under reduced motion it stays still for the hold, in the tray and in the toast |
| A natural 1 | A still ring in `danger` around the kept d20, with the same gap (`c3d-nat1-phone.png`) |

## 5. Legibility

`c3d-faces-phone.png` shows every die landed at 390 x 844 with 3x pixels: a d4, d6, d8, d10, d12, d20 and d100 in one roll, then a d20, a d10 and three d4s alone.

- **The result faces the viewer and stands upright**, level to within 9 degrees, so a 6 never reads as a 9. Dice of eight sides or more underline their 6 and 9 for the faces seen at an angle. A d6 does not (`c3d-tray-width-*.png`).
- **The result in full ink, its neighbors fainter.** A d20 seen from above shows the numbers of the faces around the one that landed. Printed in each set's `faint` (about 2.2:1 on Ivory, section 9) they stay readable as a die's other faces, and the result, a decal in the set's `ink` that darkens as the die arrives, is the one the eye takes (`c3d-ink-vs-muted-phone.png`: all ink on the left, faint on the right).
- **The d4 lands face-on**, its result at the top corner. Seen from above, apex up, its three small numbers met at a point and did not read.
- **Sizes**: a lone d20 at 60 px carries its number at about 16 px (two digits about 12 px), and at 44 to 48 px about 11 px (two digits 9 px). The header line's chips, 13 px, carry every face whatever the dice show.
- **Numbers drawn in code**: each kind's texture is a canvas the client draws once with Inter, the app's bundled font, after `document.fonts.load("700 64px Inter")`, which rejects if Inter fails, and the textures are then drawn with the same fallback the interface shows. No image files.

## 6. Loading and the bundle

- **The lazy boundary.** Only `throw/stage.ts` and the modules only it imports (`throw/models.ts`, `throw/poses.ts`) may import `three`, and only the loader in `throw/hooks.ts` reaches `stage.ts`, through `import()`. `throw/layout.ts`, `throw/store.ts`, `throw/sets.ts`, `Tray.tsx` and everything the Dice panel, This device, the toasts or the Room import stay free of it. Vite puts the stage in a chunk of its own: 559 kB minified, 125 kB gzip, 101 kB brotli, built from the prototype's exact class list, Phong included. The build measures 485 kB minified, 121 kB gzip and 100 kB brotli. three 0.160 hardly tree-shakes (its math alone is 121 kB gzip), so one stray import would put all of it in the Dice panel's chunk, which every member preloads. A source scan test (`uiPassScan.test.ts`'s pattern) holds the rule, and a post-build check in CI fails unless exactly one chunk holds three's renderer and it is none of the entry, Room, room and Dice panel chunks.
- **When.** In the background once the room is ready, like the panels, so a dropped connection or a redeploy later in the session never turns the dice off, and Chrome's memory of a failed import (`retryableLazy.ts`) is kept rare. `preloadInBackground` (`lib/retryableLazy.ts`) calls its loader only once, so the loader subscribes to the switch and Low power, and imports the chunk the first time the switch is on, Low power is off, the page is no preview, and `throw/probe.ts` says WebGL is there. The room's first load gains only the loader (`throw/hooks.ts`), the probe, the sets' colors and the toast's d20, about 3 kB gzip. The rest of the throw's code, `throw/store.ts`, `useThrows.ts` and `Tray.tsx`, loads with the Dice panel, and the room's rolling code reaches the store through a hook the panel installs.
- **The probe outside the chunk.** `throw/probe.ts`, with no three, runs once per page at room ready and only when those settings allow: it asks a fresh canvas for the context of section 7, caches the answer, and releases the context at once with `WEBGL_lose_context`. In Chrome on macOS, with a GPU, with the automatic software fallback, with no WebGL at all and with SwiftShader by name, the probe logged nothing.
- **Warm-up**, when the Dice panel opens, and again after the page shows or a context is restored while it is open, in an `idle(cb, maxMs)` callback (`lib/idle.ts`: `requestIdleCallback` where it exists, a `setTimeout` elsewhere, since Safari and iOS Safari have none): it makes the renderer, draws the textures of the dice in Recent rolls (a d20 and a d6 when there are none) and compiles the shaders. In the prototype a first throw without warm-up spent 65 to 146 ms making its models and 62 to 105 ms on its first frame, slowed 4 and 6 times (section 8). Never in a preview.
- **A roll before the warm-up ends** shows its result at once. Later rolls throw.
- **Packages.** three 0.160.0 (MIT) is already a dev dependency, for `scripts/stamps.ts`, and Vite bundles it at build time, so the production image stays without it. three 0.160 ships no types, so commit 1 adds `@types/three` 0.160.0 (MIT) as a dev dependency with the lockfile. Nothing else ships: no physics, no dice library, no font or image.
- **CSP, no change.** `script-src 'self'` covers a same-origin chunk loaded by `import()`. WebGL and canvas textures need no directive. three's module has no `eval`, no `new Function`, no worker and no WebAssembly, and sets styles through the CSSOM, which `style-src 'self'` allows. New keyframes go in globals.css.

## 7. WebGL, fallbacks and GPU memory

- **The stage's context.** The stage asks its own canvas for `getContext("webgl2", { alpha: true, antialias, powerPreference: "low-power", failIfMajorPerformanceCaveat: true })` and passes that context to `new WebGLRenderer({ canvas, context })`. It never builds a renderer when the probe fails, since three logs `console.error` when it cannot make a context. WebGL1 alone counts as no WebGL. In the prototype, Chrome with WebGL off gave no console message and the result at once.
- **A major performance caveat counts as none.** In Chrome on macOS, the automatic software fallback (`--disable-gpu`) was refused by the flag, while SwiftShader asked for by name was not. So a phone with only software GL shows the result at once, and the e2e browser can still draw.

| Case | What shows |
|---|---|
| No WebGL2, or only a software fallback | The result at once, for the session. The switch's help says "This device cannot draw the dice, so the result shows at once." The picker shows its flat icons (9.2) |
| WebGL context lost | The throw in progress ends and its result shows at once. On `webglcontextrestored` with the panel open, it warms up again. After a second real loss, no throws for the session. Disposal by the stage itself (`forceContextLoss()`) is marked deliberate first and never counts |
| Reduced motion (`prefers-reduced-motion: reduce`, read at each throw) | The result at once, and the dice drawn once, already at rest, fading in, with a still ring for a natural 20 |
| Low power, or the switch off | The result at once, no dice and no ring |
| The chunk or the warm-up not ready, or failed | The result at once (section 6) |
| A pane shorter than the header line and the tray (under 160 px: Dice in the bottom pane of two, a short sheet) | The result at once |

- **One context in the app.** The map is Konva on 2D canvases, so the dice never compete with another WebGL context. The picker reuses the stage's renderer when one exists (9.2).
- **The canvas** hangs under the header line's sticky box, inside the pane's scroller, absolutely placed: the pane clips it, and the keyboard, a sheet drag or a dialog move it with the pane. The pane is zoomed by the interface size (`chromeZoom`), and the layout of 3.3 is in screen px, so the canvas's CSS size and the rings' and disc's positions are those screen px divided by the zoom, and the renderer's pixel ratio is `min(devicePixelRatio, 2)` times the zoom: neither blurred at 130% nor oversampled at 85%. At t0 it is sized to the band plus the strip down to the control that rolled, within the pane's visible rect: usually a third of a megapixel at 2x, at most about 1 megapixel on a tall phone sheet. It is drawn at most 2 device pixels per screen pixel, with antialiasing only below 2, since a 4x multisampled buffer the size of a phone's panel would cost about 25 MB.
- **At rest** the drawing buffer shrinks to 1 x 1, keeping the compiled shaders and textures (0.3 to 1.8 MB a kind with mipmaps). The renderer is disposed 30 s after the Dice panel closes and whenever the page goes hidden. There is no idle release while the panel is open: what it keeps is a few MB, and a release would cost the next throw a warm-up.

## 8. Performance

- **A loop only during a throw.** `requestAnimationFrame` runs from t0 to 1,150 ms, about 70 frames, and stops. The scrim, rings and fade are CSS animations on the compositor. At rest nothing runs: the prototype's counters showed the loop stopped and no running animation after every throw.
- **Frame times**, measured with the prototype in the dev room in desktop Chrome at 390 x 844 and 3x pixels, with the processor slowed 4 and 6 times as a stand-in for a mid-range phone. Each row is five rolls, the 1.3 s after each answer:

| Slowed | Roll | Frames over 20 ms, no dice | Same, 3D dice | Render script a frame, median and 95th | Setup per throw | First throw: models, then first frame |
|---|---|---|---|---|---|---|
| 4 times | 2d20kh1+5 | 5 | 7 | 0.4 and 1.1 ms | 18 ms | 73 and 62 ms |
| 4 times | 12d6 | 3 | 8 | 0.7 and 1.5 ms | 15 ms | 65 and 79 ms |
| 6 times | 2d20kh1+5 | 3 | 7 | 0.2 and 1.5 ms | 23 ms | 97 and 105 ms |
| 6 times | 12d6 | 6 | 7 | 1.3 and 2.4 ms | 33 ms | 146 and 80 ms |

The median frame was 16.7 ms in every case. The long frames without dice are the app's own: drawing the result, and the dev room's server, which runs in the page. The dice add about one long frame a throw, its setup: the prototype makes new meshes and materials each time. The build keeps a pool per kind and only moves and re-labels them, aiming under 5 ms. The first throw's cost moves to the warm-up. Under SwiftShader, the e2e browser's renderer, the median frame was also 16.7 ms, at full speed and slowed 4 times.

- **The GPU's cost on a phone is not measured here.** The prototype drew on this laptop's GPU, which no phone matches. The scene is small: at most 13 dice and a disc, a few hundred triangles and about 45 draw calls. A mid-range phone's GPU should draw it well within a frame, but only a phone can say. The live play review on the owner's phone is the check, and the switch is the way out.

## 9. Look

- **Shading**: flat faces under a soft sky light and a key light from the upper left.
- **The tray**: a scrim of the panel's `surface` at 92% behind the band, fading in over 170 ms and out with the dice.
- **Rings and the "+N" disc** are HTML over the canvas, placed at each die's landed spot. The ring leaves a 6 px gap of scrim around the die, so it reads on every set, a gold die beside a yellow accent included (`c3d-sets-accents-phone.png`). The accent comes resolved from `useAccent()`.
- **The toast's d20** is a flat SVG icon (a hexagon with its triangle face) in the app's neutral colors, never the roller's set.

### 9.1 Dice sets

Each set is a body color, an ink for the result, a faint ink for the other faces, an edge color and a finish, drawn in code into the same canvas textures: no image, texture file or art of any kind.

| Set | Body | Ink | Faint | Edge | Finish | Result, 60 and 46 px | Faint |
|---|---|---|---|---|---|---|---|
| Ivory (default) | `#f1efe9` | `#16161a` | `#a29e93` | `#c9c4b6` | Matte | 11.8, 11.7 | 2.2 |
| Obsidian | `#2a2a33` | `#f4f1ea` | `#6f6d7a` | `#9a97a6` | Glossy | 7.3, 7.3 | 2.4 |
| Ruby | `#94102a` | `#ffffff` | `#d0697a` | `#f08a98` | Translucent | 6.9, 6.8 | 2.1 |
| Sapphire | `#173f9e` | `#ffffff` | `#6f8fd8` | `#8fb0ff` | Translucent | 7.0, 7.0 | 2.3 |
| Emerald | `#0a5236` | `#ffffff` | `#4e9677` | `#5fc59a` | Glossy | 6.7, 6.7 | 2.4 |
| Amethyst | `#5b2a9e` | `#ffffff` | `#9d7ccf` | `#b99cf0` | Translucent | 7.0, 6.9 | 2.2 |
| Gold | `#d9b448` | `#24180a` | `#86681a` | `#f6dc86` | Metal | 12.5, 12.4 | 2.1 |
| Steel | `#c3c8d1` | `#15171c` | `#737884` | `#eef1f6` | Metal | 15.5, 15.2 | 2.2 |

- **Finishes**, all in three's core: matte is `MeshLambertMaterial`, glossy `MeshPhongMaterial` with a white highlight, metal a Phong material with a darker body and a highlight tinted the edge color (an environment map would look more like metal but needs a generated scene and a second pass), and translucent a Phong material at 86% opacity whose back faces are not drawn, so no number shows through from behind.
- **Legibility, measured.** The last two columns are contrast ratios read from rendered pixels: a lone d20 showing 17 (two digits), lit as in the tray, on the scrim, at 3x pixels. Every result is at least 6.7:1, above the 4.5:1 WCAG asks of small text, and every faint number sits between 2.1 and 2.4:1. `c3d-sets-d20-phone.png` shows each set's lone d20 at 60 px, and `c3d-sets-two-rows-phone.png` seven d20s at 46 px.
- **Shape on the scrim.** Obsidian, Ruby, Sapphire, Emerald and Amethyst are dark against the scrim (1.3 to 1.7:1), so their edges carry the outline: every edge color is at least 5.7:1 on the scrim.
- **Accents.** The rings sit on the scrim, never on a die: the default yellow accent is 12.1:1 there, `danger` 4.2:1, above the 3:1 asked of a non-text mark. The header line's chips mark them too.

### 9.2 The picker

- **Where**: Menu, This device, Rolls, under the "Roll animation" switch: "Dice", a radio group of tiles, each a 48 px d20 showing 20 above the set's name. The grid flows to the width, `repeat(auto-fill, minmax(72px, 1fr))`: four to a row at 390 px, three at 320 px, two at 320 px and 130%, and never a sideways scroll. The chosen tile has the accent border and is checked for a screen reader ("Dice: Ruby, selected").
- **Previews**: when This device opens with the switch on, Low power off and WebGL there, in an `idle` callback, the chunk renders each set's d20 once and copies each picture into its tile's 2D canvas. It uses the stage's renderer when one exists, else a short-lived one it disposes at once. Nothing animates.
- **Otherwise** each tile shows the toast's flat d20 icon in the set's body, edge and ink colors, drawn in SVG: until the previews are ready, and with the switch off, Low power, no WebGL or a failed load. The choice is still saved. Without WebGL the help says so, and with the switch off the picker is disabled with "Turn on Roll animation to throw dice."
- **Storage**: `rvtt.diceSet`, the set's id (`ivory` when unset or unknown), through `setting()` in `features/device/settings.ts`. No room data, no op, no server change: only this device throws its own rolls.

## 10. Tests

**Unit** (`node:test`, where three's math classes run as they do in the browser):

- `throw/models.test.ts`: for every kind (d4, d6, d8, d10, d12, d20, the coin) and every face, the solved orientation turns that face to the viewer (cosine at least 0.9999) and its number upright (within 10 degrees). The d10 has ten flat faces. Opposite faces add to n + 1 on the d6, d8, d10, d12 and d20. The d100 split: 84 is "80" and "4", 100 is "00" and "0", 7 is "00" and "7".
- `throw/layout.test.ts`: the rule of 3.3 for 1 to 20 dice at widths 278, 288, 293, 328, 348, 356 and 363 px: every row fits its width, two rows fit 112 px, no die is under 44 px, a d100 pair is never split, "+N" counts the dice left, and the deciding d20 is shown. For 500 random formulas rolled with `rollFormula` and a seeded draw, `throwDice` gives the result's faces in order, up to the cap.
- `throw/poses.test.ts`: the pose at 1,000 ms and later is the solved one, every pose is finite, and the same tag gives the same path.
- `throw/probe.test.ts`: the probe runs once, caches its answer, releases its context, and is not run with the switch off, in Low power or in a preview. The loader imports the chunk the first time the settings allow, and only once.
- `throw/store.test.ts`. The store takes the switch, Low power, reduced motion, WebGL, the preview and the set as inputs, so it needs no setting.
  - One case per entry point: the formula's Roll, a roll option, the header line's Again, Recent rolls' Again, an answer and a death save sent from the panel each throw, and the tracker's Roll does not.
  - No throw for: the inputs that stop it, a chunk or warm-up not ready, a hidden page, several creatures, a surface other than the Dice panel, a commit seen before the panel mounted, a refusal, `unknown`, a bare line, or an answer more than 3 s after its tap.
  - **The randomized test** (the state machine rule): 2,000 random sequences of taps (in the panel and elsewhere), answers, refusals, unknowns, chunk loads and failures, warm-ups, context losses and restores, deliberate disposals, newer rolls, panel taps and keys, panel mounts, closes and resizes, page hides and shows, setting changes and clock steps. Invariants:
    - A committed result shows by t0 + 1,000 ms, and at once after any interruption. It never shows before the dice land while a throw runs.
    - Never two throws at once, and no loop after a throw ends.
    - A refused or unknown roll, a roll from outside the panel, and a commit seen before the panel mounted never throw.
    - A deliberate disposal never counts as a lost context.
    - Liveness: with the panel open, the switch on, WebGL and the chunk ready, a roll committed after the warm-up that follows a page show or a context restore does throw.
    - The renderer is disposed within 30 s of the panel closing, and never while a throw runs.
- `lib/idle.test.ts`: with `requestIdleCallback` undefined, `idle` still calls back within its `maxMs`.
- `Roller` render test (the `html()` pattern): the first render after the commit shows no total during a throw, the live region already says it with its verdict ("Rolled 23, Critical Hit: Longsword.", a Champion's 19), Again is enabled, and the canvas is `aria-hidden` with no pointer events.
- `logic.test.ts`: `recentRolls` leaves out the throw's row until it lands, and no other.
- `useRollToasts.test.ts`: the d20 icon for one d20 test only, and the ring with `rollVerdict`'s hidden text for a kept 20 with no AC ("Natural 20") and for criticals on 18, 19 and 20 against an AC ("Critical Hit").
- `device.test.ts`: `parseRollAnimation` is on unless "off". `parseDiceSet` gives a known id, else `ivory`.
- `throw/sets.test.ts`: every set's ink against its body, unlit, at least 7:1, its faint between 1.8 and 3:1, and its edge at least 4.5:1 on the scrim.
- `throw/lazyThree.test.ts`: the source scan of section 6. The post-build chunk check runs in CI after `pnpm build`.

**e2e**: new steps in `dice.e2e.ts`, labeled `ra-`, plus `reach`. Its browser launches with `--enable-unsafe-swiftshader --use-angle=swiftshader-webgl`, so the throw runs in CI, which has no GPU. A step that finds no WebGL fails when `CI` is set and skips elsewhere. Every other e2e file runs without WebGL in CI and never builds a renderer, so no console error is logged.

1. `ra-1` Pat rolls 1d20 at 390 x 844: right after the answer the dice canvas is there and the header line has no total. Within 1,100 ms the total shows, and the stage's test hook (`data-landed` on the canvas) names the face the header's chip shows. By 2.5 s no loop runs.
2. `ra-2` Reduced motion emulated: the total at once, and the canvas shows landed dice with no frames after the first.
3. `ra-3` WebGL unavailable (`getContext` stubbed to return null), Low power on, and the switch off: the total at once, no canvas, no console message.
4. `ra-4` During a throw, a tap on the header line's Again shows the first result at once and rolls again. A tap on Recent rolls' second-row Again sends that row's roll, not the one that just landed. A tap on the formula field focuses it and removes the dice.
5. `ra-5` The tracker's Roll with Dice open in the other pane throws nothing.
6. `ra-6` The DM rolls in secret: the DM's device throws, and Pat's makes no canvas.
7. `ra-7` Pat's attack makes the DM's toast lead with a d20 icon showing Pat's face.
8. `ra-8` At 320 x 568, at 100% and 130%: a 20d6 throw and the dice set picker never scroll the pane sideways, every picker tile is at least 44 px, and the canvas's backing store is its CSS size times `min(devicePixelRatio, 2)` times the zoom.

The existing steps that read the header line right after a roll keep passing, since Playwright's checks wait. Steps 6, 8, 14 and 17, which measure the header line or take its screenshot, do so after the landing.

## 11. Build plan

One build, one review, seven commits:

1. `feat(dice): 3d dice models and the face solver`: `@types/three` 0.160.0 in `package.json` and the lockfile, `throw/models.ts` and `throw/poses.ts` (geometry, the d10, numbering, the d100 split, the solved orientation and the path), `throw/layout.ts` (3.3 and `throwDice`, no three), `throw/probe.ts`, `lib/idle.ts`, with their tests and the lazy-boundary scan.
2. `feat(dice): the throw's store`: `throw/store.ts` (the room-scoped state: background load, warm-up, origin, the tracker listener, the 1 s timer, interruptions, context loss, disposal), with the randomized test. The switch, Low power and the set come in as inputs.
3. `feat(dice): your roll in the Dice panel throws 3d dice`: `throw/stage.ts` (its own context, the renderer, textures, decals, the pool, the loop) and `throw/Tray.tsx` (the canvas host, scrim, rings, disc). `Roller.tsx` holds the result by `held(tag)`, keeps Again mounted as `busy` while the roll waits and live from t0, and its live region adds the verdict in `rollVerdict`'s words. `RecentRolls.tsx` and `logic.ts` hold the row. `useDicePanel.ts` (`roll`, `again`, `noted` through `registerThrow`) and `useRollOption.ts` take the origin. `DicePanel.tsx` listens for taps, keys and resizes. The post-build chunk check joins CI.
4. `feat(device): the roll animation switch and the dice set picker`: `features/device/settings.ts` (`rvtt.rollAnimation` and `rvtt.diceSet`), `throw/sets.ts` (9.1, plain data), `features/device/DiceSetPicker.tsx` and `ThisDevice.tsx` (at the end of Rolls), with Low power's help.
5. `feat(dice): others' d20 rolls show their die in the toast`: `useRollToasts.ts`, `Toast` in `client/state/types.ts` and `notify` in `store.ts` take an optional die, and `ToastNote` in `pages/Room.tsx` draws the icon, `aria-hidden`, with `rollVerdict`'s words as hidden text.
6. `test(e2e): the roll animation`: the `ra-` steps and dice.e2e's launch flags.
7. `docs: the roll animation in FEATURES.md, the shortcuts and the guides`: FEATURES.md's Dice section, This device's switch and picker, and Low power. `state/shortcuts.ts` gains the Dice entry "Any tap or key during a throw: show the result at once, then do its own job", with FEATURES.md's shortcut list in the same commit. design.md's quote of Low power's help, the DM guide's Dice section, and a one-line pointer to this note in docs/design-v1-dice-ui.md 4.7.

Untouched: the ops, the server, the receipt flow, every card, the group save page, the tracker's look, the map and the CSP.

## 12. Decided by the project owner (2026-10-18)

The owner chose among the options the earlier drafts of this design offered:

1. **Style**: 3D dice (option C), rather than the 2D mix the first draft recommended.
2. **Placement**: in the Dice panel's tray under the header line. Never over the map.
3. **Timing**: about 1 s from the server's answer to the landing, by a timer. A tap or key in the panel, a newer roll, closing the panel, hiding the page or an answer over 3 s late ends it at once.
4. **Default**: on, with a per-device switch in Menu, This device, Rolls.
5. **Others' rolls**: no flying dice. Their d20 toast shows a small d20 with its face, and a natural 20 rings once.
6. **Request cards, sound and the table display**: as recommended, none for now.
7. **Neighboring faces**: printed fainter than the result, as recommended.
8. **Percentile**: two d10s, tens and units, as recommended.
9. **Dice color**: "Ivory default with a themed dice selection much like dnd beyond". The chosen set is kept on the device, picked in Menu, This device, Rolls, with no room data. Others' toasts keep the flat d20 icon.
10. **Reduced motion**: the landed dice at rest, with the result at once, as recommended.
11. **Damage of two types, or with a rider**: one tap's rolls for one creature throw all their dice together, up to the cap.
12. **Again during a throw**: stays live. A tap ends the throw, showing its result, and rolls again.
13. **Loading the dice code**: in the background after the room is ready, like the panels, so a dropped connection later never turns dice off. Skipped with the switch off, in Low power, without WebGL, and in View as a player.

## Assumptions

- The live server answers a roll in about 0.1 to 0.3 s, the dev room's in about 50 ms. The 1 s counts from the answer, so a slow network adds only its own wait.
- CI's Chrome on Linux behaves as Chrome on macOS did here: SwiftShader by name passes the performance caveat. Step ra-1 failing in CI with "no WebGL" would show otherwise, and the fix is to drop `failIfMajorPerformanceCaveat`.
- The probe logs nothing on CI's Chrome on Linux with no GPU either. Every e2e file now runs it once at room ready, and eight files assert no console warnings, so a message there would fail them. The evidence is from macOS only: the first CI run settles it.
- No database was needed: the dev room runs the server's resolve in the page.
