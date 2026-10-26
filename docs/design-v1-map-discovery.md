# raccoon-vtt v1: the map as the party discovers it, and scene setup

Status: draft 1, 2026-10-26, for design review. Code is cited from main at `fbced312`. It extends docs/design-v1-maps-vision.md (2.1, 4.3), docs/design-v1-per-player-vision.md and docs/design.md 7.3 and 13, and follows their rules: server-authoritative state, per-viewer projection as the security boundary, server-made ops replayed as stored, bounded everything. Part A (sections 4 to 7) is D-261026-25. Part B (section 8) is D-261026-26 and its addition.

## 1. The owner's words

- The project owner, 2026-10-26: "I'm noticing that players still get updates for sections of the map that have been added and subtracted when player vision is on. I'd prefer them not to have the map layout itself until they discover it (idk if this was intended or if I'm doing something wrong) just doing the party vision setting" and "I thought in the past player vision applied to both updates on previously explored places and also future parts of the map that are unexplored (such as starting at a point in a dungeon and having to explore to get the layout)".
- And: "In this case I think we should also add an option to use current scenes settings so a dm doesn't have to setup player vision every single scene as this may be cumbersome/maybe we default to players seeing less. Or maybe even presets to make it easy (which can be changed after creation) open to your ideas and designs here".
- Then: "Maybe scene settings should also be grouped to keep vision based settings together to limit confusion. That page can probably use an organizational pass".
- D-261026-25: never-seen ground reaches players empty, explored ground keeps the build as last seen, ground in sight is live. Fog-only scenes withhold unrevealed ground and show revealed ground live. Fog off keeps today's dimmed whole map. The map image stays whole (PV-IMAGE follow-up).
- D-261026-26 and its addition: one "Players see" choice with three presets, a room default and "Like <scene>" in the new-scene form, copying vision settings onto other scenes, new rooms on explore, wall-less map images on reveal by hand with a warning, existing rooms unchanged until the DM sets a default, and one group for what players see on the scene settings page.
- The probe (openvtt-pvcheck, main `fbced312`): no screen shows never-seen build in either view, but every socket holds the whole build (`projectChunkCtx`, project.ts:1180, and `playerChunkOf`, :1257, never read fog). Explored ground draws the current build, so edits there show live, which is the owner's report. Case 6: a party placed on an empty scene before the DM builds sees all of it, so everything is explored and every room built later shows.

## 2. Summary

- **A player holds the build only where they have seen ground.** Every scene with fog on projects each player's chunks, labels and stamps through their own fog. Never-seen ground is empty in their data, walls and all.
- **Memory.** Where a DM edits ground a player remembers but does not see, the server keeps the old values (`memory`, `memoryBy`), written by one server-made op after the batch (`sys.remember`), and the player keeps seeing those until their sight or the DM's reveal reaches that ground again.
- **Derived walls are worked out on the server.** A player's copy says which cells it holds (`known`) and carries the automatic walls and stair directions of what it holds (`auto`, `upDir`), so no device invents a wall at the edge of its map.
- **Moves stay on the map you have.** A player's move, the plain straight leg included, may not take a creature onto ground the player has never seen. Device and server apply the same rule from the player's own fog, so no refusal says where an unseen wall is.
- **Scene setup.** "Players see": Explore, Reveal by hand or Everything, on every new-scene path and at the top of the scene's settings, with a room default, "Like <scene>", and "Use these settings on other scenes". The settings page regroups into What players see, Map image and grid, Walls and movement, Scene, Export, Delete.
- **Cost**, prototype on the laptop at the caps: masking a 200 x 200 build for one fog class takes 2 to 4 ms whole and 0.1 ms for a move's 9 chunks. Seven classes, the per-player worst, take 11 ms whole and 0.7 ms for a move. Every budget holds (section 7).

## 3. Decisions, with rejected options

Asking the owner is off, so each choice the decisions leave open is a guess at the owner's likely answer.

