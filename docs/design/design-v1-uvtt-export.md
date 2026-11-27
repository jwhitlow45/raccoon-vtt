# raccoon-vtt: export a scene as a Universal VTT file

Status: built (2026-11-27). Draft 4, after design review rounds 1 to 3 (sections 13 to 15), read against OP_VERSION 67 and SNAPSHOT_VERSION 50, which it leaves as they are. Decisions D-261127-196 to 215, round 1 D-261127-250 to 259, round 2 D-261127-290 to 294, round 3 D-261127-295, and the build's D-261127-340 to 351. Builds on D-261127-052 (a Universal VTT export first, a native whole-scene file later). The "As built" section at the end says where the build went its own way.

## 1. Summary

Scenes leave a room only as a PNG today (FEATURES 480) and come in as Universal VTT files (FEATURES 486). This adds **Export as VTT file** beside **Export as image** in a scene's settings. It writes a `.dd2vtt` file with the scene's map image, walls, doors, windows and lights, readable by Foundry's importers, Fantasy Grounds, Arkenforge and this app's own import. A Builder scene or a generated dungeon gets its image from Export as image's render. DM only, client only. No op, no server change, no format step (D-261127-214).

## 2. What the file holds

A Universal VTT file is one JSON object (Dungeondraft's format 0.3, the shape client/features/uvtt/schema.ts reads). Keys go in Dungeondraft's order, the image last. Only standard keys are written (D-261127-197).

| Key | Written as |
| --- | --- |
| `format`, `software` | `0.3`, `"Raccoon VTT"` |
| `resolution` | `map_origin` {0, 0}, `map_size` the scene's bounds in cells, `pixels_per_grid` the export's whole pixels per cell |
| `line_of_sight` | every wall as a 2-point line: grid walls (drawn and automatic) merged into runs along each grid line, each free wall on its own (D-261127-207) |
| `objects_line_of_sight` | each pillar cell's square at `PILLAR_INSET`, as walls.ts blocks it, one closed 5-point line |
| `portals` | each door and window: `bounds` its two ends, `position` the midpoint, `rotation` in radians, `freestanding` false. Doors `closed: true`, windows `closed: false` (D-261127-203) |
| `environment` | `baked_lighting` false, `ambient_light` from the scene's light level now: Bright `ffffffff`, Dim `ff808080`, Dark `ff000000` (D-261127-206) |
| `lights` | lights that are on: `position` in cells, `range` (bright + dim) / feet per cell, `intensity` 1, `color` `ff` and the first six hex digits of the light's color lowercased (a stored `#rrggbbaa` drops its alpha), else `ffffffff`, `shadows` its Walls switch (D-261127-205, 256) |
| `image` | base64 PNG of the render (section 4) |

Coordinates are cells on the 1/64 lattice, which JSON writes exactly. With `map_origin` at 0 the import's frame shift is 0, so file squares are scene cells.

**Inside the scene.** Every line and portal is clipped to [0, w] × [0, h] with the import's own `clipLine` and `clipSegment` (simplify.ts), and lights outside are left out. A scene shrunk after it was built would otherwise write walls past its image, which this app's import refuses past its 1-square slack. One note counts what was cut or left out (D-261127-255).

**Short pieces.** The import drops a line shorter than 0.1 square (`mergeClose`, simplify.ts) and welds ends within 0.1. So a wall or portal shorter than 7/64 square is written lengthened to at least 7/64 along its own line, after the clip (D-261127-290). It grows about its midpoint, each end moving under 0.055, except that an end on the scene's edge stays there and the other end takes the whole growth, so the import's own clip cannot cut it short again. Each moved end rounds outward onto the 1/64 lattice, away from the midpoint, so a diagonal piece stays on the lattice and at least 7/64 long (D-261127-252, 291).

**How the app's parts map.**
- Walls, automatic and drawn: `line_of_sight`. A `none` edge removes an automatic wall first, as `effectiveEdges` reads it.
- On hexes no grid-edge walls exist (hex design HX-D7, `edgeGrid` makes none), so the writer skips `effectiveEdges` there and reads free walls and pillars only. `effectiveEdges` assumes squares and would turn a hex stair mark into square walls (D-261127-250).
- Doors, open, closed or locked: closed portals. The import reads `closed: false` as a window or an open door, window first, so an open door written that way would come back a window.
- Windows: open portals.
- Secret doors: a plain closed door in the DM view, a wall in the player view until found (section 5).
- Lights: on lights only, since an off light would light the map in another VTT. A note counts those left out (D-261127-202).
- Map image, phases, animated maps: the shown phase's image, an animated map's still.
- Builder floors, textures, stamps and labels: drawn into the image only.
- Grid: always squares in the file. A hex scene writes cells as squares (section 6).
- Floors: one file holds one floor. Every floor makes a zip of files (section 7).

**What a file cannot keep:** heights, stairs, ledges and difficult ground (raised edges are not walls: a 5 ft dais would wall off its room, D-261127-215), traps, tokens, fog and what players explored, drawings and areas, locks, secret doors as secret, open doors as open, a light's bright and dim split, a light's label, other floors and the links and openings between them, the hex grid, and the scene's own settings.

## 3. Where it lives and what the DM sees

The Export section stays last in Scene settings (SceneSettings.tsx), in the Scenes panel: the side panel on a computer and a tablet held sideways, the bottom sheet on a phone held upright or sideways and on a tablet held upright. The Scenes panel is DM only (panels.ts `dmOnly`), so no player sees either button (D-261127-198).

**Closed.** One row with two buttons, wrapping at 320 px: **Export as image**, then **Export as VTT file**. Two help lines: today's PNG line, then "A Universal VTT file of the map with its walls, doors and lights, for another VTT or another room here." Opening one shows its options in place of the row, so only one is open, and Close gives focus back to the button that opened it (`useExpansionFocus`).

**Open.** In order:
- **Pixels per square** (**Pixels per hex** on hexes): 50, 70 or 100 px, 70 first, with the image's size line.
- **Floors**: This floor or Every floor, on a scene with floors.
- **Version**: Player view or DM view, Player view first.
  - Player view: "What players can see: walls they have seen, secret doors not yet found as walls, and no lights, since only you have those."
  - DM view: "Every wall, door and light that is on. Secret doors become plain doors, and the map is drawn as players see it. Keep it to yourself."
- The loss line, always shown: "The file keeps the map, walls, doors, windows and lights. Heights, traps, tokens, fog, locks, open doors and secret doors stay here." With floors and This floor it adds " Other floors stay here too." Where the export holds a wall or door under 14/64 square (section 6) it adds " A wall or door shorter than a fifth of a square may not come back." On a hex scene a second line: "Other VTTs read the file's grid as squares, so hexes leave as squares and their walls as lines off the grid."
- No Grid checkbox: every reader draws its own grid (D-261127-213).
- **Close** and **Make the file**, busy "Making the file…" (Every floor: "Making Upper floor (2 of 3)…", everyFloor.ts `makingText`). The shared indicator shows after about 200 ms and the busy button refuses a second tap.
- Made: "Made Crypt of Doom.dd2vtt: 2100 × 1400 px at 70 px per square, 12.4 MB." then notes, then **Save or share** where the device prefers it, and **Download**.

**Notes**, one line each, only when they apply. On Every floor a floor's own note starts with its name.
- "3 secret doors written as walls, as players see them." (player view) or "3 secret doors written as plain doors." (DM view).
- "2 lights switched off left out."
- "2 stamps players cannot see left out of the map."
- "1 label under the fog left out." (player view with fog, as the image's).
- "4 walls, doors or lights past the scene's edge cut or left out."
- "Phones import files up to 40 MB, so this one imports on a computer." On Every floor: "Upper floor's file is over 40 MB, so it imports on a computer."
- "Some walls change when this file is imported here." (section 6), with " (a door sits very close to a wall)" before its full stop when a door or window cut a wall (D-261127-353).
- "This app's import would refuse this file: <the import's own sentence>." On Every floor: "This app's import would refuse Upper floor's file: <sentence>." (section 6).
- The image's map-missing line.

**Errors** in `role="alert"`: the image's server line, and "The file could not be made. Try a smaller scale."

**Search.** scenes/search.ts gains `scenes.export-vtt`, "Export as VTT file", names "universal vtt", "dd2vtt", "uvtt", "foundry", "export walls", shown as `scenes.export` is. No new key or gesture, so the shortcut sheet is unchanged.

## 4. The image

The image is Export as image's render (render.ts `renderMapPng`) with the grid off, at the chosen scale under 16,777,216 px and 8,192 px a side, the import's `MAX_MAP_SIDE`. The side cap goes in as `exportSize`'s `limits`, and everyFloor.ts `everyFloorFits` gains the same `limits` argument, so Every floor keeps it too (D-261127-208, 257). When no offered scale fits every floor, as on a scene 180 squares long, `everyFloorScale` lowers every floor to one shared scale, the largest that fits them all, and a line says what bound it (D-261127-352). The image is always drawn as players see the map with no fog (D-261127-200): the player-role drawing, so no lock marks, no "S", secret doors not found drawn as walls, and no DM-only stamps.
- Player view: Export as image's Player view content: the server's (`api.getPlayerView`) on a scene with fog on, drawn and walled under `players.scene.autoWalls ?? "off"`, as MapExport.tsx draws it, else `exportContent(view: "player")` (D-261127-258).
- DM view: new `fileImageContent` in content.ts, `exportContent` on the scene with `fogEnabled: false` and view "player". Its walls come from the DM's chunks (section 5).

PNG, since every reader takes it and Safari cannot encode WebP. Base64 is made in 3 MiB slices of the PNG's bytes (a multiple of 3, so no padding inside), yielding between slices so the busy button paints, and the file is a `Blob` of the JSON head, the slices and the tail, never one joined string. The canvas (64 MiB at the cap) is freed before the base64 starts, so the peak after it is the PNG plus its base64, about 2.3 times the PNG: 58 MB for a 25 MB PNG. A 4096 × 4096 render takes about 2 to 4 s on a mid-range phone, as Export as image does today.

## 5. Privacy

The export runs on the DM's device from state the DM already holds and sends nothing to anyone. The projection is unchanged, so nothing new reaches a player's device. Both reviewers confirmed this in round 1.

The one player-labeled export today is Export as image's Player view (MapExport.tsx). The VTT file's Player view keeps its promise and two more:
- **No secret door as a door.** Its walls come from the same player chunks its image is drawn from (`projectChunkForPlayer` with fog off, the server's held chunks with fog on), where an undiscovered secret door, edge or free, already reads as a wall (project.ts CHUNK_FOR_PLAYERS, `shownEdge`, `shownFreeWall`). The writer never reads the DM's chunks in this view.
- **No light.** Lights are DM only in every wave (model.ts `Light`), so a Player view file writes `lights: []`.
- With fog on, only the chunks the server sends players.

The DM view writes what the DM holds, with " (DM)" in its file name and "Keep it to yourself."

Tests: write.test.ts "a player view file writes an undiscovered secret door, on an edge and free, as a wall and holds no light", roundtrip.prop.test.ts "no portal where an undiscovered secret door is, and no light", content.test.ts "the DM view's image content draws as players see it with fog off", desk.e2e.ts DUVTT-2 (the downloaded file's JSON), and hex.e2e.ts DUVTT-5 (no export for a player).

## 6. Walls and the round trip

New `client/features/uvtt/write.ts`, pure:
- `uvttGeometry(src, view)`: from `indexBuild(chunks)`, `effectiveEdges(build, rule)` on squares only, `build.free`, and pillar cells, clipped and lengthened as section 2 says. Returns the file's keys minus `image`, and the notes' counts.
- `uvttFile(head, png)`: the Blob of section 4.

**The import check** (D-261127-251, 292). New pure `checkExport(json, feetPerCell)` in steps.ts runs `checkFile({ ...json, image: STAND_IN }, "scene")`, so the schema's counts (20,000 lines, 200,000 points, 2,000 portals, 500 lights), the walls-far-outside rule and the 200-square frame all run, then `convertUvtt` with the dialog's defaults (objects on, open portals as windows, the room's feet per cell). It returns `{ refused }` with the first error, or else `{ changes, portalCut }` (`ExportCheck`): whether the import changes any wall, and whether a door or window cut a wall it lies along (convert.ts `summary.portalCuts`), the one cause the note names. Both sides are first put in one canonical form (uvtt/compare.ts, D-261127-295), read from the file itself: any piece along one grid line with both ends on intersections, a run or a free wall, door or window, becomes unit edges by kind, since a run exports as one line and imports as one edge per cell (D-261127-341). Free pieces, a pillar counting as its four free walls, are compared by kind: each exported piece must be covered by the union of the converted pieces of its kind within 0.2 square, and each converted piece by the exported ones. Counts are compared on this form only: free doors and windows by number (D-261127-342). When any differs it returns the note's flag. `STAND_IN` is a short non-empty base64 string, since `readUvtt` refuses an empty image before anything else. The worker runs it on a `check` message, in a UvttWorker of its own made for the check and terminated after, since worker.ts keeps the last file in module state and client.ts refuses a second request while one waits.

**Squares round trip.** Export then import with the defaults gives, for builds whose wall ends lie on the grid or at least 0.1 square from it, from other ends and from any other piece's interior, pieces at least 14/64 long, and lights at least 0.05 from walls:
- The same effective walls. Automatic walls come back drawn. A free wall comes back with the same ends, except that one along a grid line with both ends on grid intersections comes back as grid edges (walls.ts), the same wall.
- Doors at the same places, all closed. Windows the same.
- Lights at the same places with the same total reach, Walls switch and color. Bright equal to dim comes back exactly. Others come back as even halves: a lamp's 15 and 30 ft returns as 22.5 and 22.5.
- Pillars as four free walls each, the same square. These also stop areas, which a pillar does not (`PILLAR_TAGS` lacks `AREAS`).
- The light level: Bright and Dark come back. A Dim scene with lights is proposed Dark under party vision (`proposedLight`), the import's rule for a map that brings lights.
- The image unchanged up to the upload's 32 MB (`MAX_MAP_UPLOAD_BYTES`). A larger PNG is re-encoded by the import.

**Any build.** With ends anywhere on the lattice, the import can change walls in three ways: pins to the grid and welds each move an end up to 0.1, a piece under 14/64 can collapse (the loss line says so), and a door or window within 0.1 square of a wall cuts that wall at the portal (snap.ts `cutAtPortals`), so opening the door opens a passage through what was one wall. No guarantee is made for such builds. The check compares instead, and when anything differs the made file gets the note "Some walls change when this file is imported here.", which adds "(a door sits very close to a wall)" only when a portal cut was among the changes (D-261127-353). The file is still made, since other VTTs read it as written (D-261127-292).

**What hexes keep.** Every hex wall, door and window is a free wall, written at its exact ends with the lights. Imported here it makes a square scene with the hex art, free walls along the hex sides within 0.2, the same doors, windows and lights, and no hex grid. A hex scene holds at most 4,000 free walls itself, so its file rarely passes a square scene's caps.

**Where this app refuses its own file.** On squares, four ways: pillars (four free walls each) with the scene's own free walls past 4,000, automatic walls (which come back drawn) past 20,000 drawn edges, the split's caps on crossing free walls, and the schema's counts. A build past them still writes, and the check's note says so.

## 7. Floors and names

File names keep the scene's and floor's names as written. Only characters a path forbids (`/ \ : * ? " < > |`) and control characters become `_` (D-261127-253). One floor: `Crypt of Doom.dd2vtt`, `Crypt of Doom (DM).dd2vtt`, `Tower - Upper floor.dd2vtt`. No size in the name, since the file states its grid. A name stays under 200 UTF-8 bytes in all, extension included: the scene part is cut first, then the floor part, each on a code point boundary. In a zip the scene part is cut once for the whole zip, sized for its longest entry, so every entry carries the same scene part the several-file import needs, so a long Japanese name never passes the 255 bytes a file system allows (D-261127-293). The import still reads dashes and underscores in a single file's name as spaces (create.ts `nameFromFile`), so "Sun-Keep" returns as "Sun Keep".

**Every floor** (everyFloor.ts reused) makes one file a floor in one stored zip (zipStore.ts), `Tower.zip` or `Tower (DM).zip`, with entries `Tower - 01 - Ground floor.dd2vtt` and on, lowest first. The player view holds only floors players reached. The several-file import (floorsImport.ts `rowsOf`, `sceneNameOf`) learns this shape: when every picked file's name reads `<scene> - <two digits> - <floor>` with one scene part, the scene is named the scene part and each floor its floor part, both as written. It still sorts by the full name. Other names keep today's rule (D-261127-254). A player view zip with one reached floor holds one file, which imports through the single-file path as "Tower 01 Ground floor" (`nameFromFile` reads the dashes as spaces), a name the DM can change. Phones and iPads open a zip in Files, and New scene's Universal VTT picker takes the files, not the zip (D-261127-259).

## 8. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Builder scene, automatic walls, squares | walls as runs, round trip same edges | roundtrip.prop.test.ts |
| Generated dungeon, every theme, seeded | DM view round trip: walls, doors, lights | roundtrip.test.ts |
| Locked and open door | closed portal, back closed | write.test.ts |
| Secret door, player view, not found / found | a wall, note / a door | write.test.ts, desk.e2e.ts DUVTT-2 |
| Secret door, DM view | plain closed door, note | write.test.ts |
| Player view, lights on the scene | `lights: []` | write.test.ts |
| DM view, an off light | left out, note | write.test.ts |
| Lamp 15/30, color `#ffcc88aa` | range 9 at 5 ft, `ffffcc88`, back 22.5/22.5 | write.test.ts |
| Fog on, player view | walls only on held chunks, rule `off` | write.test.ts on a held build |
| Hex rows and hex columns, stair mark only | no walls written | write.test.ts |
| Free wall 3/64 long | written 7/64 about its midpoint, comes back | write.test.ts, roundtrip.prop.test.ts |
| Short piece on the scene's edge, short diagonal | clipped, then grown inward, ends on the lattice, comes back | write.test.ts |
| Wall (1.5, 1.5) to (4.5, 1.5) beside door (2.5, 1.59375) to (3.5, 1.59375) | file made, "Some walls change" note | steps.test.ts, write.test.ts |
| Grid wall run (1, 2) to (4, 2), alone | imports as three unit edges, no note | steps.test.ts |
| Scene shrunk past its walls and a light | cut at the edge, light left out, note | write.test.ts |
| 20,001 separate grid walls | check refuses at the schema's count | steps.test.ts |
| Square build with 900 pillars and 500 free walls | check refuses at 4,000 free walls | steps.test.ts |
| DM-only stamp, fogged label | not in the image, notes | content.test.ts, MapExport.test.ts |
| Map image scene, no build | image and the scene's walls | desk.e2e.ts DUVTT-1 |
| Hex scene | free walls, hex line shown | write.test.ts, hex.e2e.ts DUVTT-H1 |
| Every floor, 3 floors | zip of three files, import names Tower and its floors | floors-rest.e2e.ts DUVTT-F1, floorsImport.test.ts |
| Name with `/` and Japanese | `_` for the slash, the rest as written | fileName.test.ts |
| 80-character Japanese scene and floor names | under 200 bytes, cut on a code point boundary | fileName.test.ts |
| Zip with a short and a long floor name, long scene name | one scene part in every entry | fileName.test.ts |
| Tall scene, 200 × 20 at 100 px | side kept at 8,192 px, also on Every floor | size.test.ts, everyFloor test |
| File over 40 MB | phone note, floor named on Every floor | MapExport.test.ts |
| Server fails the player view | the image's error line | MapExport.test.ts |

## 9. Tests

- **client/features/uvtt/write.test.ts**: each mapping row of section 2, clipping, lengthening, hex rows and columns, the notes' counts, environment by level, the privacy test.
- **client/features/uvtt/roundtrip.prop.test.ts** (fast-check): random square builds (painted cells under each automatic walls rule, drawn edges of every kind, free walls on the lattice, lights) through `uvttGeometry`, `JSON.stringify`, `readUvtt` and `convertUvtt`. A spaced generator, which also keeps ends 0.1 from other pieces' interiors, checks section 6's exact claims and that the check reports no change. A free generator, ends anywhere on the lattice and pieces from 1/64 long, checks that the check's flag is set exactly when the converted walls differ by section 6's comparison, and the loss line's flag exactly when a piece under 14/64 exists. Player view: no portal at an undiscovered secret door, no light. A hex variant at 0.2.
- **client/features/uvtt/roundtrip.test.ts**: the dungeon generator's ops for a fixed seed per theme, reduced into a room, then the round trip.
- **client/features/uvtt/steps.test.ts**: `checkExport`, a schema refusal apart from a conversion refusal, a run and a free piece on a grid line with no note, a door's cut and a wall pinned to the grid, each with its flags.
- **client/features/uvtt/encode.test.ts**: slices equal one `btoa`, the Blob parses, `decodeImageBase64(image)` (image.ts) equals the PNG's bytes.
- **client/features/uvtt/floorsImport.test.ts**: the `<scene> - NN - <floor>` names, a mixed pick keeping today's rule.
- **client/features/mapexport/content.test.ts**, **fileName.test.ts**, **size.test.ts**, **MapExport.test.ts**: the rows above.
- **e2e/desk.e2e.ts**: DUVTT-1 a map image scene's file downloads and imports back with the summary's counts. DUVTT-2 a Builder scene with a secret door, player view, then DM view. **e2e/hex.e2e.ts** DUVTT-5: no Scenes panel and no export for Pat, a player.
- **e2e/hex.e2e.ts** DUVTT-H1 (pixels per hex, the hexes' line, a hex side's wall at its exact ends and no square grid walls). **e2e/floors-rest.e2e.ts** DUVTT-F1 imports the three files back and asserts the scene's and floors' names.
- **Alignment**: a `vtt-export` root in e2e/alignmentRoom.ts, the options open, at 1440x900, 390x844 and 320x568, 100% and 130%. Run alignment, alignment-wide, desk, hex, floors-rest and reach.
- Mutation checks: flip the player view's secret door rule, write off lights, write open doors as `closed: false`, drop the lengthening, drop the clip, run `effectiveEdges` on hexes. Each must fail a test.

## 10. Files and lanes

| Lane | Files | Size |
| --- | --- | --- |
| UVA writer | client/features/uvtt/write.ts (new), encode.ts (new), compare.ts (new, as built), exportTestutil.ts (new, as built), steps.ts, messages.ts, worker.ts, client.ts, write.test.ts, encode.test.ts, steps.test.ts, roundtrip.prop.test.ts, roundtrip.test.ts | M |
| UVB dialog | client/features/mapexport/MapExport.tsx, UvttExport.tsx (new), picture.ts (new: one floor's content and render, moved out of MapExport.tsx), made.tsx and vttNotes.ts (new, as built), content.ts, content.test.ts, fileName.ts, fileName.test.ts, size.ts, size.test.ts, everyFloor.ts, MapExport.test.ts, client/features/uvtt/floorsImport.ts, floorsImport.test.ts, client/features/scenes/search.ts, e2e/desk.e2e.ts, e2e/hex.e2e.ts, e2e/floors-rest.e2e.ts, e2e/alignmentRoom.ts, then FEATURES.md, docs/dm-guide.md, docs/design/design-v1-uvtt-export.md | M |

Both run at once. Shared contract, written first by UVA as a stub commit:

```ts
export type UvttSource = { scene: Pick<Scene, "bounds" | "gridShape" | "autoWalls" | "vision">; chunks: readonly BuildChunk[]; rule: AutoWalls; lights: readonly Light[]; feetPerCell: number; pxPerCell: number };
export type UvttCounts = { secretAsDoors: number; lightsOff: number; clipped: number; short: boolean; walls: number; doors: number; windows: number; lights: number };
export type UvttHead = { json: Record<string, unknown>; counts: UvttCounts };
export function uvttGeometry(src: UvttSource, view: "player" | "dm"): UvttHead;
export function uvttFile(head: UvttHead, png: Blob): Promise<Blob>;
export type ExportCheck = { refused: string } | { changes: boolean; portalCut: boolean }; // steps.ts, as built (D-261127-340, 353)
export function checkImport(head: UvttHead, feetPerCell: number): Promise<ExportCheck>; // client.ts, its own worker
```

The player view passes the image content's chunks, its rule and `lights: []`. FEATURES.md: a bullet after Export as image's, and the import's bullets gain "A file this app exports comes back with its walls, doors and lights, and the export says when some walls would change." FEATURES 411 and the DM guide's several-file paragraph learn the `<scene> - NN - <floor>` rule (D-261127-294). DM guide: one paragraph in the maps chapter, in guide voice, saying to open Every floor's zip and pick its files in New scene's Universal VTT picker.

## 11. UI checklist

- Loading: busy button, shared indicator at about 200 ms, Every floor's per-floor words. Every path ends in Made or an error line.
- Keys and focus: options open at Pixels per square, Close returns focus to the opener, nothing new in the shortcut sheet.
- Screen readers: buttons by their words, Segmented groups by their row names, errors in `role="alert"`.
- Large interface sizes: the button row wraps at 320 px and 130%, measured by the sweep.
- Contrast and motion: existing tokens and components, no motion.
- Words: exactly as in section 3.

## 12. Decisions and rejected options

- **D-261127-196** `.dd2vtt`, which Fantasy Grounds and every Foundry importer take. Rejected: `.uvtt`, offering both.
- **197** Standard keys only. Rejected: a namespaced key for locks, secret doors, heights and the light split (a native scene file in disguise).
- **198** A second button in Scene settings' Export section. Rejected: a format switch inside Export as image, the scene row's menu.
- **199** Player view and DM view, Player view first. Rejected: DM view alone.
- **200** The image drawn as players see it in both views. Rejected: DM marks and DM-only stamps in a DM file's art.
- **201** A player view file holds no lights. Rejected: lights players see the effect of.
- **202** Off lights left out, with a note. Rejected: writing them on.
- **203** Every door written closed. Rejected: open doors as `closed: false`, which read back as windows.
- **204** Secret doors: plain doors in the DM view, walls until found in the player view. Rejected: walls in the DM view too.
- **205** Light range as bright plus dim. Rejected: dim alone, bright alone.
- **206** `environment` from the light level, never baked. Rejected: `baked_lighting` true.
- **207** 2-point runs. Rejected: chained polylines.
- **208** PNG, 16.7 million px, 8,192 px a side. Rejected: WebP, JPEG, Dungeondraft's 256 px.
- **209** Names without the size. Rejected: the image's `30x20-70px`.
- **210** Every floor as a zip of files. Rejected: one floor only.
- **211** Hex scenes export as cells. Rejected: refusing hex scenes.
- **212** The import check is a note. Rejected: refusing a file other VTTs can read.
- **213** No grid lines. Rejected: a Grid checkbox.
- **214** No format step and no server change.
- **215** Raised edges are not walls. Rejected: ledges as walls.
- **250** On hexes only free walls and pillars are read. Rejected: `effectiveEdges` with a hex grid argument (no hex grid-edge walls exist to read).
- **251** `checkExport`: `checkFile` with a stand-in image, then `convertUvtt`, on its own worker. Rejected: `convertUvtt` alone, which misses the schema's counts.
- **252** Pieces under 7/64 lengthened about their midpoints, and pieces under 14/64 disclosed. Rejected: lengthening to 14/64 (moves ends past the 0.1 the import allows), accepting silent loss.
- **253** Names as written, forbidden characters as `_`, " (DM)" for the DM view. Rejected: the image's lowercase slug, which loses case and other scripts.
- **254** Every floor entries `<scene> - NN - <floor>`, read back by the several-file import. Rejected: `01 Ground floor` alone, which leaves the scene's name to the first floor's.
- **255** Clip to the scene and count it. Rejected: writing past the image.
- **256** Color from the first six hex digits. Rejected: writing a stored alpha.
- **257** The side cap through `limits`, Every floor included. Rejected: a separate cap for the VTT export.
- **258** The player view with fog on walled under the players' rule. Rejected: the scene's own rule.
- **259** The zip is opened before import. Rejected: a `.zip` picker in the import (a new reader of untrusted archives).
- **290** Clip first, then lengthen, an edge end staying on the edge. Rejected: lengthening first, which the import's clip undoes.
- **291** Lengthened ends round outward onto the lattice. Rejected: rounding to nearest, which can fall under 7/64.
- **292** No preservation guarantee for any build: the check compares the converted walls and adds a note. Rejected: moving portals off walls in the export (changes the DM's map), an import path that skips the portal cut (changes how every outside file imports).
- **293** Names under 200 UTF-8 bytes, scene part cut first. Rejected: no cap, a cap in code points.
- **295** The check compares canonical geometry: unit edges by kind for grid pieces, coverage against the union of same-kind pieces for free ones, pillars as four free walls. Rejected: merging collinear pieces before comparing (more code for the same answer).
- **294** FEATURES 411 and the guide learn the name rule. Rejected: leaving it to the import's dialog alone.

**Look hardest at:** 200 (DM file art as players see it), 203 (open doors come back closed), 205 (the light split), 252 and 292 (short pieces and the check's comparison), 254 (the name shape the import learns).

## 13. Round 1 changes

| Finding | Settled in |
| --- | --- |
| SOL-1 hexes and `effectiveEdges` | section 2 (How the app's parts map), D-250, cases hex rows and columns |
| SOL-2 = R2 the check misses schema refusals | section 6 (The import check), D-251, steps.test.ts |
| SOL-3 short walls and portals dropped | section 2 (Short pieces), section 6 (Any build), loss line, D-252, both generators |
| R1 names do not round trip | section 7, D-253, D-254, floorsImport.ts in UVB, DUVTT-F1 |
| R3 geometry past the bounds | section 2 (Inside the scene), the note, D-255 |
| R4 `#rrggbbaa` color | section 2 table, D-256 |
| R5 hex refusal reasoning, 500 lights | section 6 (What hexes keep, Where this app refuses), pillar case |
| R6 fogged labels | section 3 notes |
| R7 side cap on Every floor, per-floor notes, memory | sections 3 and 4, D-257 |
| R8 round-trip claims | section 6 (Squares round trip) |
| R9 the players' rule with fog on | section 4, D-258 |
| R10 open doors, the zip, `decodeImageBase64` | loss line, section 7, D-259, section 9 |
| R11 decisions log | D-196 to 215 and D-250 to 259 appended to the decisions log |

## 14. Round 2 changes

| Finding | Settled in |
| --- | --- |
| SOL-4 portal cuts open a wall | section 6 (The import check, Any build), the note in section 3, the exact generator's interior spacing, the regression case, D-292 |
| R12 a short piece across the edge | section 2 (Short pieces), D-290, case |
| R13 lengthened ends off the lattice | section 2 (Short pieces), D-291, case |
| R14 names past 255 bytes | section 7, D-293, fileName.test.ts case |
| R15 FEATURES 411 and the guide, one-floor zip | sections 7 and 10, D-294 |

## 15. Round 3 changes

| Finding | Settled in |
| --- | --- |
| SOL-5 = R16 the comparison flags unchanged runs | section 6 (The import check), D-295, the three-square run case, the spaced generator's no-change property |
| R17 one scene part per zip | section 7, fileName.test.ts case |
| R18 a one-floor zip's name | section 7 |

## 16. As built

Where the build went its own way, with the decision ids from the decisions log (D-261127-340 to 351):

- **The check's answer.** `checkImport` answers `{ refused: string }` or `{ changes: boolean; portalCut: boolean }` (steps.ts `ExportCheck`) rather than a string or null, so the dialog words the refusal and the change notes itself and names the floor on Every floor (D-261127-340). A check that cannot run adds no note, and the file is made.
- **The canonical form reads the file** (uvtt/compare.ts). Any piece along one grid line with both ends on intersections becomes unit edges by kind, whether it came from a run or a free wall, door or window, so round 4's P3 (a free piece on a grid line flagging an unchanged wall) cannot arise: the export side never knows which it was (D-261127-341). Free doors and windows are also compared by count, since two doors welded into one stay within the cover (D-261127-342). Coverage is exact: each piece's span inside each same-kind capsule, joined over [0, 1].
- **Secret doors in the DM view** counts every secret door, found or not, since a found one also loses its secret in the file (D-261127-343).
- **Every floor's notes.** Counted notes are summed over the floors, as Export as image's are. A floor's own notes read "Upper floor's file is over 40 MB, so it imports on a computer.", "Some walls change when Upper floor's file is imported here." and "This app's import would refuse Upper floor's file: …" (D-261127-344).
- **A lowered scale** says why: "Lowered to 40 px per square, so the image stays within 8,192 px a side, the most this app's import takes. It will be 8000 × 800 px.", or the image's 16.7 million pixels, whichever bound it (D-261127-345).
- **The loss line's short clause** is worked out from the DM's build of the floors in the export while the options are open, and from the made files once made, so it shows before a file is made too (D-261127-346).
- **A pillar the scene's edge cuts** is written side by side as separate lines, and counts once in the edge note (D-261127-347). A diagonal cut at the edge has its cut end rounded onto the lattice along the edge (D-261127-348).
- **The writer's own secret door rule.** Besides the player chunks it is given, the writer writes any undiscovered secret door as a wall in the player view, so a caller that passed the DM's chunks still leaks no door.
- **Files.** The made file's lines and buttons moved to mapexport/made.tsx, shared by both exports, and the VTT export's words to mapexport/vttNotes.ts, so the tests read them without React. client/features/uvtt/exportTestutil.ts holds the tests' builds and round trip. Export as image's options now live in their own component, so closing them resets its choices, as closing Export as VTT file does (D-261127-349).
- **Tests.** DUVTT-5 runs in hex.e2e.ts, whose room has a player, Pat, where desk.e2e.ts has only a DM (D-261127-350). The alignment sweep measures `export-buttons` and `vtt-export` at 390 x 844, 320 x 568 and 1440 x 900, at 100% and 130%.
- **Every floor's entries** carry no " (DM)", only the zip's name does, so the several-file import reads the floor names unchanged (D-261127-351).
- **Review round 1.** An exported tower's scene part is the one prefix every file's name shares with a number of its own, so a floor or scene name holding " - 02 - " comes back whole (UVTT-SOL-1). Every floor of a long scene lowers every floor to one shared scale (D-261127-352). The change note names the door only when a door's cut changed a wall (D-261127-353). A DM view secret door past the scene's edge counts as cut and not as a door too. The loss line's short-wall check follows the floors' key (everyFloor.ts `floorsKey`), not each op.
