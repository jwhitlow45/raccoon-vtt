# The dungeon generator: design draft 2.1 (2026-11-02)

Status: built, phase 1 (2026-11-02). Draft 2.1 passed design review in round 3, and the build followed it except where **As built** says otherwise. The Round 1, Round 2 and Round 3 sections at the end list each finding and what changed, and Build review round 1 the fixes after the build. From [mvp.md](mvp.md) section 3, Later: "Dungeon generator." The project owner set the Later order on 2026-11-02 (D-261102-007): the generator comes right after the easy items. Code was cited from the tree before this feature, at OP_VERSION 41 and SNAPSHOT_VERSION 31. The generator adds no op or snapshot version of its own: it ships at whatever versions the app is on. Decisions are D-261102-370 to D-261102-389 (section 16) with D-261102-022 to 024, and the build's own guesses are in As built.

## Summary

- **What it makes.** A new Builder scene holding a whole dungeon in the builder's own data: painted floor rooms and corridors with only automatic walls, closed and locked doors, heights reached by stair runs, pits, rubble, pillars and daises, and four of the SRD's example traps. Sight, fog, Reveal room, walking distance, the walls rule, Isometric, Export as image and room backups work on it unchanged.
- **Where.** Scenes, New scene, Builder: "Generate a dungeon" opens a dialog with the choices, a preview drawn from exactly what will land, Reroll, and Make the scene.
- **How it lands.** At most 60 ordinary ops (`scene.create`, `build.paint`, `build.edge` for doors, `build.height`, `build.stairs`, `trap.create`) in one Setup undo group, the Universal VTT import's path. Usually one Undo setup takes it back, and the scene's Delete always does once the players are on another scene.
- **Replay and versions.** The stored ops hold the result, so the generator never replays and may change freely. No new state, op or field, so the generator takes no OP_VERSION or SNAPSHOT_VERSION step in any phase.
- **Privacy.** It runs on the DM's device. The seed lives only in the open dialog, never stored or sent. Every wall is automatic, so no drawn edge marks a hidden room's side. No starting view is stored. Players receive the build only as map discovery allows. The seed's 75 random bits drive a ChaCha20 stream, so neither guessing nor the rooms seen give a player the rest.
- **Phase 1 is one batch:** squares, Dungeon and Crypt, no secret doors, four lanes (L, M, M, S) after a contract commit. Phase 2 adds themes, lights, dressing, a DM key, more traps and secret doors (after SECRET-DOOR-DRAWN-EDGE). Phase 3 adds hexes and generating into an existing scene.

## 1. Today

- **The builder** paints floor terrains (stone, wood, grass, dirt, cave) and overlays (water, difficult, rubble, pit, pillar, stairs) per cell (`BuildChunk.cells`), edges (wall, door, window, No wall), heights (`heights`, 5 ft steps), stair marks (`up`) and difficult ground (`rough`). Automatic walls stand between a painted and an unpainted cell (shared/rules/autoWalls.ts), and touching painted cells merge. Players' chunks carry automatic walls in their `auto` bitmap and drawn edges in `edges` (shared/project.ts 2129 to 2160).
- **Bulk ops** are bounded: `build.paint`, `build.height`, `build.stairs` (2,000 cells), `build.edge` (500 edges), `trap.create` (one trap). `build.rect` and `build.paint` both call `setCells` (shared/reducer/map.ts 855 to 871).
- **A square stair** links only the two edges along its own axis, whatever the heights (shared/rules/walls.ts 740 to 747). Every other edge between two grounds is a ledge.
- **The Universal VTT import** (uvtt/batch.ts, ImportDialog.tsx, uvtt/rules.ts) sends `scene.create` and batches of build ops under one group with `groupScope: "setup"`, counts the answers, and when answers were lost checks the stored scene before it says complete (`mustCount`, `importOutcome`, `sceneShown`, `CHECK_MS`).
- **Sending.** `dispatch` parses an op and queues it (client/state/store.ts 858 to 880). Whether the device predicts it is `satisfies` (shared/reads.ts): an op that reads `scene:<id>` whole is predicted only on the scene the view shows. The server takes 20 ops a second a socket after a burst of 60 and answers `retry busy` past it (server/rooms/budgets.ts `OpRate`, actor.ts 1041).
- **Admission.** After `applyOp` the server's `#reduce` runs `checkLimits` (shared/limits.ts), `splitCheck` (shared/rules/walls.ts, a no-op without free walls) and `sightPiecesCheck` (shared/visionLimits.ts) on `withPitsCounted` (shared/rules/pitCount.ts), then the size guard and the memory estimate (server only, actor.ts 1608 to 1650).
- **Undo** merges a grouped op into the member's newest step only while nothing else was recorded since (server/rooms/undo.ts 217). History lives in memory.
- **Reveal room** floods painted cells up to walls, windows and closed or locked doors (`floodRoom`, walls.ts 1771). An open door or a bare opening joins two areas.
- **Traps** start from eight SRD presets at four bands (`trapPreset`, `newTrapInput`). A hidden trap never reaches a player, and only traps on the players' scene go off by themselves.
- **The camera.** A scene opens on its stored starting view, else a fit (client/canvas/sceneCamera.ts `openSceneCamera`), whose `fit` Stage.tsx builds from its own `fitScene` with a null target (Stage.tsx 176 and 415 to 421). `fitScene` already frames a target rectangle when given one. `defaultView` reaches players as it is (project.ts 2894). `fitSlot` (client/canvas/fitSlot.ts) is per room scope, so "View as a player" has its own.
- **Deleting a scene** is refused for the players' scene (shared/permissions.ts 662, "Move the players to another scene first.") and for the room's last scene, and the scene's menu disables it then (SceneMenu.tsx 294).

## 2. The rules (SRD 5.2.1)

SRD 5.2.1 has **no random dungeon tables**, checked against its text: its Gameplay Toolbox holds Travel Pace, Creating a Background, Curses and Magical Contagions, Environmental Effects, Fear and Mental Stress, Poison, Traps and Combat Encounters, and nothing elsewhere generates rooms. The app ships no DMG table text, and the generator's choices are written fresh.

- **Gameplay Toolbox, "Traps"** (p. 199): "Traps should be used sparingly, lest they lose their charm." Traps starts on Few.
- **Gameplay Toolbox, "Example Traps"**: the presets the Trap tool ships. Phase 1 places four (5.3 step 10).
- **Playing the Game, "Difficult Terrain"** (p. 14): "Low furniture, rubble, undergrowth, steep stairs, snow, and shallow bogs are examples of Difficult Terrain." Rubble squares use the builder's Rubble terrain, which costs double.
- **Playing the Game, "Rhythm of Play"** (p. 5): the GM tells players "how many doors lead out of a room". Every doorway gets a real door.
- **Character Creation, "Trinkets"** (p. 26): the table "can help stock a room in a dungeon". Phase 2's DM key may roll on it.

## 3. How comparable tools do it (ideas only, never code)

- **donjon's random dungeon generator**: a form with a seed, size and shape, room layout, door and corridor styles, dead ends, and a numbered key. Taken: a few choices and a seed, corridor styles, and (phase 2) a key. Left: a picture as the result.
- **Watabou's One Page Dungeon**: one click, a title and notes on the page, almost no choices. Taken: Reroll first and good defaults. Left: a dungeon you cannot edit.
- **Dungeon Alchemist**: generates and furnishes rooms by theme, exports to VTTs (the app imports its files). Taken: themes, and generate first, edit after.
- **DungeonFog**: an online editor whose maps stay walls, doors and lights, exported as `.df2vtt`. Taken: the result is the editor's own data.

## 4. What the DM and players see and do

### 4.1 Starting it

Scenes, New scene, Kind of scene **Builder** shows, after its Create row, "Or start from a generated dungeon" and **Generate a dungeon**, as Map image offers the starter packs. On a hex Grid the button is disabled with "Generated dungeons are squares for now. Pick Squares above to make one." The form's name (placeholder "Dungeon") and Players see go into the dialog, held as the starter dialog holds them (`newSceneIntent`, `pickNow`).

### 4.2 The dialog

`Dialog` with `phone="fill"`, `width="lg"`, title **Generate a dungeon**, `backClose`:

- **The preview** (4.3), with **Reroll** under its right corner.
- **Theme**: Dungeon ("Stone and wood rooms, closed and locked doors, rubble and pits."), Crypt ("Stone halls with pillars, more locked doors.").
- **Size**: Small, Medium, Large, Custom, with "30 × 30 squares (150 by 150 ft)" under it in the room's feet per square. Custom adds Across and Down (20 to 100), starting at the form's size, clamped.
- **Rooms**: a number field, "2 to 10 on this size" under it.
- **Density**: Sparse, Normal, Dense ("How much of the map the rooms fill.").
- **Corridors**: Straight, Bending, Winding (as built, each holds its own shape at every size: see The options pass, D-261102-830). **Corridor width**: Narrow, Wide ("Wide corridors and their doorways are 2 squares across, with double doors, so Large creatures walk them without squeezing once the doors are open.").
- **Extra ways around**: a switch, on ("Adds loops, so the way back is not always the way in.").
- **Heights**: a slider of the rooms raised or sunk, never the entrance room, 0 to 75% in steps of 5, with the marks Flat (0), Few (10%), Some (25%), Many (50%) and Most (75%) under it, its value in words beside its name ("Flat", or "About 3 rooms of 12 off flat ground"), and "Rooms raised or sunk 5 or 10 ft, with stairs to them. The entrance room stays flat." (as built, D-261102-832, replacing Flat and Some).
- **Traps**: a slider in twelfths of the rooms, 0 to 6, with the marks None, Few (one per six rooms), Some (one per three) and Many (one per two), its value in words ("No traps", or "About 4 traps"), and while above None "Example traps from the SRD. Players see one only once it is found." and **Party level**: 1–4, 5–10, 11–16, 17–20 ("How strong the traps are: their save DCs, damage and pit depths follow the SRD for a party of these levels.") (as built, D-261102-832 and 834, replacing None, Few and Some).
- **Seed**: a text field holding a code such as `1K7Q-H2MX-A9F3-TWQ5`, and **Copy seed**, which copies the seed as read, in that form, whatever case or spacing was typed.
- **The foot**: the status "12 rooms, 18 doors (3 locked), 4 traps.", then **Cancel** and **Make the scene**.
- Where the form's Players see leaves fog off (Everything, or Like a scene without fog, read as `playersSeeFields(pick).fogEnabled`), a line above the foot: "Players see this scene without fog, so every room shows at once. Explore or Reveal by hand keeps rooms dark until found."