1. **A cell is held when any of its sub-cells is revealed in the viewer's fog**, and an element is held when any cell it touches is held: a cell's terrain, height and marks, an edge by either cell beside it, a free wall by any cell its segment meets, a label or stamp by its box (today's rule). On hexes a cell's sub-cells are those inside the hex (HX-D10). Rejected: a sub-cell test per element (it leaks less inside an edge cell, but a free wall crossing a held cell could then be withheld and still stop a move there, which M4 must never allow).
2. **Live where the viewer sees or the DM revealed.** An element is live when it touches a cell in the viewer's sight (vision on) or a cell the DM's fog layer reveals, remembered elsewhere. A DM's reveal means "show them this". Rejected: memory on DM-revealed ground (a reveal would need its own refresh, and fog-only scenes show revealed ground live by decision).
3. **Doors follow memory too.** A door's state on remembered ground stays as last seen. This replaces "doors on explored ground show their live state" (addendum question 16) and D-261025-17's shared live doors, since D-261026-25 names doors. Rejected: live doors on remembered ground (a monster opening a door far off would show).
4. **Labels and stamps follow memory, pins and found traps do not.** Labels and stamps are map furniture. Pins are notes the DM places for players, and found traps are players' own knowledge, so both keep today's rules. Rejected: memory for pins (page access already decides them).
5. **One memory per explored layer.** The party's layer has one, and each sight holder's own layer has one (per-player scenes). A holder reads their own memory where their layer holds the ground, else the party's. Party memory refreshes under the shared sight, a holder's under their own sight. Rejected: per-player memory of party ground (each holder would keep a second copy of everything the party remembers).
6. **Memory is a diff against the build now**, only where a layer last saw something else, so it is empty unless the DM edits remembered ground out of sight. Rejected: full chunk copies per layer (7 MB at the caps, past the room's 8 MiB).
7. **Written after the batch, replayed as stored.** The explore step becomes the map step: `sys.explore` as today, then `sys.remember`. Rejected: memory written by the reducer inside each build op (each op on the player scene would recompute sight, and a UVTT import sends hundreds).
8. **Past its cap a memory forgets instead.** 64 KiB per layer and scene, and a full room, make the step clear that layer's explored ground under the edit, so the ground goes back under fog. Rejected: refusing the DM's build op (players' memory must never stop the DM), dropping memory and keeping the ground (shows the edit).
9. **Vision or fog off forgets the scene's memory.** Players then hold the live build on everything revealed, as D-261026-25 says. Rejected: keeping memory while off (it would hide edits players already saw live).
10. **Moves stay on held ground** (M4, section 6). Rejected: bumping into an unseen wall reveals it (learning by trying, which the brief rules out), the server testing a player's move against their own view (creatures would walk through unseen walls), refusals without a place (repeated drags find it).
11. **Remembered ground keeps the real walls for moves.** A drag across remembered ground out of sight can be refused by a change the party has not seen. Accepted as risk 1, since the creature walked into it. Rejected: moving by memory there (walking through a new portcullis).
12. **Case 6 is sight, and the builder says so.** Ground seen empty stays empty while out of sight. On an open scene sight reaches everything, so what the DM builds in view shows as it is built. The builder warns on the players' scene, and Fog all now also forgets memory. Rejected: unpainted void blocking sight (changes sight's rules and blinds a battle mat).
13. **Presets** are Explore (fog and party vision on), Reveal by hand (fog on, vision off) and Everything (both off). Light, Sight and the rest stay their own rows. Fog off with vision on reads Custom. Rejected: presets that also set light (a dungeon and a night street both explore).
14. **The room default copies the preset only**, adjusted per kind: under Explore a map image or starter map starts on Reveal by hand and a blank mat on Everything, since sight with no walls reaches everywhere and a mat under party vision is black until a token stands on it. "Like <scene>" copies fog, party vision with its light and Sight, movement blocking and automatic walls. Rejected: blank mats on Explore (a new room's players would open on a black screen).
15. **Copy onto other scenes copies what players see only**: Players see, Light and Sight. Rejected: copying automatic walls and movement (changes walls of built scenes).
16. **The settings page folds on phones.** What players see opens, the other groups start folded on a phone and open on a wide screen, and each remembers per device. Rejected: a separate vision page (the addition rejects it).

## 4. Audit: what of the build reaches a player

"Today" is what a player's data holds on never-seen ground with fog on. "Needs" is what a player's device needs the item for.

| Item | Needs | Today on never-seen ground | Proposal |
| --- | --- | --- | --- |
| Cells (terrain, pillars), `rough` | drawing, routes' costs, pits | all, every chunk (project.ts:1180) | held cells only, memory on remembered ground |
| Heights, stair marks | relief, ledges, landing height, readout | all (`CHUNK_FOR_PLAYERS`, :1240) | held cells, others 0 and `.`. `upDir` gives held stairs' directions |
| Drawn walls, doors, windows, secret doors | drawing, movement, door pill | all, hidden doors as walls (:1257) | held edges, flattened as today, memory for state and existence |
| Free walls | the same | all, sorted | held when any cell they meet is held |
| Automatic walls | drawing, movement | derived on the device from every cell | materialized as `auto` on held edges, scene copy `autoWalls: "off"` |
| Builder lights and glow | none, effect only through sight | DM only (:1532) | unchanged |
| Labels, stamps | drawing | withheld under full fog, live elsewhere | held boxes, memory by id |
| Pins, found traps | drawing | withheld under full fog | unchanged |
| Map export, player view | DM's export | full build, fog for labels (content.ts:57) | the shared class's projection, what every non-holder holds |
| Door pill, door reach | open and close | pill only beside seen cells, reach over all walls (permissions.ts:1966) | reach also needs its line on held ground (6) |
| Heights readout | words | nothing on fogged cells | unchanged, remembered heights read as remembered |
| Drag, straight fallback, arrow keys, attach walk | moving | stops at unseen walls on the device (movement.ts:893, drop.ts:248, attach/walk.ts:60): the drag's hold mark draws above the fog | M4 (6) |
| Auto-route, walking rulers | routes | seen ground only, walls of every chunk | held build only, fallback by M4 |
| Path trails and corners | reading a move | corners only from searches over seen ground (movement 5.5) | unchanged, drawn over whatever the player holds |
| Area coverage, aim preview | drawing | clipped by unseen walls, the preview above the fog (coverage.ts:41) | clipped by held walls only, so it shows nothing unseen |
| Isometric walls, columns | drawing | stand only on revealed sub-cells | unchanged, from held build |
| Fog off, vision on | the dimmed whole map | the whole build, by design | unchanged. In Isometric unseen walls stand undimmed (follow-up ISO-DIM) |

## 5. The model

### 5.1 What a player holds

| Scene | Never-seen | Remembered (explored, not in sight) | In sight or DM-revealed |
| --- | --- | --- | --- |
| Fog on, vision on | nothing | memory, else the build now | live |
| Fog on, vision off | nothing | live (no memory) | live |
| Fog off, either | live, the whole build | live | live |

- **Whose fog.** A player's own (the DM's, the party's and, for a holder, their own layer, per-player 6.3). A table display and a non-holder read the shared fog. A DM gets the whole build as today, and no memory.
- **Remembered values.** For element e and viewer v: live if e touches v's sight or the DM's revealed ground. Else v's holder memory where v's own layer holds e's ground and has an entry, else the party memory's entry, else live.
- **View as a player** shows exactly this, since it is the server's projection for that player (per-player 7.4).

### 5.2 The player's chunk

`projectChunkForPlayer` becomes `playerChunk(state, chunk, view)`, where `view` names the fog class (5.6):

- The real chunk is flattened as today (hidden secret doors as walls, locks closed, free walls sorted), plus its automatic walls, by the scene's rule on the real cells across chunk borders.
- Each element then is held or not (decision 1), and takes its live or remembered value (5.1). Memory can bring back an element the build no longer has.
- New player-only fields, which the state schema refuses in stored chunks:
  - `known`: base64 of 256 bits, the held cells.
  - `auto`: base64 of 512 bits, an automatic wall on each held north and west edge.
  - `upDir`: one character per cell, the stair direction (`n`, `e`, `s`, `w` or `.`) of each held stair cell, as the real build infers it.
- The player's copy of the scene carries `autoWalls: "off"` on a scene with fog on, so `sceneWalls` derives nothing across the edge of what the copy holds. `walls.ts` reads `auto` as walls, `upDir` in place of `stairDirections`, and no raised edge beside a cell outside `known`. A missing chunk is all unknown.
- `rev` 0 as today, and a chunk with nothing held is withheld.

### 5.3 Memory: storage and growth

```ts
RoomState.memory: Record<string, MemoryChunk>     // "<sceneId>:<cx>,<cy>", the party's layer
RoomState.memoryBy: Record<string, MemoryChunk>   // "<sceneId>:<memberId>:<cx>,<cy>", a sight holder's
type MemoryChunk = {
  sceneId: SceneId; cx: number; cy: number; rev: number; memberId?: MemberId;
  // Each element as the layer last saw it, as players see it, only where that differs from the build now. null: absent then.
  cells?: Record<string, TerrainId | null>; edges?: Record<string, EdgeFeature | null>;   // an automatic wall as { kind: "wall" }
  walls?: Record<string, FreeWall | null>; heights?: Record<string, number>;
  up?: Record<string, StairMark>; rough?: Record<string, boolean>;
  labels?: Record<string, Label | null>; stamps?: Record<string, Stamp | null>;          // by id, in the chunk of the remembered anchor
};
```

- **The map step**, after every batch that holds ops, in `server/rooms/explore.ts`: first `sys.explore` as today, then one `sys.remember { sceneId, layers }` per scene it changes, each layer a list of chunks with entries to set and keys to drop, and `forget` cells where decision 8 applies. Server-made, checked against the server op schema, on no one's undo stack, replayed as stored. It never computes on replay.
- **Recording.** For each chunk, label and stamp the batch touched, with their east and south neighbors (automatic walls read across borders), and every chunk of a scene whose `autoWalls` changed, on any scene with vision and fog on: every element whose flattened value changed and that lies on a layer's remembered ground, not in that layer's sight after the batch and not on DM-revealed ground, gets that layer's entry. Its value is what the layer showed before the batch: its entry if it had one, else the value before. The sight is the layer's own (party: the shared sight, holder: theirs) on the player scene, and none on any other scene or behind a blackout.
- **Bookkeeping.** No undo step guards or restores memory, as with the explored layers.
- **Dropping.** An entry equal to the build now is dropped, so a DM's undo leaves no residue. On the player scene with no blackout, every entry whose element touches the layer's sight or DM-revealed ground is dropped: they see it now.
- **Order.** Entries in chunk key order, then element key order. A layer that would pass its cap, or a room that would pass its limit, takes the rest of the batch's entries for that layer as `forget` instead: the cells each element touches leave that layer's explored layer, as bookkeeping.

### 5.4 Everything that changes layers or memory

- **Fog.** A hide drops memory with the explored bits under its shapes, for every layer (`forgetUnderHides`, map.ts:56). `fog.reset` to hidden, Fog all, drops the scene's memory with its layers (`forgetExplored`, map.ts:79). Reveals and Reveal all leave memory to the step, which drops what is now DM-revealed.
- **Vision or fog turned off** drops the scene's memory, by an edit or an undo, as bookkeeping (decision 9). The explored layers stay as today.
- **Per player.** Unticking a holder, member removal and a scene's deletion drop that memory with the layer. The fold to Whole party pools memory as it pools layers: ground the party's layer held keeps the party's entries, and other ground takes the first holder's in list order. Switching to Per player starts holders from the party's memory.
- **A grid shape switch**, which needs a scene with no cells (HX-D14), drops the scene's memory and forgets the ground it covered.
- **Duplicate** with Fog copies memory with the layers, outside the undo step (duplicate.ts:115). Without it the copy has no memory.
- **Room export** carries memory. **Import** maps scene and member ids (`remap.ts`) and drops a holder's memory with their layer. Party memory always maps.
- **Map export's player view** uses the shared class's chunks: the party's layer and memory.

### 5.5 Sizes and migration

- **Cap** `LIMITS.memoryBytesPerLayer`, 65,536 encoded bytes per layer and scene. Party memory counts at its size. A holder's counts at the cap on every per-player scene, 393,216 bytes for 6, since its contents depend on that holder's sight (per-player 6.8).
- **Projected scene.** A player's chunks add at most two caps (their own memory and the party's) and the three strings (about 200 bytes a chunk, 34 KB at 169 chunks). The size guard adds both to the projected-scene check of each scene with fog on. The DM's projection is today's.
- **The explored reserve** (addendum 2.4) is unchanged.
- **Versions.** Snapshot version +1 adds empty `memory` and `memoryBy`. Op version +1 adds `sys.remember`. No stored op changes meaning, so replay of every stored room is unchanged.
- **The moment this deploys** the server restarts and every device takes a fresh snapshot. Never-seen build leaves every player's copy at once. Memory is empty, so remembered ground shows the build as it is at deploy, which players already saw under the old rule. No stored row changes.

### 5.6 Projection and fan-out

- **Chunks move to the fog classes** (fanout.ts:124): from `SCENE_KINDS` to `FOG_KINDS`, projected once per fog class (each holder alone, every other player and display together), so on a whole-party scene once for everyone. `memory` and `memoryBy` are never projected.
- **The memo** (fanout.ts:165) keys a chunk by its object, its 8 neighbors, the scene's `autoWalls`, the class's fog tile objects of the 3 x 3 tiles around it (a chunk is a fog tile), its memory chunk objects and, only while one exists, the class's sight tiles and the DM's fog tiles there. A label or stamp adds its memory entries.
- **`dependents`.** A fog, explored or `exploredBy` write brings the chunks of the 3 x 3 tiles around it. A memory write brings its chunk and the labels and stamps it names. A changed sight tile brings the chunks under it only where memory exists. A label or stamp re-projects with its chunk's memory.
- **`KEPT_AS_VALUES`** keeps chunks as today.

## 6. What still works

- **M4: moves stay on held ground.** On a scene with fog on and `blockMovement`, a player's move may not take the mover's core onto a cell the sender does not hold: each route piece, the plain straight leg and its fallback, an arrow key's press, a group's check set and an attach walk's `drag` members. `onHeldGround(fogged, core, from, to)` in `shared/rules/held.ts` decides it on both sides, from the sender's own fog. The device ends the drag at the last spot on held ground with "Stopped: the ground past here is not on your map yet." and the server refuses a leg that leaves it with the same words. Inside held ground every wall that can touch the core is held (decision 1), so the device and the server agree wherever the player holds the build live. The DM is never stopped. "Teleport here" works as today: it tests no wall.
- **Routes** already search only seen ground (walk.ts:57). They now read the held build, so a route never bends round a wall the player does not hold.
- **Doors.** The pill shows only for held doors (`doorSeen`). Reach also needs its line on held ground (`reachesDoor` and `doorsInReach` call `onHeldGround`), else "Too far from the door." on both sides. A door a player opens or closes refreshes every layer that player reads there: the step drops its entries, since the player touched it.
- **Rulers.** A straight ruler reads no walls. A walking ruler reads its device's held build. On a per-player scene a holder's device can walk a shared ruler differently where only that holder's sight shows a change. Nothing of a walk is sent, so this differs in drawing only (risk 4).
- **Areas.** A device clips coverage by the walls it holds, so an area aimed into unseen ground draws unclipped and shows nothing there. Reminders, traps and sight on the server read the real build.
- **Isometric** draws from the held build, by the stand rule as today.
- **The server reads the real build** for sight, explore, area sweeps, traps and the walls test of every move.

## 7. Cost

Measured with a scratch prototype on the development laptop, Node 24, on bench-vision.ts `capRoom`: 200 x 200 painted cells, 3,180 edges, 1,814 free walls, 976 KB of chunks, held ground the party's sight (16.6% of sub-cells). Per-player rows use `perPlayerRoom`, 6 holders and the shared class, no two alike. The prototype masks cells, edges, free walls and heights from per-class held maps. It does not yet merge memory or read `auto` from the derived wall set, so the build's bench adds those rows.

| Row (budget, laptop limit at 1.5) | Whole party (1 class, 8 players) | Per player (7 classes) |
| --- | --- | --- |
| Held maps from fog, whole scene | 1.0 ms | 7.0 ms |
| Every chunk masked: a global batch (250 ms, 167) | 2.0 to 3.8 ms | 10.8 to 12.2 ms |
| A move's 9 chunks (sight fan-out 10 ms, 6.7) | 0.11 ms | 0.65 ms |
| One chunk an op touches, per class | 0.012 ms | 0.012 ms |
| Bytes of a player's chunks | 155 KB, against 976 KB today | the same per class |

- A naive version that tested sub-cells per element took 33 ms a class, so the build keeps held maps per fog tile object (decoded once, as `mergedOf` does) and packed chunk indexes per chunk object.
- **The map step** reads the batch's touched chunks and, on the player scene, each layer's memory entries against its sight, at most the cap's entries per layer. It reuses the rasters the explore step drew.
- **Rows the build adds** to `scripts/bench-server4.ts`, on the 200 x 200 room with 8 players, whole party and 6 holders: a build edit in sight, a build edit on remembered ground (a memory write), a move that explores a new tile, a global batch with every layer's memory full, and a player's first snapshot. Budgets as the per-player rows: the op rows 25 ms, the fan-out 10 ms, the global 250 ms.

## 8. Scene setup

### 8.1 Players see

A radio group named **Players see**:

- **Explore**: "Players see what their characters see. Ground they have not seen stays dark, walls and all, and what they explored stays as they last saw it."
- **Reveal by hand**: "Players see what you reveal with the fog tool."
- **Everything**: "Players see the whole scene."
- **Custom**, shown in place of a ticked option when fog is off and vision on: "Custom: party vision is on and fog is off, so players see the whole map, dimmed outside what their characters see."
- **Wall-less warning**, under Explore when the scene's walls block no sight (`sceneWalls(...).sightPotential === 0`): "This scene has no walls yet, so party vision shows players all of it at once. Add walls first, or choose Reveal by hand." It shows in the new-scene form, in the scene's settings and in Move players.
- **Where.** The new-scene form for Battle mat, Map image (starter maps included) and Builder, under Kind of scene. The Universal VTT dialog, in place of "Start under fog", keeping its Light row, whose help becomes "<the proposal's reason>". Duplicate keeps the original's settings, as today. The top of the scene's What players see group.
- **Patches.** Explore sends `fogEnabled: true, vision: { on: true, light }`, Reveal by hand `fogEnabled: true, vision: { on: false, light }`, Everything `fogEnabled: false, vision: { on: false, light }`, in one `scene.update`. Light and Sight keep their values. The busy line is today's `sightWorkingText`.

### 8.2 The room default and Like

- `RoomSettings.newScenePlayers?: "explore" | "reveal" | "all"`, read only by the new-scene form, as `newScenes` is (HX-D19): every `scene.create` carries its own fields, so replay never reads it. New rooms set `"explore"` (shared/initial.ts). Absent reads as today's per-kind defaults.
- **Room settings** gain a group **New scenes** at its end with **Players see on new scenes**: Explore, Reveal by hand, Everything, and while unset "As before" ("Maps and the builder start under fog, battle mats without."). Help: "New scenes start on this. Under Explore a map image starts on Reveal by hand and a battle mat on Everything, since sight with no walls reaches everywhere."

| Default | Builder | Universal VTT | Map image, starter map | Blank mat |
| --- | --- | --- | --- | --- |
| Explore | Explore | Explore | Reveal by hand, warned | Everything |
| Reveal by hand | Reveal by hand | Reveal by hand | Reveal by hand | Reveal by hand |
| Everything | Everything | Everything | Everything | Everything |
| unset (existing rooms) | Reveal by hand | Reveal by hand | Reveal by hand | Everything |

- **Like <scene>**: a fourth option in the form's Players see, "Like Crypt", naming the DM's current scene, with help listing what it copies ("Explore, Dark, Per player, players' moves blocked, walls around floor only"). It copies `fogEnabled`, `vision` (`on`, `light`, `perPlayer`), `blockMovement` and `autoWalls`. The Universal VTT dialog keeps `autoWalls: "off"`, since the file brings its walls. A per-player copy starts with an empty holder list. The room's first Battle mat is Everything, as today.

### 8.3 Use these settings on other scenes

- A button at the end of What players see, "Use these settings on other scenes…", opens a sheet (a bottom sheet on a phone) titled "Use Crypt's settings on…": "Copies Players see, Light and Sight. Movement and walls stay as they are." Every other scene, by folder, with a checkbox, its current preset, and on the players' scene "The players are here. They see the change at once." "Select all" and "Copy to 3 scenes".
- One `scene.update` per scene, all under one undo group `g`, so one Undo takes them back, named "using Crypt's vision settings on 3 scenes" (`server/rooms/undoLabels.ts`).
- Busy: the button reads "Copying…" and refuses a second tap. The result: "Copied to 3 scenes." or "Copied to 2 of 3 scenes. Hall: <the refusal's words>", the explored reserve's refusal among them.
- Players on a changed scene get it at once: the edit sets `global`, Whole party pools layers and memory, vision or fog off drops memory.

### 8.4 The settings page

Today (SceneSettings.tsx): This scene (name, map image, Fog, starting view, suggested view, size, background), Map phases, Vision (VisionSettings.tsx:75), Grid, Movement (:115), Map builder (automatic walls), Export, Delete. Fog sits beside the name, away from party vision. Phone and wide show the same rows, and the view (Top-down or Isometric) changes nothing on the page.

Proposed, in order, the scene name first with no header:

1. **What players see**: Players see, Light, Light with each map phase, Sight, Who sees for themselves, Who lends sight with the mount and carried-light notes, a fold "Fog and party vision" (the two switches, open while Custom), and "Use these settings on other scenes…". The "Turn fog on" button goes: Explore does it.
2. **Map image and grid**: map image, map phases, grid lines, color, opacity, width, line up the grid, find the grid, count the squares.
3. **Walls and movement**: "Walls and ledges block players' moves", automatic walls, Open the builder, Clear the build.
4. **Scene**: size in squares, background, starting view, suggested view.
5. **Export as image**. 6. **Delete**.

Each group header is a button with `aria-expanded`. On a phone (below `wideMinWidth`) groups 2 to 4 start folded, on a wide screen all start open, and each remembers per device in `localStorage` (read and written in try/catch, open when unreadable).

## 9. UI checklist

- **Words** exactly as in 6, 8.1 to 8.4, the undo name of 8.3, and the builder's note on the players' scene while the party's sight meets a cell being built: "The party can see where you are building, so they see it as you build. Build before moving players here, or tap Fog all when you finish."
- **Loading.** Players see and the copy sheet are busy and refuse a second tap until acknowledged, with the shared indicator after 200 ms. A player's map needs nothing new: their chunks come with their fog.
- **Keys and focus.** Players see is a radio group: Tab reaches it, arrows move. Fold headers take Enter and Space, and focus stays on the header. The copy sheet traps focus, Escape closes it, and focus returns to its button. No new shortcut, so the shortcut sheet and FEATURES.md's key list are unchanged.
- **Screen readers.** The group is named "Players see" and described by the chosen option's help. Custom, the wall-less warning, the copy result and the stop note are polite statuses kept mounted.
- **Large interface sizes and phones.** Options stack one per row at 44 px, help wraps inside its row at 320 px and 130%. `measureAlignment` at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, nothing over 1 px: the new-scene form's Players see, the Universal VTT dialog's, each settings group folded and open, Room settings' New scenes, and the copy sheet (new roots in e2e/alignmentRoom.ts).

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| A room 2 the party never saw | No cell, wall, door, height, label or stamp of it in a player's data, either view | property MX1, e2e md-1 |
| A corridor running on into darkness | No wall at the edge of the player's map, `auto` and `known` say so | project unit, e2e md-2 |
| Party leaves, DM adds a wall and removes a door in room 2 | Their map shows room 2 as before, no frame holds the change | property MX2, e2e md-3 |
| They come back and see it | The live build replaces memory | property, e2e md-4 |
| A drag into never-seen ground | Stops at the edge of their map with the note, a crafted op is refused alike | M4 unit, e2e md-5 |
| A drag on held ground in sight | Device and server agree on every stop | property MX4 |
| A drag across remembered ground with a new wall, out of sight | Refused by the real wall (risk 1) | unit |
| A monster opens a door far from the party | The door stays shut on their maps | property, e2e md-3 |
| Fog all | Memory and explored ground forgotten, re-explored from where they stand | reducer unit, e2e md-6 |
| DM undoes an edit made out of sight | The entry drops, nothing left | step unit |
| Vision turned off, fog on | Revealed ground live, memory gone | reducer unit |
| Fog off | Today's whole map, every byte as before | golden |
| Fog-only scene | Unrevealed ground withheld, revealed live | property, e2e md-7 |
| Per player: Thorn saw a room alone, the DM changes it | Thorn's map keeps it, Bree holds nothing there | differential, property |
| Memory past 64 KiB on one layer | That layer forgets the edited ground instead | step unit at the cap |
| Party placed on an empty mat, DM builds | Rooms in sight show as built, insides stay empty until seen, the builder note shows | e2e md-8 |
| Replay of a room with `sys.remember` | Same memory, sight never computed | replay unit |
| Import, duplicate with Fog | Memory carried and mapped | remap and duplicate units |
| A room from before this deploys | Never-seen build gone from players, explored shown as at deploy | migrate unit, e2e md-1 |
| New Map image in a new room | Reveal by hand, Explore offered with the wall-less warning | client unit, e2e ss-1 |
| Like Crypt | Fog, vision, light, Sight, movement and walls copied | client unit, e2e ss-2 |
| Use on 3 scenes, then Undo | All three change, one Undo reverts all three | e2e ss-3 |
| An existing room | New scenes as before until the DM sets a default | client unit |

## 11. Security rules

1. On a scene with fog on, a player's projection holds a build element, label or stamp only where it touches a cell held in that player's own fog (decision 1). A display and a non-holder use the shared fog.
2. A held element is live only where it touches the viewer's sight or the DM's revealed ground. Elsewhere it is the viewer's memory where one has an entry, else live.
3. `memory`, `memoryBy` and `sys.remember` reach no viewer, DM included.
4. A player's chunk carries no cell outside `known` and no derived fact of an unheld edge or cell, and their scene copy never carries the real automatic walls rule on a scene with fog on.
5. The map step writes a holder's memory only from that holder's sight, and the party's only from the shared sight. Nothing reads another player's layer to build a player's view.
6. A player's move is refused, and stopped on the device, where it would leave the sender's held ground (M4).
7. No measure reads a holder's memory: each counts at its cap.
8. Fail closed. Memory that cannot be kept (the cap, a full room, an import that cannot map it) forgets its ground. A device treats a missing chunk, a missing `known` and a missing fog tile as unknown.
9. Sight, explore, areas, traps and the walls test read the real build.
10. With fog off nothing is withheld, as before.

## 12. Risks and accepted channels

1. **Remembered ground keeps real walls for moves.** A drag beyond sight across remembered ground can be refused by a change the party has not seen there, so the player learns something blocks that leg. Rare: a leg within the creature's sight sees the change first.
2. **Forgetting shows that something changed.** Past the cap or in a full room, the edited ground goes back under fog.
3. **The map image is whole** (D-261026-25, PV-IMAGE).
4. **Per player.** On party ground a holder's map returns to the party's memory once their own creature looks away, and a shared walking ruler can walk differently on their device there.
5. **Light and areas read real doors** (per-player risk 4): a torch through a door opened out of sight still lights what the party sees.
6. **A door a player touches** refreshes for everyone who shares that memory.

## 13. Lane plan

| Lane | Owns | After |
| --- | --- | --- |
| **MD1 Contract and reducer** | `shared/model.ts` (`MemoryChunk`, the two collections, `newScenePlayers`, player chunk fields), `shared/protocol.ts` (`sys.remember`, the room setting), `shared/keys.ts`, `shared/migrate.ts`, `shared/initial.ts`, `shared/limits.ts`, `shared/reducer.ts` (the op), `shared/reducer/map.ts` (`sysRemember`, drops under hides, resets, vision or fog off, the fold, the shape switch, forget), `duplicate.ts`, `room.ts` (member removal), `server/rooms/stateSchema.ts`. Unit tests | design review |
| **MD2 Projection and rules** | `shared/project.ts` (`playerChunk`, labels and stamps by memory, the scene copy, `dependents`, `allKeys`), new `shared/rules/held.ts` (held maps, `onHeldGround`), `shared/rules/walls.ts` (`known`, `auto`, `upDir`), `shared/permissions.ts` (M4, door reach), `shared/differential.ts`. Property tests MX1 to MX6, differential | MD1 |
| **MD3 Server** | `server/rooms/explore.ts` (the map step), `actor.ts`, `fanout.ts` (classes, memo), `sizeGuard.ts`, `remap.ts`, `server/rooms/memory.itest.ts`, `scripts/bench-server4.ts` (7's rows) | MD2 |
| **MD4 Client readers** | `client/features/movement/*` (M4 note, fallback, arrow keys), `client/features/attach/walk.ts`, `client/features/doors/*`, `client/features/measure/walkRuler.ts`, `client/features/mapexport/content.ts`, the builder note (`client/features/builder/`), `e2e/mapdiscovery.e2e.ts` (md-1 to md-8), FEATURES.md and the DM guide for part A | MD2, beside MD3, its e2e after MD3 |
| **MS1 Scene setup** | `client/features/scenes/NewScene.tsx`, `create.ts`, `client/features/uvtt/ImportDialog.tsx`, `client/features/vision/*` (Players see, `UvttLightChoice.tsx`, the fold, Fog moved in from SceneSettings.tsx:78, `moveWarning.ts`), new `client/features/vision/CopySettings.tsx`, `client/features/settings/form.ts` and `client/panels/SettingsPanel.tsx` (New scenes), `server/rooms/undoLabels.ts`, `e2e/scenesetup.e2e.ts` (ss-1 to ss-3), FEATURES.md and the guide | MD1's setting field |
| **MS2 Settings page** | `client/features/scenes/SceneSettings.tsx` (groups, order, folds), `client/components/Panel.tsx` (`Section` folds), `client/features/movement/SceneSetting.tsx`, `client/features/phases/PhasesSection.tsx` placement, the alignment roots of 9 in `e2e/alignmentRoom.ts`, e2e steps that open folded groups, FEATURES.md and the guide | MS1 |

- MD2 and MS1 run beside each other once MD1 lands. MD3 and MD4 run beside each other after MD2. MS2 follows MS1, since both touch the vision group. HX-3's lane may touch `client/features/settings/form.ts`: MS1 adds its group on its own lines at the end.
- **Property tests (MD2).** Random rooms of 1 to 8 players, whole party and per player, random builds (cells, edges, doors, secret doors, windows, free walls, heights, stairs, rough, labels, stamps, both automatic walls rules), random sight, fog reveals, hides, resets, vision and fog switches, DM edits in and out of sight, undo, blackouts, member changes, duplicates and imports. MX1: no player ever holds an element on ground their sight or the DM's reveal never reached, by an oracle that records every cell each viewer ever held. MX2: each held element equals its value at the viewer's last sight of it, or live where it is in sight or revealed, by the oracle's record. MX3: events applied to each snapshot equal `projectState`. MX4: on held live ground the device's move answer equals the server's. MX5: no projection holds memory, and replay rebuilds it. MX6: fog off gives today's bytes.
- **Mutants** each a test must fail on: a chunk projected once per scene, `known` left out, the device deriving automatic walls, memory dropped without the ground, memory written behind a blackout as seen, a hide that keeps memory, a holder's memory written from the shared sight, M4 read from the shared fog on a per-player scene, the memo keyed without memory.
- **e2e.** `e2e/mapdiscovery.e2e.ts` on a port offset no other file uses, with Ben's phone and a table display: steps md-1 to md-8 as in section 10, every frame Ben's page and the display received judged as in pervision's pv-8. Run with `reach`, `vision`, `pervision` and `iso`. `e2e/scenesetup.e2e.ts` ss-1 to ss-3. Each lane's last commit changes FEATURES.md and the DM guide for its part, with new screenshots.

## 14. Out of scope and follow-ups

Cutting the map image per player (PV-IMAGE). Isometric's undimmed walls with fog off (ISO-DIM). A DM view of where players' memory differs from the build. Memory for pins and found traps. Templates the DM manages.

## 15. As built

The builders fill this in, lane by lane, with every place the build went its own way.