It opens on this device's last choices for the room (localStorage, in try and catch), never a seed, with a new seed (D-261102-023). Defaults: Dungeon, Medium, 12 rooms, Normal, Bending, Narrow, loops on, Heights Some (25%), Traps Few at 1–4. Rooms default to 6, 12 and 20 by size, Custom one per 200 squares, and a size change clamps Rooms.

### 4.3 The preview, Reroll and edits before anything is written

- A changed choice or seed draws a new preview after 150 ms of quiet. **Reroll** puts a new seed in the field. Only the newest answer shows (a request counter), and closing drops any late one.
- The picture is the DM view drawn by the map export's renderer from the room a scratch reducer made of the very ops Make sends (5.5), with trap zones hatched in the trap red and a ring on the entrance.
- "Drawing the dungeon…" after about 200 ms. Make is off while drawing, while the seed is invalid, and when fewer than 2 rooms fit. Drawing lasts until the new answer's own picture is on screen, not only until the worker answers, so Make never sends a dungeon other than the one shown (as built, DG-R1-01). A seed that stops reading drops a preview still drawing, so its answer never replaces the one kept.
- A picture this device cannot draw empties the box and keeps Make off: "This device could not draw the preview, so Make is off. Reroll or change a choice to try again." (as built, D-261102-600).
- Fewer fit than asked: "Fit 14 of 16 rooms. A larger size or fewer rooms fits them all." Under 2: "Could not fit two rooms. Try a larger size, fewer rooms or Sparse." A plan the scratch run refuses: "This dungeon could not be made. Reroll for another."
- A seed is read case-blind, spaces and dashes ignored, O as 0, I and L as 1. A bad one: "A seed is 16 letters and digits, like 1K7Q-H2MX-A9F3-TWQ5." (as built, the example starts with the generator's own version character, D-261102-835), and the old preview stays. Another version's: "This seed is from another version of the generator, so it makes a different dungeon now."
- Nothing is sent or enters the room's state before Make. Per-room edits wait for phase 2.

### 4.4 Make the scene

- The ops get fresh ids (5.5) and are all dispatched in one task, in one group with `groupScope: "setup"`, so no other op of this device falls inside the group and a DM who switches apps mid-send leaves nothing half queued. The foot counts the answers as they come: "Making the dungeon… 18 of 30". Cancel becomes **Hide**, Make shows busy and refuses a second tap. Every choice, Reroll and the seed are held while it sends, and after a partial or unconfirmed outcome, so nothing draws a preview the sent ops are not (Copy seed stays). Offline: "Waiting for the server…", and the queue sends on reconnect. Once a Make may have made a scene, closing the dialog starts New scene's form over, as its Create does, so a later Create makes no second scene with the typed name.
- The outcome mirrors the import's (`ImportOutcome`, D-261102-388):
  - **complete**: every op taken. The dialog closes and the scene opens. Hidden, a toast: "Made Crypt."
  - **complete, checked**: answers were lost, none refused, and the stored scene's chunks and traps match the scratch room (5.5). "The connection dropped while making Crypt, but it is complete. Undo setup in Setup history usually takes it back, and Delete in the scene's menu always does, once the players are on another scene."
  - **none**: `scene.create` refused, or no scene after lost answers. "The server refused the dungeon, so no scene was made." or "The connection dropped, and no scene was made. Try again."
  - **partial**: a refusal after `scene.create` (the room's size or memory guard, which only the server reads). "The server refused part of Crypt, so it may be missing rooms, doors or traps. Once the players are on another scene, Undo setup in Setup history or Delete in the scene's menu takes it back."
  - **unconfirmed**: answers lost and the scene not found whole within `CHECK_MS`. "The connection dropped while making Crypt, and it could not be confirmed complete. To start again, Delete it from the scene's menu once the players are on another scene."
  - Any of these adds "Open it from the Scenes panel." when the scene is not on screen. A DM who moved on is not pulled away (the import's `movedOn`).

### 4.5 After it lands

- **The camera.** On the creating device only, the scene opens framed on the entrance room grown by 4 squares (D-261102-387). Before it switches scenes, the dialog leaves a one-shot `frameOnOpen = { sceneId, rect }` in its own room scope's `fitSlot`. Stage.tsx's opening `fit` calls `takeFrame(scene.id)`, which returns the rectangle only for that scene and clears the request either way, and passes it to `fitScene` as its target, so the zoom is the one `fitScene` gives that rectangle. `openSceneCamera` calls `fit` only once the canvas has a size and the scene is new to it, so a late size still frames the entrance, another scene opening first drops the request, and "View as a player", in its own scope, never sees it. `openSceneCamera` itself is unchanged. (As built, Stage calls `openFramed`, which takes the request before it chooses between the scene's saved view and a fit, since `openSceneCamera` skips `fit` for a saved view: see As built, DG-OPUS-27.) Nothing is stored: the scene has no starting view, so every other device opens it as any Builder scene.
- It is a Builder scene like any other: every builder mode edits it, Fog reveals it, and Delete and Duplicate work from its menu.
- **Undo.** Usually one Undo setup takes it all back ("adding the scene Crypt"), and Redo setup brings it back. It splits into more steps when another device of the same DM records a step during the send, when someone else's edit on the new scene stops the merge, or after a partial result, and a server restart empties history. After play-scope builder edits the existing rule answers "Undo the play step first: …". Undo setup is refused for the players' scene, as Delete is, so a DM who moved the players there moves them to another scene first, for either. In every case the scene's Delete removes the whole dungeon once the players are on another scene, and the guide says so.
- Traps sit armed and hidden, and go off only once this is the players' scene.

### 4.6 Players

- Nothing reaches a player while the scene is not the players' scene.
- Moved there on Explore or Reveal by hand, they get only ground the party saw or the DM revealed, locked doors as closed, no unfound trap, and no starting view. On a scene without fog, the whole build, as the dialog warned.

### 4.7 Layouts

- **Phone upright** (under 600 px): the dialog fills the screen, the preview square and at most 45% of the body, Reroll under it, choices scrolling, the foot above the keyboard.
- **Phone sideways, tablet, computer**: a card. From 640 px of card width the preview takes the left half and the choices scroll on the right. A short card takes the whole height.
- **130% and 320 × 568**: one column, the preview at most 40% of the body.

## 5. The generator

### 5.1 Determinism

`generate(settings, seed)` is pure: integer arithmetic (costs doubled so none is a half), a binary heap with ties broken by insertion order, no `Math.random`, clock, trigonometry or `Math.exp`. The same seed and choices make the same plan on every device of one app version. `GENERATOR_VERSION` starts at 1, and a golden test pins 12 plans by hash, so a change that moves one bumps the version and the fixture together. Replay never reads it.

### 5.2 The seed and the stream

- 16 Crockford base32 characters in four groups: the first is `GENERATOR_VERSION`, the other 15 carry 75 bits from `crypto.getRandomValues`. Only that form is accepted.
- The stream is ChaCha20 (RFC 8439) keyed by the 75 bits, zero-padded, with the version in the nonce. Ranged draws use rejection sampling.
- The seed is never stored or sent. No id comes from the stream: ids are given at Make (5.5).

### 5.3 Steps

1. **Rooms.** Up to Rooms rectangles, sides 3 to 6 (Sparse), 4 to 9 (Normal) or 5 to 12 (Dense), at least 4 on Wide, each tried 60 times, inside a margin of 2 squares. Rock between any two rooms is at least 6, 4 or 3 squares by density on Narrow and 7, 5 or 4 on Wide, so a corridor with rock on both sides fits between any two.
2. **Entrance.** The room nearest a scene edge (ties: west, north, east, south, then room order). It stays flat and holds no trap.
3. **Links.** Prim's tree from the entrance over room middles by grid distance. With Extra ways around, about one more link per four rooms: the shortest links not in the tree whose way round the tree is at least twice as long.
4. **Doorways.** Each link end is a doorway on its room's side facing the other room: 1 square on Narrow, 2 side by side on Wide, never at a corner, a square clear of other doorways. The entrance gets one more, on its side facing its edge.
5. **Heights**, before any corridor. About a quarter of the other rooms (as built, the Heights slider's share: see The options pass, D-261102-832) take ground G of +5, +10, −5 or −10 ft. Each of their doorways reserves a straight run outward along the doorway's axis, as wide as the doorway: a near landing (the doorway's outside squares) at G, then n = |G| / 5 stair squares, the i-th at G × (n − i) / n so the last is at 0 ft, then a far landing at 0 ft. Every stair faces along the run's axis, toward the room when G is positive and away from it when G is negative, so each points up the run and links both its edges on that axis (shared/rules/walls.ts 742). The near landing is the one part of a run that may touch its own room. Any other square of the run that meets the margin, a room, a square touching a room, another run or the squares beside one leaves the room flat, rooms decided in order. A run's near landing, its stairs and the squares beside them are closed to every corridor, its own included, which starts at the far landing, so no corridor square ever meets a stair's side (D-261102-382).
6. **Corridors.** A cost search over squares, or 2 by 2 blocks on Wide. Closed: the margin (only the entrance stub crosses it), rooms, every square touching a room by an edge except a flat room's doorways' outside squares, and every reserved run with the squares beside it. A corridor to a raised or sunk room starts at its run's far landing, which other corridors may join. Rock costs 2 and a corridor square already laid 1, so corridors join. A turn costs 12, 4 or 1 for Straight, Bending or Winding, and Winding adds a seeded 0 to 6 per rock square (as built, Bending's turn costs 2 and adds a seeded 0 to 4 as well: see As built, D-261102-410. Since replaced: every style turns at 12 and takes its shape from doorway aims and waypoints, D-261102-830). A search stays in its ends' box grown by 12 squares, then takes the whole map. Order: tree links in Prim's order, loop links, then the entrance stub to the nearest map edge, ending on a stair pointing out.
7. **Walls.** All automatic. A room's only painted neighbors are across its doorways, so no op draws a wall and players' chunks hold every wall in `auto` (D-261102-022).
8. **Doors.** Every doorway edge gets a door, a Wide doorway's two the same: Dungeon 85% closed and 15% locked, Crypt 75% and 25%, the entrance's always closed. No secret doors in phase 1 (D-261102-024).
9. **Dressing.** Dungeon: wood floor in about a fifth of the rooms, 1 to 3 Rubble squares in a third of the corridors (never on a run or a doorway's outside square), a Pit of 1 or 2 squares in a few rooms. Crypt: Pillars every other square, a square in from the walls, in rooms 6 by 6 or larger (as built, 5 by 5 or larger, D-261102-836). Either theme: a room 6 by 6 or larger may get a dais 5 ft above its floor (2 by 2 to 4 by 3, a square in from the walls, off the doorway lines) with a stair on the floor square before its side facing the nearest doorway, facing the dais. Nothing stands on a doorway's inside square, a dais's stair, the floor square before that stair, the dais square at its top, or the lines from a room's doorways to its middle. A pillar may stand elsewhere on a dais, since a height keeps the terrain (shared/reducer/heights.ts 66 to 71), and pillars block movement (shared/rules/movement.ts 1012), so the square at the stair's top stays clear.
10. **Traps.** None, Few (one per six rooms, at least one) or Some (one per three), at most 12 (as built, the Traps slider's twelfths, at most 20: D-261102-832), not in the entrance room, 6 squares apart. Hidden Pit and Spiked Pit: 2 by 2 squares on a room's doorway line or in a Wide corridor, off runs and daises. Falling Net: a wire across a Narrow corridor between its walls' edge midpoints. Poisoned Needle: a locked door. Each is the preset at the chosen band, its pit floor from the scratch room's ground.

### 5.4 The budget and failures

- One budget of 400,000 search expansions for the whole dungeon, spent in step 6's order.
- A tree link whose search finds no path is first retried once with each of its raised or sunk end rooms made flat. A link with no doorway at an end, or one that meets an empty budget, is not retried, since a flat room gives it neither (as built, DG-R1-07). Flattening turns that room's runs into flat corridor squares at 0 ft, so corridors already routed to its far landings still connect. If it fails again, it drops the room it would join and every room whose tree path to the entrance runs through it, with their links and runs. A failed loop link is skipped.
- A doorway whose corridor is never built goes, with its door and run: the dropped link's end on the kept room, a skipped loop link's two ends, and a failed entrance stub's doorway, which leaves the entrance without stairs out. No door ever opens onto rock.
- The fitted count is the rooms kept, read after the drops. Under 2 is the preview error.
- `generate` takes a budget only tests pass, so each branch is tested. A fit-rate floor guards the drops: with the default choices at each size preset, every asked room fits in at least 95% of 200 seeds.

### 5.5 Plan to ops, ids and the scratch room

- `buildOps` writes, in order: `scene.create` (`builderScene` with `withPlayersSee`, no `defaultView`), `build.paint` per floor terrain for rooms and corridors together, then per overlay terrain, at most 2,000 cells each, one `build.edge` with the doors (`batchByBytes`, 500 edges and 48 KiB), `build.height` per height value, `build.stairs` per direction. `trapOps` adds one `trap.create` per trap from the scratch room's chunks. The largest choices make about 30 ops, and at most 60 (the server's burst) is tested.
- Ops carry placeholder ids (the scene's and each trap's) in the worker. At Make, `withIds` gives every id a fresh `newId`, so a second Make never resends ids and no id comes from the stream.
- The worker applies the ops in order with `applyOp` as the DM to a scratch room holding only the new scene, and after each runs the server's shared admission checks on that prefix: `checkLimits`, and `splitCheck` and `sightPiecesCheck` on `withPitsCounted`, as `#reduce` does. The size guard and the memory estimate read the live room, so they stay server only and end as **partial** (4.4).
- A parse failure, a refusal or a failed check is a generator bug: the preview's error, and Make stays off.
- **Comparing with the stored scene** (the checked outcome): chunks by cells, edges, heights and stairs, traps by zone, state and rig, with rev, `wallsVersion` and scene order left out, since each grows from its prior value.
- **Sending past local prediction.** `dispatch` never asks `satisfies`, which decides only what a device predicts. The build and trap ops read the new scene whole, which the view holds only for the scene on screen, so they wait unpredicted in the queue and go out in order. `scene.create` reads only the scene list, so it is predicted and the Scenes panel lists the scene at once. A dispatch refused while a builder gesture waits on its ask (`overtakes`) counts as refused.

## 6. Model, ops and versions

- **State:** none new. The dungeon is `scenes`, `buildChunks` and `traps` entries.
- **Ops:** six existing DM-only ops, refused for anyone else by today's rules. No field is added.
- **Undo:** as 4.5. Its restore names about 60 keys at the largest, far under `MAX_RESTORE_ENTRIES`.
- **Versions and replay:** the generator takes no OP_VERSION or SNAPSHOT_VERSION step. Stored ops hold every cell, edge, height and trap, so replay never runs the generator. An older build reads these rooms unchanged.
- **Room export and import, Duplicate, Export as image:** unchanged.

## 7. Privacy

| What | Who gets it | Why it is safe |
|---|---|---|
| Choices, seed, preview, scratch room | The DM's device | Never sent. The seed lives only in the open dialog. The device keeps the choices, never the seed |
| The camera framed on the entrance | The creating device | Local and one-shot. No starting view is stored, so players learn no generated spot (D-261102-387) |
| The ops | The server, DM devices on the scene | Players receive projections, never ops |
| The scene before players go there | DM devices | Players receive only the players' scene |
| Unseen rooms, doors, heights | DM devices | Map discovery |
| Walls | Players, where seen or remembered | All automatic, sent in `auto` like any automatic wall, so no drawn edge marks a room's side (D-261102-022) |
| Doors | Players, once seen | Locked reads closed. No secret doors in phase 1 (D-261102-024) |
| Traps | A player only once found | The existing trap projection |
| Scene name and bounds | Players on the scene | The DM's name, never the seed. Bounds are the chosen size, not cropped to the rooms |
| Op ids | As today | Fresh `newId` at Make |

- **Rebuilding from a seed:** a player never holds one. Guessing is 2^75 tries, and the cipher stream means rooms seen do not narrow it. Typed seeds need the full form.
- **Accepted channel:** a player counting `seq` sees a burst of batches, as with any import (D-261026-14). It says nothing of the dungeon.

## 8. Performance and caps

- **Caps:** sides 20 to 100 (presets 30, 50, 80). Rooms 2 up to one per 90 squares, at most 40. Traps at most 12 (as built, 20, D-261102-832). Door edges at most 200: the largest Wide topology, 39 tree links and 10 loop links at 4 edges each plus the entrance's 2, makes 198, and one `build.edge` holds 500 (about 18 KB for 200). Loop links stop before the cap. Ops at most 60. Search expansions at most 400,000.
- **Sight pieces:** the largest choice sets (100 × 100, 40 rooms, Dense and Sparse, Winding, Wide and Narrow, Heights Some, Traps Some, as built Heights Most and Traps Many, D-261102-832) over 20 seeds, with vision on and pits counted, must stay at or under 80% of `sightPiecesPerScene` (4,800 of 6,000). `splitCheck` passes without free walls (walls.ts 1553) and is still run. Past the margin the lane lowers Custom's largest side, then Rooms' cap, and records it in As built.
- **Main thread:** Make dispatches every op in one task. The ops are not predicted (5.5), so each `derive` skips `applyOp` for them. With Chrome's 4× CPU slowdown the largest choices must keep that task under 100 ms and all of Make's main-thread work under 300 ms, measured on the real path (`dispatch`, `derive`, the answers). The build also measures a DM who hides the dialog and opens the new scene while ops are pending, when they become predicted and each `derive` applies them. If a task there passes 100 ms, Hide shows only while the send waits offline, so online the dialog stays until every answer is in, and the lane records it in As built. The generator and the scratch reducer never run on the main thread.
- **The worker:** loaded when the dialog opens. The build reports its built gzip size (target 400 KB), the cold first preview (target 2 s at 4×), a warm preview of the largest choices (target 1 s at 4×) and peak memory (target 150 MB). Over a target, the answer is open, for instance a chunk writer in place of the reducer with a parity test.
- **Server:** at most 60 bounded ops fit the burst, so a send waits only if the DM's recent edits spent part of it (`retry busy` with the store's backoff). Fan-out goes to DM devices on the new scene only. The largest dungeon adds about 200 KB to the room's state.

## 9. Files

All new code is client code. Nothing changes on the server or in shared/. Reused: scenes/create.ts (`builderScene`, `withPlayersSee`, `playersSeeFields`, `newSceneIntent`, `pickNow`), uvtt/batch.ts (`batchByBytes`), uvtt/rules.ts (`sceneShown`, `CHECK_MS`, the outcome's shape), the uvtt worker pattern, mapexport/render.ts and content.ts with scenes/thumbnail.ts's encoder, shared/srd/traps.ts and traps/rules.ts (`newTrapInput`, or a mirror with a parity test if its imports are not worker-safe), shared/reducer.ts, shared/initial.ts, shared/protocol.ts, the shared admission checks, and the components (Dialog, Segmented, Switch, Field, Button, IconButton, Loading).

- `client/features/dungeon/random.ts`, `seed.ts`, `settings.ts`, `layout.ts` (rooms, entrance, links, doorways), `heights.ts` (rooms' ground, runs, daises), `corridors.ts` (the search and budget), `dress.ts` (doors, dressing), `trapSpots.ts`, `plan.ts` (`generate`, the drops).
- `ops.ts` (`buildOps`, `trapOps`, `withIds`), `scratch.ts` (the scratch room and admission checks), `worker.ts`, `client.ts` (`preview`), `send.ts` (`sendDungeon`, the outcome and the check).
- `GenerateDialog.tsx`, `Preview.tsx`, `words.ts`, `remembered.ts`.
- `client/features/scenes/NewScene.tsx` (the line and the button), `client/canvas/fitSlot.ts` (`frameOnOpen` and `takeFrame`), `client/canvas/Stage.tsx` (the opening `fit` takes the frame as `fitScene`'s target). `client/canvas/sceneCamera.ts` is unchanged.

## 10. Shared contract (the first commit, which every lane built on)

```ts
// settings.ts (DG-A)
export const GENERATOR_VERSION = 1
export type DungeonSettings = {
  w: number, h: number, rooms: number, density: "sparse" | "normal" | "dense",
  corridors: "straight" | "bending" | "winding", wide: boolean, loops: boolean,
  theme: "dungeon" | "crypt", heights: "flat" | "some", traps: "none" | "few" | "some", band: LevelBand,
}
// seed.ts (DG-A)
export type Seed = string                               // 16 characters, normalized, the first the version
export function newSeed(): Seed
export function parseSeed(text: string): { ok: true, seed: Seed, otherVersion: boolean } | { ok: false }
// plan.ts (DG-A)
export type PlanRoom = { x: number, y: number, w: number, h: number, ground: number, floor: TerrainId, entrance?: true }
export type DungeonPlan = {
  version: number, w: number, h: number, asked: number, rooms: PlanRoom[],
  paint: Partial<Record<TerrainId, string[]>>,          // every painted cell by terrain, "x,y"
  doors: { edge: string, state: "closed" | "locked" }[],
  heights: { ft: number, cells: string[] }[],            // merged by value, 0 left out
  stairs: { up: StairDirection, cells: string[] }[],
  traps: { preset: string, zone: TrapZone }[],
  entrance: { x: number, y: number, w: number, h: number },
}
export function generate(settings: DungeonSettings, seed: Seed, budget?: number): DungeonPlan
// ops.ts, client.ts, send.ts (DG-B, which owns Summary, Preview and DungeonOutcome)
export function buildOps(plan: DungeonPlan, scene: SceneInput): ClientOp[]
export function trapOps(plan: DungeonPlan, chunks: Readonly<Record<string, BuildChunk>>, band: LevelBand, sceneId: string): ClientOp[]
export function withIds(ops: ClientOp[], newId: () => string): { ops: ClientOp[], sceneId: string }
export type Summary = { rooms: number, asked: number, doors: number, locked: number, traps: number }
export type Preview = { ok: true, plan: DungeonPlan, ops: ClientOp[], room: RoomState, summary: Summary } | { ok: false, error: "fit" | "bug" }
export function preview(settings: DungeonSettings, seed: Seed, scene: SceneInput): Promise<Preview>
export type DungeonOutcome = { k: "complete", checked: boolean } | { k: "none", lost: boolean } | { k: "partial" } | { k: "unconfirmed" }
export function sendDungeon(made: { ops: ClientOp[], sceneId: string, room: RoomState }, actions: RoomActions, onAnswered: (n: number, of: number) => void): Promise<DungeonOutcome>
// as built: a fourth argument, { store, shown }, to compare and open the scene (D-261102-418)
```

The server test imports no client module: DG-B's `ops.fixture.test.ts` writes `server/rooms/dungeon.fixture.json` (the ops of two fixed seeds, Medium default and the largest choices, placeholder ids) under `UPDATE_FIXTURES=1`, and fails on every other run when the fixture differs from today's output.

## 11. Keyboard, touch, accessibility and assets

- **Keys and gestures:** none new. Tab, Enter on buttons, Escape and Android's Back close. The preview takes no gestures. The shortcut sheet and FEATURES.md's Shortcuts gain no row.
- **Focus:** opens on Theme, Reroll keeps focus, focus returns to Generate a dungeon on close, busy Make keeps it.
- **Screen readers:** the preview is an `img` named by its summary ("Preview of the dungeon: 12 rooms, entrance on the west side."), a polite live region speaks the status once per preview, the overlay is `aria-hidden`.
- **Contrast and motion:** trap hatch in the trap red with a 1 px outline, a white entrance ring over a dark outline, both 3:1 against floor and rock. No animation.
- **Assets:** none new. CREDITS.md and shared/credits.ts are unchanged.

## 12. UI checklist

- **Loading:** "Drawing the dungeon…" after about 200 ms, "Making the dungeon… N of M" and "Waiting for the server…". Every path ends in the scene or one of 4.4's sentences.
- **Keys, focus, screen readers:** 11. **Large sizes:** 4.7. The alignment sweep at 1440 × 900, 390 × 844 and 320 × 568, 100% and 130%, gains the dialog as a root in e2e/alignmentRoom.ts, and scenesetup.e2e.ts's New scene sweep gains the Builder kind with the line and button, on squares and on hexes with the note.
- **Exact words:** those quoted in 4.1 to 4.4, nothing else.

## 13. Cases

| Case | Expected | Test |
|---|---|---|
| Same seed and choices twice, and the fixed set | Same plan, golden hashes match | plan.prop.test.ts, plan.golden.test.ts |
| Reroll, a pasted or odd-cased seed, a bad one, another version's | New seed and preview, read the same, error and old preview, the note | seed.test.ts, dungeon.e2e.ts |
| More rooms than fit, under 2 fit | "Fit 14 of 16 rooms.", the error and Make off | plan.prop.test.ts, words.test.ts |
| A tree link fails or the budget runs out | Retried with its raised end rooms flat, then its room and the rooms past it dropped, the count read after | plan.prop.test.ts (small budget) |
| A loop link or the entrance stub fails | Its doorways, doors and runs go, no door onto rock | plan.prop.test.ts |
| Default choices at each size preset | Every asked room fits in at least 95% of 200 seeds | plan.prop.test.ts |
| Hex Grid in the form | Button off with its line | dungeon.e2e.ts |
| Any plan | In bounds, gaps kept, doorways on sides, no painted square touching a room but a doorway's outside square | plan.prop.test.ts |
| Any plan's ops | Parse, bytes, at most 60, only door edges, heights merged, scene first and traps last, no seed | ops.test.ts |
| Every prefix through the scratch room | No refusal, admission checks pass | landed.prop.test.ts |
| Largest choices | Sight pieces at most 4,800 with pits counted | caps.test.ts |
| Walking from the entrance | Every room reached, Medium on Narrow and Large on Wide unsqueezed, every door opened | landed.prop.test.ts |
| Corridor edges | No ledge on any edge between two corridor squares | landed.prop.test.ts |
| Reveal room in any room, the entrance included | Exactly that room | landed.prop.test.ts |
| G of +5, +10, −5 and −10 on Narrow and Wide | The room keeps its height, its near landing touching only its own room | heights.test.ts fixtures |
| Each height, run facing north, east, south and west | Every stair faces along the axis, toward the room for +G and away for −G, both axis edges linked | heights.test.ts, landed.prop.test.ts |
| A dais | Its stair, the floor square before it and the dais square at its top clear, and the dais walked onto | landed.prop.test.ts |
| Largest Wide topology | 198 door edges, under 200, in one `build.edge` | ops.test.ts |
| Traps | On floor, off runs, daises and the entrance room, 6 apart, at most 12, the band | plan.prop.test.ts |
| Make the scene | Every op dispatched in one task, one group, scene opens framed on the entrance, nothing stored as a view | dungeon.e2e.ts |
| The canvas sized late, another scene opening first, View as a player open | Framed once size comes, the request dropped, the player view untouched | fitSlot.test.ts, sceneCamera.test.ts |
| The DM opens the new scene while ops are pending | Measured, Hide held online if a task passes 100 ms | dungeon.e2e.ts |
| Undo setup, then Redo setup | Gone in one step, then back | dungeon.itest.ts |
| Another device of the same DM records a step mid-send | Two Setup steps, Delete removes all | dungeon.itest.ts |
| A co-DM edits the new scene mid-send | The merge may split, Delete removes all | dungeon.itest.ts |
| Server restart after the send | History empty, Delete removes all | dungeon.itest.ts |
| A refusal partway | partial, its sentence, Undo setup takes back what landed | dungeon.itest.ts, send.test.ts |
| Lost answers, lost refusal, expiry, hidden dialog on reconnect | checked or unconfirmed by the stored scene, the toast when hidden | send.test.ts |
| `scene.create` refused, or a builder ask holds the queue | none, or the held op counted as refused | send.test.ts |
| A co-DM moves players to the scene mid-send | Lands, or a memory refusal ends as partial. Delete is refused until the players are moved elsewhere, then removes all | dungeon.itest.ts |
| Players on another scene | Nothing of the new scene | dungeon.itest.ts |
| Players moved there before any ground is revealed | The scene with no `defaultView`, no chunk, no trap | dungeon.itest.ts |
| Players on Explore later | No unseen room, locked doors closed, no unfound trap | dungeon.itest.ts |
| Fog left off by the form's choice (Everything, Like) | The warning line | words.test.ts, dungeon.e2e.ts |
| Quick choice changes, dialog closed while drawing | Newest preview only, nothing sent | client.test.ts, dungeon.e2e.ts |
| An answer in while its picture draws, a newer answer mid-drawing, a picture that fails | Make off and drawing until that answer's picture shows, the error and Make off on a failure | flow.test.ts, dungeon.e2e.ts |
| A seed made invalid while a preview draws | Its answer dropped, the kept preview stays | flow.test.ts |
| Make sending offline, or ended partial or unconfirmed | Every choice held, Across, Down and Rooms included, Copy seed on, the form starts over once hidden | dungeon.e2e.ts |
| Backup round trip, Duplicate, Export as image | As any Builder scene | dungeon.itest.ts, existing tests |
| Admission parity | The largest fixture all taken through the actor | dungeon.itest.ts |
| The dialog and the form at every size | Within 1 px | alignment, alignment-wide, scenesetup |

## 14. Tests by file

- **Unit:** `random.test.ts` (RFC 8439 2.3.2 vector, buffer edges, ranges), `seed.test.ts`, `settings.test.ts`, `ops.test.ts`, `ops.fixture.test.ts`, `words.test.ts`, `send.test.ts`, `client.test.ts`, `heights.test.ts` (the eight height and width fixtures, every facing), `client/canvas/fitSlot.test.ts` (`takeFrame` returns the rectangle once for its scene, drops it for another, and two room scopes keep their own), `client/canvas/sceneCamera.test.ts` (with a `fit` that takes the frame: a null size first and then a size frames the entrance once, and a scene opened first drops it).
- **Property (fast-check):** `plan.prop.test.ts` (plan invariants and every drop branch), `landed.prop.test.ts` (scratch prefixes with admission checks, walks with the drag's route rules in shared/rules/route.ts, `floodRoom`, no corridor ledge), `caps.test.ts`.
- **Golden:** `plan.golden.test.ts` with its fixture, whose version must equal `GENERATOR_VERSION`.
- **Integration:** `server/rooms/dungeon.itest.ts`, from the JSON fixture only: storing and replay, the undo cases, partial, players' projections, the co-DM moving players, backup, admission parity.
- **E2E:** `e2e/dungeon.e2e.ts` (prefix `DG`): the hex note, a fixed seed's status line, Reroll, Make, the framed entrance, a door tapped in the builder, Setup history's undo, a player on Explore. The build also measures Make's main-thread time there under 4× slowdown, the one dispatch task and a DM who hides the dialog and opens the scene mid-send included. Run with `reach`, `alignment`, `alignment-wide` and `scenesetup`.

## 15. Lane plan and later phases

Phase 1, one batch, after the easy Later items. DG-A's first commit is the contract (section 10's types and stubs for settings.ts, seed.ts and plan.ts, and DG-B's for ops.ts, client.ts and send.ts), and every lane branches from it.

| Lane | Owns | Size |
|---|---|---|
| DG-A generator | random, seed, settings, layout, heights, corridors, dress, trapSpots, plan, their tests and golden fixture | L |
| DG-B landing | ops, scratch, worker, client, send, their tests, landed.prop, caps, ops.fixture and server/rooms/dungeon.fixture.json, server/rooms/dungeon.itest.ts | M |
| DG-C dialog | GenerateDialog, Preview, words, remembered, scenes/NewScene.tsx, canvas/fitSlot.ts and its test, canvas/Stage.tsx, canvas/sceneCamera.test.ts, e2e/dungeon.e2e.ts, e2e/scenesetup.e2e.ts's sweep, e2e/alignmentRoom.ts | M |
| DG-D docs | FEATURES.md (Scenes and maps, Building maps, What stays square), docs/dm-guide.md ("Generating a dungeon", with Delete as the sure way back once the players are on another scene, and a screenshot), the design note, mvp.md, ROADMAP.md | S |

**Phase 2 (M to L, no versions).** Cave, Mine and Sewer themes, lights with the scene starting Dark and Keep it lit, dressing from shipped stamps and starter props, a DM key (a DM-only journal page with numbered rooms, a trinket each, the choices, and DM-only numbered pins, via `journal.create` and `pin.put` in the same group), Collapsing Roof and Poisoned Darts with their hit squares, Fire-Casting Statue with its cone, Rolling Stone (it shows a hidden stone token the generator would place, rolls 60 ft a turn on its own Initiative down a straight run, and is rated only for levels 11 to 20), dead ends, per-room preview edits, and Look closer. Secret doors and secret rooms come only after SECRET-DOOR-DRAWN-EDGE makes an undiscovered secret door between painted cells project like an automatic wall, remembered walls included, proven by a paired projection test against solid rock.

**Phase 3 (L, its own design pass, no versions).** Hexes as wall-line dungeons (free walls on hex sides, so `splitCheck` binds and the cap needs its own count), and Add a wing into an empty part of an existing scene through `build.ask`.

## 16. Decisions

- **D-261102-370** It runs on the DM's device in a worker, with its bundle, cold preview and memory measured. Rejected: a server op that generates (CPU on the room's thread, a frozen generator), the main thread.
- **D-261102-371** At most 60 existing ops in one Setup group: floors by `build.paint` per terrain, heights merged by value, edges only for doors, all dispatched in one task with progress from the answers. Rejected: a `build.rect` per room and drawn walls (up to 150 ops, past the burst, a main-thread stall), 10 ops a frame (stalls in a background tab, and another op of the device can fall inside the group), one new op holding the result (an op version, past the 64 KiB frame), one op with seed and choices (a frozen generator).
- **D-261102-372** The stored ops hold the result, and the generator may change. Rejected: freezing it per version.
- **D-261102-373** No version step in any phase. Rejected: a DM-only `scene.generated` record (versions for a convenience, and a stored seed).
- **D-261102-374** Seeds are 16 Crockford characters, a version and 75 random bits, in that form only. Rejected: free text, short numbers (guessable against the public generator).
- **D-261102-375** The stream is ChaCha20. Rejected: xorshift, mulberry or sfc (state a player could solve from the layout), Web Crypto (async).
- **D-261102-376** The seed lives only in the open dialog, the device keeps choices only (D-261102-023), and ids are fresh at Make. Rejected: a remembered last seed, ids drawn in the worker and reused by a second Make.
- **D-261102-377** It starts from New scene's Builder form and makes a new scene. Rejected: a fourth Kind, a builder mode on the scene in view (phase 3).
- **D-261102-378** The preview is the shared reducer's result of the ops Make sends, with the server's shared admission checks on every prefix. Rejected: a separate drawer (two paths), skipping the checks (a plan the server refuses partway).
- **D-261102-379** Edits wait until it lands. Undo is usually one Setup step, and Delete is the sure way back once the players are on another scene, since it is refused for theirs. Rejected: promising one step (another device, a restart or a partial result splits it), an automatic rollback.
- **D-261102-380** Rooms keep rock round them, and corridors keep a square from rooms except at doorways, so every wall is automatic (D-261102-022). A failed tree link is retried with its raised end rooms flat, then drops its room's whole branch, under one global budget, and a doorway with no corridor goes with its door and run. Rejected: drawn walls where corridors touch rooms (players' `edges` would mark a hidden room's side), dropping one room alone (it strands the rooms past it).
- **D-261102-381** Every doorway gets a closed or locked door, Wide ones double, and no secret doors in phase 1 (D-261102-024). Rejected: open arches (Reveal room merges), single doors on Wide corridors (Large creatures squeeze).
- **D-261102-382** Heights come with stair runs reserved before corridors, their near landing the only part touching the room, the run and its sides closed to every corridor, each stair's ground set and its facing taken from the axis and the sign of G. A dais keeps its stair, the square before it and the square at its top clear. Rejected: facing toward a higher neighbor (a sunk run's top stair has none), runs carved after corridors (a junction meets a stair's side as a ledge), the Auto rule.
- **D-261102-383** Phase 1 places Hidden Pit, Spiked Pit, Falling Net and Poisoned Needle, and Traps starts on Few. Rejected: the others now (hit squares, a cone, or Rolling Stone's stone token and levels 11 and up), Some by default.
- **D-261102-384** Sides 20 to 100, uncropped bounds, door edges at most 200, and sight pieces under 80% of the cap at the largest choices. Rejected: up to 200, cropping (players learn the rooms' reach), no measured margin.
- **D-261102-385** Squares only until phase 3. Rejected: never on hexes, hexes in phase 1.
- **D-261102-386** Phase 1 themes are Dungeon and Crypt. Rejected: every theme at once.
- **D-261102-387** The entrance is the room nearest an edge, with a stub through its own door to stairs at the edge, and only the creating device's camera frames it, through a scoped one-shot request that Stage.tsx's opening fit takes as `fitScene`'s target, with no stored view. Rejected: a stored starting view from the layout (it tells players where the entrance is through the fog), no entrance.
- **D-261102-388** The outcome mirrors the import's: complete, checked, none, partial, unconfirmed, with the stored scene compared to the scratch room. Rejected: counting answers alone (a lost answer reads as success).
- **D-261102-389** A contract commit, then four lanes, and a JSON op fixture between client and server tests. Rejected: one lane, an itest importing client modules (no DOM types on the server).

## 17. For the reviewers: look hardest at

1. D-261102-371 and 8: 60 ops in one task, sent unpredicted, and the DM opening the scene mid-send. Do the 100 ms and 300 ms targets hold at 4×?
2. D-261102-380 and 382: the halo, the runs, the flat retry and the 95% fit floor. Do Dense Wide dungeons with heights reach it?
3. D-261102-387: the frame request taken as Stage opens a scene, with `openSceneCamera` unchanged (as built, `openFramed` takes it before the saved view or a fit is chosen, DG-OPUS-27).
4. D-261102-378: the worker's size with the reducer, zod and the checks.
5. D-261102-384: whether sight pieces leave the margin at 100 × 100 Winding Wide.

## As built

Phase 1 is built: the generator, its landing, the dialog and the camera frame. It takes no version step, adds no op and no stored field, and changes nothing in `shared/` or on the server. Section 10's contract was written first, as planned, and the three code lanes (the generator, the landing, the dialog) each built on it. The build's own guesses are D-261102-410 to D-261102-427. Each is listed here with the option it rejected.

### The generator (`client/features/dungeon/`, section 5)

- **Bending corridors (D-261102-410).** A turn costs 2 and each rock square a seeded 0 to 4 more, beside Straight's 12 with no extra and Winding's 1 with 0 to 6. The design's turn cost of 4 with no extra drew exactly the corridors Straight did, 1.37 turns each, because a search with no noise takes the fewest turns whatever a turn costs. Over 40 Large dungeons, corridors of 15 squares or more now bend 1.6, 2.6 and 4.1 times for Straight, Bending and Winding. Rejected: Winding's numbers for Bending, which leave no middle style.
- **Room placement (D-261102-411).** Each of a room's 60 tries draws a size and then a spot from every spot that size fits, and a layout that leaves rooms out is drawn again from the start, up to 12 times, keeping the first that fits them all, else the one that fit most. Blind spot tries fitted all six of Small's rooms in only 40% of seeds. Rejected: packing rooms against the edges and each other, which makes every dungeon hug its corners.
- **Doorways (D-261102-412).** The entrance's doorway is placed first, in the middle of its side, so the way in always has its side. A link's doorway aims at the other room's middle, on the side across the larger gap and then the other axis's side, and needs open rock outside it: its outside square inside the margin, and the next row out, two rows on Wide, off rooms and the squares touching them. Otherwise the link has no doorway and fails as 5.4 says.
- **Where a run fits (D-261102-413).** Beyond step 5's rule, a run keeps off every other doorway's outside square and the row out from it, and the squares beside a run hold no other run's square. Two runs at right angles could meet end on, so a stair's side met the other run's far landing as a ledge, and a run across a doorway's way out stranded that doorway.
- **Crypt pillars (D-261102-414).** Every other square of a ring one square in from the walls. A grid across the room would have cost about four times the sight pieces and left no 2-square way across for a Large creature on Wide.
- **Smaller readings (D-261102-415).** The entrance's always-closed door is its stub's door, and its other doors draw as any. Traps stand 6 squares apart between their zones' middles, a kind drawn evenly among those with a spot left and then a spot. A pit trap keeps off a doorway's inside square. Rubble keeps off flattened runs too. The stream's nonce holds the generator's version, not the seed's first character. A doorway line runs straight in to the room middle's row or column and then along it, as wide as the doorway.
- **Contract extras.** `settings.ts` also exports the caps, `DEFAULT_SETTINGS`, `SIZE_SIDES`, `roomCap`, `clampRooms`, `defaultRooms` and `clampSettings`, and `seed.ts` adds `formatSeed`, `versionChar` and `seedKey`, since the dialog and the device's remembered choices need them.
- **No trap mirror.** `traps/rules.ts` and `shared/srd/traps.ts` import only modules that are safe in a worker, so section 9's mirror with a parity test was not needed. A pit's size is read from `trapPreset`.
- **The flat retry (DG-R1-07, D-261102-604).** `routeLink` says why a link failed: no path, an empty budget or no doorway. Only no path is retried flat. The fix moved none of the twelve golden plans and none of 4,000 random plans with Heights on Some against the code before it, so `GENERATOR_VERSION` stays 1. Rejected: bumping it, which would call every seed so far another version's for a change no plan showed.
- **The golden fixture (DG-R1-04).** `UPDATE_FIXTURES=1` refuses to rewrite when a plan pinned under the same name, settings and seed changed hash at the same version, so a rewrite cannot stand in for the bump. New cases and a bumped version are written.
- **Raised rooms.** With Heights on Some, about 8%, 14% and 20% of kept rooms are raised or sunk at Small, Medium and Large, a quarter chosen, less the runs that do not fit (since the options pass, 20%, 27% and 26% of the rooms but the entrance, D-261102-832).

### The options pass (lane dgopts, 2026-11-03)

The owner found that Straight, Bending and Winding drew much the same corridors on small maps, and asked for a pass over every option, then for sliders for Heights and Traps and a clearer Party level. Every option was measured per Size over fixed seeds and drawn side by side before and after. Decisions D-261102-830 to 839.

- **Why the styles met (D-261102-830).** A cheapest way is always a shortest way, so turn costs and per-square noise only reordered the turns of a shortest path, and between doorways aimed at each other's middles that is one straight line. Small packs 6 rooms 4 squares apart, so 73% of its corridors crossed 3 to 5 squares of rock, of which the halo leaves 2 open. Same corridor for the same seed: 60 to 72% at Small, 43 to 52% at Large. Detour: 1.00 at Small for every style.
- **What shapes them now (D-261102-830).** Every style turns at 12. Straight aims doorways at the other room's middle, as before, and goes direct. Bending aims each doorway at a spot drawn along its side, so a short crossing takes a Z, and bends a longer corridor through one waypoint (two from 18 squares) set 2 to 5 squares off the line. Winding aims as Bending, threads a waypoint about every 3 squares on alternating sides, and where the rock between two rooms is under 8 squares (10 on Wide) moves both doorways to the rooms' other sides, so the corridor winds round a room. Each leg is its own search and closes its squares and the squares beside them to the later legs, so a corridor never crosses itself or runs alongside itself as a wide patch. A waypoint on a closed square moves to an open one within 2, one no leg reaches is passed over, and a goal no leg reaches from the last waypoint is tried from the one before. A rock square beside another corridor costs 3 more, so corridors join or keep a square apart. The doorway aims and waypoints draw from their own stream (the nonce's second word), so the rooms stay where they are when Corridors changes, and Heights draws its order for every value. Which rooms are raised and the dressing can still change with Corridors, since the doorways decide which runs fit and where the daises go (review DGOPTS-O2 and DGOPTS-ASTRA-01, which found the raised rooms differ between styles in 20 of 40 Small dungeons at the defaults). Accepted, and the docs promise only the rooms. Rejected: a wider gap between rooms for Winding (rooms then move with the style, and only 19% of Small Normal maps fit 6 rooms at a gap of 6), spreading rooms for every style (Small has no rock to spare), stronger noise (it never leaves a shortest way).
- **No room lost to a style (D-261102-831).** A styled tree or loop link that finds no way is tried once more from plain doorways, after the flat retry. Winding's move round a room is a second pass over placed doorways and keeps them where they were when the move does not fit. Straight's links take the same retry (review DGOPTS-O1): a flat retry leaves the corridor starting from the flattened run's far landing, and fresh doorways often find the way it cannot. Without it, the review found, Straight kept every room in only 25 of 40 Large Wide Dense dungeons at Most. At version 5 every style keeps every room at Large and 100 by 100, Wide Dense, at every Heights mark. Rejected: dropping the branch (Winding Wide kept every room in only 61 to 85% of plans), one pass (moved doorways took the sides other links needed). Fit rates match across the styles within a point in every size, width and density.
- **Heights and Traps sliders (D-261102-832).** The coordinator's decisions, logged in this range: Heights is the share of rooms off flat ground, 0 to 75% in steps of 5, marks Flat 0, Few 10, Some 25, Many 50, Most 75. The generator raises its share of the rooms but the entrance, rounded, and at least one for any share, trying rooms in a drawn order and each room's grounds in a drawn order, so a room whose 10 ft run does not fit may still take 5 ft. Traps is in twelfths so Few (one per six) and Some (one per three) are steps, with Many one per two, at most 20 traps (20 extra `trap.create` ops at most stay far under the burst, and the sight cap holds: 2,332 of 4,800 at the largest choices at version 5). A device's remembered "flat" and "some", and "none", "few" and "some", read as the marks that replaced them. Rejected: Traps in 5% steps (Few and Some fall between them), the old chance of a quarter per room (Small had no raised room in half its dungeons).
- **The slider (D-261102-833).** `PresetSlider.tsx`: the app's range input (arrows step, Home and End), its value in words beside its name and as `aria-valuetext`, the marks as buttons with `aria-pressed` under it, Page Up and Page Down to the next mark, native ticks at the marks. Where the marks do not fit at 44 px each (Heights' five on a 320 px phone at 130%) they share two rows evenly. Rejected: the shared `Slider` (one row, the value as a number), the marks as a radio group (two controls for one value, and none chosen between marks).
- **Party level (D-261102-834)** keeps its name, the Trap tool's, and gains its help line. Rejected: renaming it.
- **The sliders' keys (D-261102-839).** Page Up and Page Down join the shortcut sheet's Dialogs section for the DM, beside Escape and Tab. Rejected: leaving them off, as a native control's keys (the sheet lists other controls' own keys, such as the side panel tabs').
- **Versions (D-261102-835).** Each commit that moved plans stepped `GENERATOR_VERSION`: 2 for the corridors, 3 for the sliders, 4 for the pillars, 5 for Straight's retry. Test, e2e and example seeds read the version, so a step needs no new seeds. Rejected: one step for the lane (a commit between would move plans under a version).
- **Crypt pillars (D-261102-836)** stand in rooms from 5 by 5, a 5 by 5 room's ring holding one at each corner, so Sparse Crypts show pillars in 18 to 25% of rooms rather than 2 to 6%.
- **Not built (D-261102-837).** Rooms' cap promises more than fits at the top: Medium's 27 fit whole in 65% of plans, and Small Wide Sparse fits its default 6 in 2%. A cap by Density and Width would fix it, but it changes what Rooms offers, so it is a recommendation.
- **Wide at Small (D-261102-838).** Two-square corridors with their walls need twice the rock to wind, so on Wide at Small Winding leads Bending in about 2 dungeons in 3. Accepted, and the property says so.
- **Sampled bounds.** Every version step draws the property tests' samples afresh. Stepping to 5 broke two bounds set on the edge of one sample, and runs at 18 other versions broke five more, so each bound on a 30-dungeon sample now sits clear of the worst of 40 such samples. A style keeps Straight's rooms within one in a hundred, since Straight now takes the retry too.

Measured over 24 seeds a cell, the defaults otherwise: turns per corridor, then squares walked over the shortest way's, both averaged over corridors. Straight's second number above 1 is a few corridors forced the long way round a room, 7 of 335 at Medium and 13 of 576 at Large, such as 46 squares between rooms 2 apart. The before and after rows are different dungeons, since each version draws its own, and the after rows are version 5's.

| Size | Straight | Bending | Winding |
| --- | --- | --- | --- |
| Small before | 1.06, 1.00 | 1.08, 1.00 | 1.17, 1.00 |
| Small after | 1.03, 1.00 | 2.13, 1.36 | 3.78, 1.45 |
| Medium before | 1.29, 1.14 | 1.35, 1.14 | 1.56, 1.14 |
| Medium after | 1.27, 1.32 | 2.45, 1.38 | 4.69, 1.84 |
| Large before | 1.36, 1.08 | 1.56, 1.08 | 1.98, 1.09 |
| Large after | 1.35, 1.23 | 2.94, 1.29 | 5.95, 1.95 |

`corridors.prop.test.ts` holds each style's character and their order for the same seed at every Size, Narrow and Wide, the rooms unchanged by the style and the locks wherever the doorways match, the plain retry, and Straight keeping every room at Large Wide Dense. `options.prop.test.ts` holds Heights and Traps to their sliders (never more, and on average at least 90% of the share at Medium and Large and 60% at Small, where a quarter of the rooms have no room for their stairs) and the Crypt's pillars at every Density. The dungeon e2e drives the sliders' keys and marks and sweeps them at 1440 by 900, 390 by 844 and 320 by 568 at 130%, dark and light.

### The landing (section 5.5 and 4.4)

- **`sendDungeon` takes a fourth argument, `{ store, shown }` (D-261102-418).** The contract's three could not see the scene or open it to compare it with the scratch room. It also opens the scene once it is complete, as the import's finish does, unless a hidden dialog's DM has moved on. Rejected: an optional fourth argument, which a caller could leave out and silently skip the check.
- **The sight cap in the preview (D-261102-419).** The scratch run checks the cap as if vision were on, because Players see is set only at Make and Explore turns vision on. Without it an Explore Make could be refused partway by the server.
- **A refused `scene.create` (D-261102-420).** When `dispatch` refuses it at input, nothing after it is sent and the outcome is none. Rejected: sending the rest, as the import does, which would draw a refusal toast for each op of a scene that never existed.
- **Overtaken previews (D-261102-417).** The client draws one preview at a time. A request waiting behind it is replaced by any newer one, and an overtaken or closed request never settles, so only the newest answers. A worker that dies answers the newest request it was drawing as the bug error. `warmPreviews` and `closePreviews` load and end the worker with the dialog, as section 8 says it loads on open.
- **The foot's door count (D-261102-416).** `Summary.doors` counts doorways, so a Wide doorway's two door edges are one double door, and `locked` counts locked doorways. Counting edges would make a Wide dungeon of 12 rooms read "58 doors".
- **The fixture (D-261102-421).** `server/rooms/dungeon.fixture.json` holds Medium on the defaults and the largest choices (100 by 100, 40 rooms, Dense, Winding, Wide, loops, Heights Some, Traps Some, as built Heights Most and Traps Many since D-261102-832, Dungeon), with their seeds, settings, room rectangles and entrance beside the ops, so the integration test can reveal one room and stand a party in the entrance.
- **Large creatures unsqueezed.** `walkSqueezes` in `shared/rules/route.ts` no longer reads geometry on squares, so it cannot tell. The test proves a Large creature fits by a whole-square walk with its full footprint through the movement rules' `legStop`, and the drag's `findRoute` must reach the same spot. Walks start over a doorway's inside square, because a corner of a Crypt entrance can be boxed in by its pillar ring.
- **A worker the page cannot start (DG-R1-08).** A throw from starting the worker or posting to it answers the request as the bug error and clears the drawing slot, so the next preview tries a fresh worker, and `warmPreviews` never throws in the dialog's open.
- **`handPlans.ts`** holds the hand-written plans the landing tests use. It is not a test file.

### The dialog and the camera (sections 4.2 to 4.7 and 11)

- **Reroll's place (D-261102-422).** Reroll stands over the preview in its bottom right corner, not under it. On a wide card the preview's column is placed apart at the left (absolute, with the preview sticky inside it). The alignment sweep holds a column of rows to one left edge and a row's parts to one first line, and Reroll under the preview or a picture beside the first line broke both at every size. On a narrow card the preview spans the body with the map centered, as tall as the smaller of its width and 45% of the body, or 40% at 130% or on the smallest phones.
- **Rooms on a size change (D-261102-423).** Rooms left at the old size's default move to the new size's default, and a count the DM typed is kept, clamped to the new size's cap.
- **The status line's zeros (D-261102-424).** "no traps", no "(0 locked)", and singular words for one ("1 door", "1 trap").
- **Where Make leaves the DM (D-261102-425).** A complete Make opens the scene with the Map builder tool picked and the panel closed, as the Builder form's Create does.
- **After a failed Make (D-261102-426).** After "none" Make stays on, to try again with fresh ids. After "partial" or "unconfirmed" the foot offers Close only, since a scene exists and a second Make would make a second dungeon. The outcome's sentence shows at the top of the choices.
- **Small words and focus (D-261102-427).** Copy seed shows no message, since the design's exact words have none. The fog warning is pinned above the foot (it stays in view while the choices scroll), and the foot's buttons grow, so a Make that wraps fills its line. The choices are kept per room under one key and focus opens on Theme's chosen option.
- **The frame (D-261102-387, DG-OPUS-27).** The one-shot request lives in `fitSlot.frameOnOpen`, with `takeFrame`, `openingFrame` and `openFramed`. Stage calls `openFramed`, which takes the request every time a sized canvas opens a new scene, before it chooses between the scene's saved view and a fit, and then runs the unchanged `openSceneCamera`. Taking the frame inside `fit` alone would have left it pending for a scene with a saved view. A refit keeps the frame as the fit's target. `sceneCamera.ts` is unchanged.
- **Make waits for the picture (DG-R1-01, DGBUILD-ASTRA-1).** The worker answers before the picture is drawn (textures load and the image encodes after), so Make and the status line once turned to a new answer while the old dungeon still showed. `flow.ts` holds the preview's state as a pure reducer: Make sends the newest request's answer only once `DungeonPreview` reports that very answer's picture on screen, and "Drawing the dungeon…" stays until then. A seed that stops reading takes a request number, so a preview still drawing is dropped (DGBUILD-ASTRA-2).
- **A picture that fails (D-261102-600).** The box empties and the choices say "This device could not draw the preview, so Make is off. Reroll or change a choice to try again." Rejected: keeping the old picture (an older dungeon would stand for this one), the generator's "This dungeon could not be made." (the dungeon is sound, the device could not draw it).
- **Held choices (DG-R1-02, DGBUILD-ASTRA-3, D-261102-601).** One `Held` group holds Theme through Party level, Across, Down and Rooms included, while Make sends and after a partial or unconfirmed outcome, with Reroll and the seed field. Copy seed stays on. Rejected: a `disabled` prop on the shared `NumberInput` (outside the generator's files, and `Held` is the app's way to stop a group), holding Copy seed too (copying changes nothing, and is useful after a partial Make).
- **The form after a Make (DG-R1-10, D-261102-602).** The dialog closes with whether a Make may have made a scene (sent, and not ended in none), and New scene's form then starts over as its Create does. Rejected: starting over at Make (the form holds the dialog, so it would close it mid-send), only on a complete outcome (a hidden dialog has none yet when it closes).
- **Copy seed (DG-R1-09)** copies the seed as read, in its four groups, not the text as typed.
- **`remembered.ts`** reuses `settings.ts` (`clampSettings`, `defaultRooms` and the caps) rather than keeping copies.

### Measured

The design left these to the build, and only the ones it gives a limit could fail it. All met their limits.

| What | Limit | Measured |
| --- | --- | --- |
| Fit rate, default choices, 400 seeds | every asked room in at least 95% | Small 99.8%, Medium 100%, Large 100% |
| `generate`, Medium | none | about 1 ms |
| `generate`, 100 by 100, 40 rooms, Wide, Dense, Winding | none | 27 ms on average, 59 ms worst. At least 365,000 of 400,000 search expansions left. At most 198 door edges |
| Worker bundle | 400 KB gzip | 1,025 KB minified, 272 KB gzip |
| Cold first Medium preview at 4× | 2 s | 80 ms, after a module load of 91 ms |
| Warm largest preview at 4× | 1 s | 86 to 163 ms over 5 seeds (21 to 43 ms in the worker at 1×) |
| Peak memory of one largest preview | 150 MB | the process grew 61 to 69 MB, and old space stayed under 40 MB |
| Sight pieces, largest choices | 4,800 | at most about 2,000 |
| Ops of one dungeon | 60 | at most 28 (the fixture's Medium has 11, its largest 23) |
| Make's dispatch task at 4× | 100 ms | under 50 ms, with no long task, for the defaults and the largest choices (39 rooms, 97 doors, 12 traps) |
| Make's main-thread work at 4× | 300 ms | the press to the dialog closing read 133 to 166 ms on an unloaded run |

- **The worker at 4×.** Chrome's CPU slowdown does not reach a dedicated worker (the times at 1× and 4× matched), so the 4× numbers were taken by running the same code on the page's thread under the slowdown.
- **The 300 ms limit is reported, not asserted (D-261102-603, DG-R1-12).** The e2e holds Make's dispatch task to 100 ms and logs the span from the press to the dialog closing, since that span holds the new scene's first drawing as well as Make's own work. Rejected: asserting the span against 300 ms (it measures more than the limit names, and a loaded machine fails it).
- **The 300 ms limit is met (D-261102-531).** The dispatch task stays under 50 ms with the largest choices. The long tasks of 55 to 121 ms seen while the dialog closes are the new scene's first drawing, the app's existing cost of opening any scene, not the generator's. Rejected: holding the build for a trace that separates the two, since the dispatch, the part the generator controls, passes by a wide margin.
- **A DM who hides the dialog and opens the scene mid-send.** The long tasks there were 51 to 98 ms, under 100, so Hide stays available online and the fallback in section 8 (Hide only while the send waits offline) was not needed.
- **Mutation checks.** The new rules were each put back wrong to see a test fail: 45 changes to the generator (44 caught, one equivalent, since stairs open only onto their own far landing, a dead end the search never takes), 39 to the landing (the survivors were checks another check already covers) and the dialog's and the frame's rules, all caught.

### Tests

Unit tests sit beside each file in `client/features/dungeon/`: the ChaCha20 stream against the RFC 8439 vector and OpenSSL across block edges, the seed, settings, layout, heights (the eight height and width fixtures at every facing), corridors, trap spots, plan properties with the fit floor, twelve golden plans, ops, the scratch room, the client, the send (including a randomized test of answers, order, input refusals, a moved-on DM and a short scene), the worker, the caps, the remembered choices and the words. `landed.prop.test.ts` runs 40 random settings and 24 default plans through every prefix of their ops, with walks, no corridor ledge, stairs facing up with both axis edges linked, daises walked onto and Reveal room exact. `server/rooms/dungeon.itest.ts` holds 12 cases through the real actor (parity and replay, players on another scene, Undo setup and Redo setup as one step, another device splitting it, a co-DM moving the players, a restart, a fogged scene, one revealed room, Duplicate and backup, and a size refusal partway). `flow.test.ts` walks the preview's state through random requests, late answers, bad seeds, pictures and failed pictures, with Make held to the newest answer on screen. The integration test also lands the fixture's ops with the shared reducer alone and compares the result with the DM's snapshot. `e2e/dungeon.e2e.ts` (prefix `DG`, and `DGFIX` for the build review's steps) covers the dialog and Make on a desktop and a phone, holds the picture's encoding to show Make off while an answered preview draws, a newer answer arriving mid-drawing included, and fails it to show the error, and the alignment sweeps gained the dialog and New scene's Builder form.

## Round 1

- **DG-ASTRA-1** (one group, one step): 4.5 says usually one step, names the splits and Delete, cases and itests added (D-261102-379).
- **DG-ASTRA-2** (starting view leak): no `defaultView` stored, the creating device frames the entrance by `fitSlot.frameOnOpen`, a player projection test before any ground is revealed (D-261102-387).
- **DG-ASTRA-3** (lost answers): the outcome mirrors `ImportOutcome` with the stored scene checked against the scratch room, send.test.ts cases (D-261102-388).
- **DG-ASTRA-4** (runs at junctions): runs reserved before corridors and closed to others, a no-ledge test (step 5, D-261102-382).
- **DG-ASTRA-5** (Wide doorways): 2-square doorways with double doors, full-width runs, Large walks tested, help reworded.
- **DG-ASTRA-6** (secret-only branches): no secret doors in phase 1 (D-261102-024).
- **DG-ASTRA-7** (budget failures): one global budget and the drop rule (5.4).
- **DG-ASTRA-8** (admission checks): the scratch run applies the shared checks to each prefix, server-only guards end as partial, parity through the actor (5.5).
- **DG-ASTRA-9** (entrance stub): routed last with the gap, through its own closed door, in the Reveal room test (steps 4 and 6).
- **DG-ASTRA-10** (secret door projection): deferred with D-261102-024. Phase 2 waits on SECRET-DOOR-DRAWN-EDGE with a paired projection test.
- **DG-OPUS-1** (main thread, burst): floors by terrain, heights by value, doors only, at most 60 ops, 10 a frame, measured at 4× (D-261102-371). How the send passes `satisfies` is in 5.5.
- **DG-OPUS-2**: as DG-ASTRA-1.
- **DG-OPUS-3**: as DG-ASTRA-3.
- **DG-OPUS-4** (drawn walls): every wall automatic by the halo rule, step 5's wall pass gone (D-261102-022, 380).
- **DG-OPUS-5**: as DG-ASTRA-6.
- **DG-OPUS-6**: as DG-ASTRA-4, each stair's ground stated exactly.
- **DG-OPUS-7**: the whole branch past a failed tree link is dropped and the count read after (5.4).
- **DG-OPUS-8**: as DG-ASTRA-5.
- **DG-OPUS-9** (dais and pillars): overlap allowed, the dais's stair and the square before it protected, daises off doorway lines (step 9).
- **DG-OPUS-10** (worker size): gzip, cold, warm and memory targets measured (section 8).
- **DG-OPUS-11** (zoom): the entrance room grown by 4 squares, fitted within the canvas's limits (4.5).
- **DG-OPUS-12** (equality, ids): compared with rev, `wallsVersion` and order left out, ids fresh at Make by `withIds` (5.5). Rev and `wallsVersion` come from prior values, not `env.seq`.
- **DG-OPUS-13** (alignment): the dialog root in alignmentRoom.ts, and the Builder kind in scenesetup's sweep (section 12).
- **DG-OPUS-14** (Rolling Stone): its real reasons given (phase 2, D-261102-383).
- **DG-OPUS-15** (players moved mid-send): a refusal needs the memory cap, so the case stays in the table with an itest.
- **DG-OPUS-16** (lane types): the contract commit, type owners named, a JSON fixture between client and server tests (D-261102-389).
- **DG-OPUS-17** (stored seed): dropped (D-261102-023).
- **DG-OPUS-18** (warning): keyed on fog left off by the form's choice (4.2).
- **DG-OPUS-19** (piece caps): the largest choices must stay under 80% of the sight cap, `splitCheck` run though it passes without free walls, caps lowered if not (section 8).

## Round 2

Opus reached consensus with seven P3s, and astra held five P2s. All are adopted, each checked against `c2232e72`.

- **DG-ASTRA-11** (landings flatten every room): the near landing is the one part of a run that may touch its own room, other contact still flattens it, and fixtures hold +5, +10, −5 and −10 on Narrow and Wide (step 5, heights.test.ts).
- **DG-ASTRA-12** (a sunk run's top stair has no higher neighbor): every stair faces along the run's axis, toward the room for positive G and away for negative G, tested for all four heights and all four facings (step 5, D-261102-382).
- **DG-ASTRA-13** (the hook needs Stage): Stage.tsx joins DG-C. Its opening `fit` calls `takeFrame(scene.id)` and passes the rectangle to `fitScene` as the target, `openSceneCamera` unchanged. Tests cover a late canvas size, another scene opening first and the player view's own scope (4.5, D-261102-387).
- **DG-ASTRA-14** (Delete refused for the players' scene, permissions.ts 662): the summary, 4.4's partial and unconfirmed sentences, 4.5, the guide and the co-DM case now say to move the players to another scene first (D-261102-379).
- **DG-ASTRA-15** (door edges past 160): the cap is 200, the largest Wide topology's 198 edges are tested in one `build.edge`, and loop links stop before the cap (section 8, D-261102-384).
- **DG-OPUS-20**: as DG-ASTRA-15.
- **DG-OPUS-21**: as DG-ASTRA-13.
- **DG-OPUS-22** (a pillar on the dais's top square): the dais square at the top of its stair stays clear, and landed.prop.test.ts walks onto every dais (step 9).
- **DG-OPUS-23** (10 a frame): every op is dispatched in one task, progress counts the answers, and the build measures that task and a DM opening the scene mid-send, with Hide held online if a task there passes 100 ms (4.4, section 8, D-261102-371).
- **DG-OPUS-24** (a run's sides open to its own corridor): the run and the squares beside it are closed to every corridor, its own entering only at the far landing (steps 5 and 6).
- **DG-OPUS-25** (a failed stub's door onto rock): a doorway whose corridor is never built goes with its door and run, for a failed stub, a skipped loop link and a dropped link's kept end (5.4).
- **DG-OPUS-26** (raised rooms stranding branches): a failed tree link is first retried with its raised end rooms flat, and the default choices must fit every room in at least 95% of 200 seeds (5.4, D-261102-380).

## Round 3

The design passed review in round 3, with two build notes that the text above now carries and the build keeps to.

- **DG-OPUS-27**, also DG-ASTRA-16 (the frame stays pending): Stage takes the frame request every time a sized canvas opens a new scene, before it chooses between the scene's saved view and a fit, and passes the rectangle to the fit. `openSceneCamera` skips `fit` for a scene with a saved view, so taking the frame inside `fit` alone would leave it pending. The cancellation test opens an intervening scene that has a saved view (4.5, As built).
- **DG-OPUS-28** (Undo setup and the players' scene): Undo setup is refused for the players' scene as Delete is, so 4.5 and the guide tell the DM to move the players to another scene first, for both.

## Build review round 1

Astra held one P2 and Opus reached consensus with twelve P3s. All are adopted.

- **DGBUILD-ASTRA-1**, also **DG-R1-01** (Make on before the picture): Make and the status line wait for the answer's own picture, the indicator stays until it lands, and a failed picture keeps Make off with its words (4.3, `flow.ts`).
- **DGBUILD-ASTRA-2** (a bad seed and a preview still drawing): the bad seed takes a request number, so the late answer is dropped.
- **DGBUILD-ASTRA-3**, with **DG-R1-02** (choices live during Make and after a partial one): one held group over the choices, Reroll and the seed field held too.
- **DGBUILD-ASTRA-4**, with **DG-R1-05** (stale build claims): no version claims, the frame described as built, one As built heading, and FEATURES.md's squares named the current limit.
- **DG-R1-03** (Undo setup promised): the checked and partial sentences say Undo setup usually works and both ways need the players elsewhere (4.4), and the integration test shows Undo setup refused for the players' scene.
- **DG-R1-04** (a rewrite hides a moved plan): `UPDATE_FIXTURES=1` refuses it at the same version.
- **DG-R1-06** (DG-9 at the phone): a second page of the DM's, loaded at 390 × 844, since a desktop page narrowed live does not open the Panels sheet the same way (D-261102-605).
- **DG-R1-07** (the flat retry): only no path retries flat (5.4).
- **DG-R1-08** (a worker that cannot start): the bug error, a fresh worker next.
- **DG-R1-09** (Copy seed): the seed in its usual form.
- **DG-R1-10** (a second empty scene after Hide): the form starts over.
- **DG-R1-11** (snapshot and reducer parity): the integration test compares them.
- **DG-R1-12** (the 300 ms only logged): reported, not asserted, with the dispatch task's 100 ms still held.
