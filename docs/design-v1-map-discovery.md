# raccoon-vtt v1: the map as the party discovers it, and scene setup

Status: draft 2, 2026-10-26, revised for design review round 1 (section 16 maps every finding) and D-261026-29 with its amendment. Code is cited from main at `fbced312`. It extends docs/design-v1-maps-vision.md (2.1, 4.3), docs/design-v1-per-player-vision.md and docs/design.md 7.3 and 13, and follows their rules: server-authoritative state, per-viewer projection as the security boundary, server-made ops replayed as stored, bounded everything. Part A (sections 4 to 7) is D-261026-25 and D-261026-29. Part B (section 8) is D-261026-26 and its addition.

## 1. The owner's words

- The project owner, 2026-10-26: "I'm noticing that players still get updates for sections of the map that have been added and subtracted when player vision is on. I'd prefer them not to have the map layout itself until they discover it (idk if this was intended or if I'm doing something wrong) just doing the party vision setting" and "I thought in the past player vision applied to both updates on previously explored places and also future parts of the map that are unexplored (such as starting at a point in a dungeon and having to explore to get the layout)".
- And: "In this case I think we should also add an option to use current scenes settings so a dm doesn't have to setup player vision every single scene as this may be cumbersome/maybe we default to players seeing less. Or maybe even presets to make it easy (which can be changed after creation) open to your ideas and designs here".
- Then: "Maybe scene settings should also be grouped to keep vision based settings together to limit confusion. That page can probably use an organizational pass".
- D-261026-25: never-seen ground reaches players empty, explored ground keeps the build as last seen, ground in sight is live. Fog-only scenes withhold unrevealed ground and show revealed ground live. Fog off keeps today's dimmed whole map. The map image stays whole (PV-IMAGE follow-up).
- D-261026-26 and its addition: one "Players see" choice with three presets, a room default and "Like <scene>" in the new-scene form, copying vision settings onto other scenes, new rooms on explore, wall-less map images on reveal by hand with a warning, existing rooms unchanged until the DM sets a default, one group for what players see on the settings page.
- D-261026-29 and its amendment (round 1's owner questions, guessed): doors on remembered ground show as last seen. Players keep moving into unseen ground, the real build stops them, and what stops a creature on ground its player does not hold names no kind. A walk the held build allows and the real build stops lands at its last clear spot on the server. Past the memory cap forgetting goes by whole fog tiles and the builder asks first. "Like <scene>" keeps the new kind's automatic walls rule. A player's area reaches that player only for creatures on the caster's held ground. Route corners on scenes with memory reach a non-moving owner only on their sight or DM-revealed ground.
- The probe (main `fbced312`): no screen shows never-seen build, but every socket holds the whole build (`projectChunkCtx`, project.ts:1180, `playerChunkOf`, :1257). Edits on explored ground show live, which is the owner's report. Case 6: a party placed on an empty scene before the DM builds explores all of it.

## 2. Summary

- **A player holds the build only where they have seen ground.** On every scene with fog on, chunks, labels and stamps are projected through each player's own fog. Free walls are cut at the edge of held cells.
- **Memory.** Where the DM edits ground a player remembers but does not see, the server keeps the old values (`memory`, `memoryBy`), written by a server-made op after the batch (`sys.remember`). The player sees those until their sight or a DM reveal reaches that ground again.
- **Derived facts come from the server.** A player's chunk says which cells it holds (`known`) and carries the automatic walls and stair directions of what it holds (`auto`, `upDir`). Stub chunks carry them where no chunk is stored, so no device invents or loses a wall at the edge of its map.
- **The touch rule.** Players move into unseen ground as today. A walk the real build stops lands at its last clear spot, and a stop that touched ground the player does not hold says only "Something blocks the way."
- **Scene setup.** "Players see": Explore, Reveal by hand or Everything, with a room default, "Like <scene>" and "Use these settings on other scenes". The settings page regroups around what players see.
- **Cost**, prototype at the caps: 2 to 4 ms to mask a 200 x 200 build for one fog class, 0.1 ms for a move's 9 chunks. Seven classes take 11 ms and 0.7 ms.

## 3. Decisions, with rejected options

Asking the owner is off, so each choice the decisions leave open is a guess at the owner's likely answer.

1. **Held.** A cell is held when any of its sub-cells is revealed in the viewer's fog. Terrain, heights and marks go by their cell, an edge by either cell beside it, a label or stamp by its box (today's rule). On hexes a cell's sub-cells are those inside the hex (HX-D10). Rejected: a sub-cell test per element (a free wall could then be withheld inside a held cell and still stop a move there).
2. **Free walls are cut at held cells.** Every free wall as players see it, a hidden secret free door included, is clipped to the held cells it crosses, keeping its id. A cut end is the exact crossing of the cell's side, rounded outward along the wall to the next double, so nothing inside a held cell is lost. Only players' copies hold such ends, so no op or stored wall leaves the lattice. A hidden door's pieces are cut, rounded and sorted (`byCoordinates`) exactly as a wall's. Visible free doors and windows stay whole: door ops need the midpoint (`doorPlace`). Their geometry, at most 8 cells, is an accepted channel. Rejected: whole free walls (ASTRA-1, LK-1), keeping hidden doors whole (a whole "wall" marks a secret door, MD-O-33), stepping a cut end out to the wall's next 1/64 lattice point (an imported diagonal often has none between its ends, so the whole wall would go).
3. **Live where the viewer sees or the DM revealed**, remembered elsewhere. A DM's reveal means "show them this". Rejected: memory on DM-revealed ground (fog-only scenes show revealed ground live by decision).
4. **Doors follow memory** (D-261026-29), replacing maps-vision question 16 and D-261025-17. Round 3 rejected per-player door memory for four failures, and this memory avoids each:
   - Seeding disclosed unseen doors: nothing is seeded. An entry is written only for an element on ground its layer already remembers, as that layer showed it.
   - Route corners leaked private door knowledge: corners follow decision 12, which reads only the receiving owner's sight and DM reveals.
   - Unbounded growth: memory holds only differences, at most 64 KiB per layer and scene.
   - Import breakage: memory is keyed and mapped like the explored layers (5.4), and goes with its layer when that cannot map.
5. **Labels and stamps follow memory, pins and found traps do not.** Pins are notes for players and found traps are players' own knowledge. Rejected: memory for pins.
6. **One memory per explored layer, read per element.** The party's layer has one, and each holder's own layer has one. If any cell an element touches is held by the viewer's own layer, they read their own entry, else live. Otherwise they read the party's entry, else live. Rejected: falling through to the party's entry on own ground (shows a holder a state they saw change, LK-7).
7. **Memory is a diff against the build now**, empty unless the DM edits remembered ground out of sight. Rejected: full chunk copies per layer (7 MB at the caps).
8. **Written after the batch, replayed as stored**, by the explore step: `sys.explore` then `sys.remember`. Rejected: the reducer writing memory inside each build op (each op would recompute sight).
9. **Past its cap a layer forgets whole fog tiles, and the builder asks first** (D-261026-29). Rejected: forgetting cell by cell (draws the edit's outline, LK-2), the whole scene (harsh for one paste), refusing the DM.
10. **Vision or fog off forgets the scene's memory**, and the controls say so first. Rejected: keeping memory while off (hides edits players already saw live).
11. **The touch rule** (D-261026-29). Rejected: M4's ban on entering unheld ground (freezes a blind or unlit creature, stops every step past a reveal, changes play at deploy), refusing a stopped walk in place (free probing from one spot, MD-O-32), drawing what a creature touched (their map would hold geometry their sight never reached).
12. **Route corners on scenes with memory** reach a non-moving owner of a private leg only where every spot is in that owner's sight or on DM-revealed ground. Rejected: any ground the owner's fog reveals (draws the mover's memory or private sight, ASTRA-3).
13. **A player's area** gives that player reminders and caught lists only for creatures whose line from the origin lies on the caster's held ground. Rejected: accepting it as a touch (an area moves for free, so it probes for free).
14. **Border facts ride stub chunks.** Every chunk position with a held cell or held edge is sent, as a stub with only `known` and `auto` where no chunk is stored. Rejected: east and south border bits in each chunk with `known` from the device's fog (the device's walls would then read fog and lose their cache by chunk identity).
15. **Case 6 is sight, and the builder says so.** Ground seen empty stays empty while out of sight. On open ground sight reaches everything, so what the DM builds in view shows as built. Rejected: unpainted void blocking sight (changes sight and blinds a mat).
16. **Presets** are Explore (fog and vision on), Reveal by hand (fog on, vision off) and Everything (both off). Fog off with vision on reads Custom. Light and Sight stay their own rows. Rejected: presets that set light.
17. **The room default copies the preset only.** Under Explore a map image or starter map starts on Reveal by hand, since sight with no walls shows all its art. A blank mat starts on Explore: the party sees the open mat anyway, and a dungeon built on it later follows memory. The room's first Battle mat stays Everything, so joining players see a mat, not fog. "Like <scene>" copies fog, vision with its light and Sight, and movement blocking, and keeps the new kind's automatic walls rule (D-261026-29). Rejected: mats on Everything, copying a builder's walls rule onto an image.
18. **Copy onto other scenes copies Players see, Light and Sight.** Rejected: copying walls and movement (changes walls of built scenes).
19. **The settings page folds on phones**, What players see open. Rejected: a separate vision page.

## 4. Audit: what of the build reaches a player

| Item | Needs | Today on never-seen ground | Proposal |
| --- | --- | --- | --- |
| Cells, pillars, `rough` | drawing, route costs, pits | all (project.ts:1180) | held cells, memory on remembered ground |
| Heights, stair marks | relief, ledges, landing, readout | all (`CHUNK_FOR_PLAYERS`, :1240) | held cells, others 0 and `.`, `upDir` for held stairs |
| Drawn walls, doors, windows, secret doors | drawing, moves, door pill | all, hidden doors as walls (:1257) | held edges, memory for state and existence |
| Free walls | the same | whole | clipped to held cells, visible doors and windows whole |
| Automatic walls | drawing, moves | derived on the device | `auto` on held edges, stubs at borders, scene copy `autoWalls: "off"` |
| Builder lights and glow | none (sight only) | DM only (:1532) | unchanged |
| Labels, stamps | drawing | withheld under full fog | held boxes, memory by id |
| Pins, found traps | drawing | withheld under full fog | unchanged |
| Map export's player view | the DM's export | the DM's store, whole build (content.ts:57) | a server request for the shared projection |
| Door pill, door reach | opening | reach over every wall (permissions.ts:1966) | touch rule's words, reach from the shown door |
| Drag, fallback, arrows, groups, attach walk | moving | device stops at unseen walls (shared/rules/movement.ts:893, drop.ts:248, attach/walk.ts:60), its hold mark above the fog | the touch rule (6) |
| Resize, redo, companions, squeeze | moving, growing | real walls (permissions.ts:1820, :1055, :2150, :515) | refused in place, the touch rule's words |
| Routes, walking rulers | routes | seen ground, every wall | held build only |
| Path corners | reading a move | seen ground (movement 5.5) | decision 12 for owners |
| Areas: coverage, aim, reminders | drawing, reminders | device clips by every wall, preview above the fog | device by held walls, server by decision 13 |
| Isometric walls, columns | drawing | revealed sub-cells only | unchanged, from the held build |
| Fog off, vision on | dimmed whole map | the whole build | unchanged (Isometric: follow-up ISO-DIM) |

## 5. The model

### 5.1 What a player holds

| Scene | Never-seen | Remembered (explored, not in sight) | In sight or DM-revealed |
| --- | --- | --- | --- |
| Fog on, vision on | nothing | memory per decision 6, else the build now | live |
| Fog on, vision off | nothing | live (no memory) | live |
| Fog off | the whole build | live | live |

- **Whose fog.** A player's own (the DM's, the party's and a holder's own layer, per-player 6.3). A display and a non-holder read the shared fog. A DM gets the whole build as today and no memory. View as a player is the server's projection, so it shows exactly this.

### 5.2 The player's chunk

`projectChunkForPlayer` becomes `playerChunk(state, at, view)`, for a chunk position and a fog class (5.6):

- **Flattened** as today (hidden secret doors as walls, locks closed, free walls sorted), plus automatic walls by the scene's rule on the real cells across borders. A hidden secret door on an edge the rule walls is an automatic wall there, so it sets that edge's `auto` bit (MD-O-1).
- **Each element** is held or not (decisions 1 and 2) and takes its live or remembered value. Memory can bring back an element the build no longer has.
- **Player-only fields**, which the state schema refuses in stored chunks: `known` (44 base64 characters: the 256 held cells), `auto` (88: an automatic wall on each held north and west edge) and `upDir` (256: the direction of each held stair cell, `n`, `e`, `s`, `w` or `.`, present only where a held cell is a stair).
- **Stubs.** A position inside the bounds with a held cell or held edge and no stored chunk gets `{ sceneId, cx, cy, rev: 0, cells: {}, edges: {}, known, auto }`. So the east wall of a room on a chunk border, the west edge of an unbuilt neighbor, still reaches players, and so does a ledge beside a held empty cell there (MD-O-2). A position is withheld only when no cell, edge or wall piece of it is held.
- **The device.** The player's copy of the scene carries `autoWalls: "off"` on a scene with fog on. `walls.ts` reads `auto` as automatic walls, `upDir` in place of `stairDirections`, and derives no raised edge beside a cell outside `known`. A position with no chunk is all unknown.

### 5.3 Memory: storage and growth

```ts
RoomState.memory: Record<string, MemoryChunk>     // "<sceneId>:<cx>,<cy>", the party's layer
RoomState.memoryBy: Record<string, MemoryChunk>   // "<sceneId>:<memberId>:<cx>,<cy>", a holder's
type MemoryChunk = {
  sceneId: SceneId; cx: number; cy: number; rev: number; memberId?: MemberId;
  // Each element as the layer last saw it, as players see it, only where that differs from now. null: absent then.
  cells?: Record<string, TerrainId | null>; edges?: Record<string, EdgeFeature | "auto" | null>;
  walls?: Record<string, FreeWall | null>; heights?: Record<string, number>;
  up?: Record<string, StairMark>; upDir?: Record<string, StairDir>; rough?: Record<string, boolean>;
  labels?: Record<string, Label | null>; stamps?: Record<string, Stamp | null>;   // by id
};
```

- **The map step**, after every batch that holds ops (server/rooms/explore.ts): `sys.explore` as today, then one `sys.remember { sceneId, layers, forget? }` per scene it changes, each layer a list of chunks with entries to set and keys to drop. Server-made, on no one's undo stack, replayed as stored, never computed on replay. No undo step guards or restores memory.
- **What it records.** The elements the batch can have changed: each touched chunk with its east and south neighbors, every chunk whose derived stair map changed (the scene's stair map before and after, ASTRA-4), every chunk of a scene whose `autoWalls` or `bounds` changed, and each touched label and stamp. An element whose flattened value changed, on a layer's remembered ground, out of that layer's sight after the batch and off DM-revealed ground, gets that layer's entry. Its value is what the layer showed before: its entry if it had one, else the value before. A layer's sight is the shared sight for the party and theirs for a holder, on the player scene only, and none behind a blackout.
- **Auto walls** keep their kind: `"auto"` is a remembered automatic wall, and a null entry hides an automatic wall that appeared out of sight (MD-O-7).
- **Labels, stamps and free walls by id** (MD-O-9). An entry is judged by both boxes. It drops when the live box touches the layer's sight or revealed ground. It becomes `null` when only the remembered box does, since they see the thing is gone from there. An index by id finds entries, and an id only memory names gets a key, which the memo and `dependents` read.
- **Dropping.** An entry equal to the build now drops, so a DM's undo leaves nothing. On the player scene the step drops every entry whose element touches the layer's sight or DM-revealed ground, scanning only entries on sight tiles the batch changed (by tile object, as explore.ts does).
- **Doors touched.** A player's `door.set` accepted, written or not, and one refused GONE after reach passed (6), drop that door's entries in every layer the sender reads (MD-O-6).
- **The cap and the ask** (D-261026-29, MD-O-34). The actor keeps a running estimate per layer through the batch: its memory now plus the entries each accepted op could add, counting every changed element on remembered ground as out of sight, so the estimate is never low. A DM's op that would push one past 64 KiB is refused with a DM-only code and "Players' remembered map here will be forgotten. Go ahead?" The builder asks, and on yes resends with `forget: true`. A multi-op gesture (a Universal VTT import, a paste, an undo) asks once and sends its remaining ops with the flag. The reducer ignores the flag, and the forget lands in `sys.remember` as stored.
- **Forgetting by tiles.** Taking entries in chunk and key order, a layer past its cap forgets every fog tile each element that does not fit touches: those tiles leave its explored layer, and its entries for elements that touch only forgotten tiles drop. Entries of elements still held through another tile stay. An element held only through forgotten tiles leaves the projection in the same batch. Undo does not bring the players' map back (MD-O-16, MD-O-30, LK-19).

### 5.4 Everything else that changes layers or memory

- **Fog.** A hide drops an entry only when its element touches no cell its layer still holds (MD-O-5). Fog all drops the scene's memory with its layers. Reveals leave memory to the step.
- **Vision or fog off** drops the scene's memory, by an edit or an undo, as bookkeeping.
- **Per player.** Unticking a holder, member removal and a scene's deletion drop that memory with the layer. The fold to Whole party pools per element: an element touching a cell the party's layer held keeps the party's entry or none, any other the first holder's in list order.
- **A stamp set DM-only** drops its entries, so its art stops reaching players (MD-O-10).
- **A grid shape switch**, which needs a scene with no cells (HX-D14), drops the scene's memory and forgets its tiles.
- **Duplicate** with Fog copies memory, giving labels and stamps the copies' ids (`copyId`, duplicate.ts:53) and fresh ones to ids only memory names. Free wall ids are chunk-scoped and kept.
- **Room export** carries memory (`exportRoom.ts`, whose asset rows already go whole, exportRoom.ts:90). **Import** (`remap.ts`, `importRoom.ts`) maps scene, member, label and stamp ids, allocates ids for memory-only entities, maps stamp art and drops what does not map, checks nested asset kinds, and drops a holder's memory with their layer (ASTRA-5).
- **Assets.** `referencedAssets.ts` counts stamp art in both collections, so cleanup (server/assets/cleanup.ts:69) keeps an image memory still shows (ASTRA-6).

### 5.5 Sizes, migration and hexes

- **Cap** 64 KiB per layer and scene (`LIMITS.memoryBytesPerLayer`). Party memory counts at its size. A holder's counts at the cap, 6 x 64 KiB a per-player scene, since its contents follow private sight (per-player 6.8). Switching to Per player needs that reserve too (`PER_PLAYER_FULL`).
- **Deploy recovery** (MD-O-14). On a per-player scene that exists at deploy, the holder reserve counts at most the room's free space without it, shared equally by 6 layers. A layer's cap is its share, so no room becomes full at deploy, and a layer whose share is small forgets sooner, fail closed. Once the room frees space the share grows back to 64 KiB.
- **Projected scene.** A player's chunk positions add at most about 0.5 KB each (stub header, `known`, `auto`, `upDir`), 86 KB at 169, plus two caps of memory. The size guard adds that widest case to the projected-scene check of each scene with fog on.
- **Versions.** Snapshot version +1 adds empty `memory` and `memoryBy`. Op version +1 adds `sys.remember` and `forget`. No stored op changes meaning.
- **The moment this deploys** every device takes a fresh snapshot. Never-seen build leaves every player's copy, memory starts empty, and remembered ground shows the build as at deploy, which players already saw live.
- **Hexes** (H2 and H3 integration, MD-O-15, LK-11). Hex cell data maps to the fog tiles its hexes' world box covers (as HX-D22), a chunk's free walls to world tiles, `known` indexes the chunk's hex keys, and a free wall is held by the hexes whose sub-cells it crosses.

### 5.6 Projection and fan-out

- **Chunks and stubs move to the fog classes** (fanout.ts:124), projected once per class: each holder alone, every other player and display together. `allKeys` lists every chunk position in a fog scene's bounds. Memory is never projected.
- **The memo** (fanout.ts:165) keys a chunk by its object, its 8 neighbors, the scene's `autoWalls`, its derived stair map, the class's fog tiles of the 3 x 3 tiles around it and its memory objects, and while memory exists the class's sight tiles and the DM's fog tiles there.
- **`dependents`.** A fog, explored or `exploredBy` write brings the chunk positions of the 3 x 3 tiles around it. A changed sight tile brings those of the 3 x 3 tiles around it where any memory the class reads has entries (MD-O-24). A memory write brings its chunk and the labels and stamps it names. A changed stair map brings every chunk where it changed.

## 6. Movement and the rest

- **The touch rule** (D-261026-29). Players move into unheld ground as today, and the server tests the real build. A player's walked move, route piece, arrow step, group leg or attach walk that the held build allows and the real build stops is cut on the server at `landing(..., "walk")`'s last clear spot (shared/rules/movement.ts:893) and stored as the move made. The sender's `ev` carries `blocked: [n]`, and the device shows the stop note with "Teleport here" as today. Resize, companion placement and squeeze refuse in place, since they reach only the body or the companion. A redo refuses in place too: it needs an undo first, so each try still costs a real move.
- **The words** (MD-O-31, LK-17). The server tests the swept core (resize: the new footprint, squeeze: the full footprint, door reach: the reach line less its end at the door) closed against the sender's held cells. Any touch of an unheld cell gives "Something blocks the way.", else today's words. The device uses the same test, so its preview says what the server will. Routes, attach walks, redo, companion placement, squeeze and door reach take the same rule.
- **What the device sees.** Its preview walks the held build, so a drag into the dark goes to the finger. The server's landing replaces it within the batch.
- **Doors** (MD-O-6). The pill shows only held doors. A `door.set` is judged first by the shown door's geometry: memory's where the sender remembers one. While reach fails the answer is a real door's. Once reach passes, a stored door that is gone or moved refuses GONE with the touch recorded (5.3), with no dereference of a missing wall (`doorPlace`, permissions.ts:1993). A remembered door whose real state is already the one asked is a no-op, its touch recorded, so the sender then sees it as it is.
- **Routes** search seen ground (walk.ts:57) over the held build. Corners follow decision 12.
- **Rulers.** A walking ruler reads its device's held build. On a per-player scene a holder's device can walk a shared ruler differently where only their sight shows a change. Nothing of a walk is sent.
- **Areas** (decision 13). A device clips coverage by the walls it holds. The server sends a player's area's reminders and caught lists to that player only for creatures whose line from the origin lies on the caster's held ground. The rest are the DM's.
- **The server reads the real build** for sight, explore, area sweeps, traps and every walls test.

## 7. Cost

Scratch prototype on the development laptop, Node 24, bench-vision.ts `capRoom`: 200 x 200 painted cells, 3,180 edges, 1,814 free walls, 976 KB of chunks, held ground the party's sight (16.6%). Per-player rows use `perPlayerRoom`, 6 holders and the shared class. It masks cells, edges, free walls and heights from per-class held maps. It does not clip free walls, merge memory, build stubs or read `auto`, `upDir` and `known`, so the build's bench adds those.

| Row (budget, laptop limit at 1.5) | Whole party (1 class, 8 players) | Per player (7 classes) |
| --- | --- | --- |
| Held maps from fog, whole scene | 1.0 ms | 7.0 ms |
| Every chunk masked: a global batch (250 ms, 167) | 2.0 to 3.8 ms | 10.8 to 12.2 ms |
| A move's 9 chunks (sight fan-out 10 ms, 6.7) | 0.11 ms | 0.65 ms |
| A player's chunk bytes | 155 KB, against 976 KB today | the same per class |

- A naive version took 33 ms a class, so the build keeps held maps per fog tile object and packed chunk indexes per chunk object.
- **Rows the build adds** to `scripts/bench-server4.ts`, the 200 x 200 room with 8 players, whole party and 6 holders: a build edit in sight, one on remembered ground, a move exploring a tile, a move with every layer's memory full (MD-O-21), a global batch with memory full, a stair edit felt chunks away, and a first snapshot. Budgets as the per-player rows: ops 25 ms, fan-out 10 ms, global 250 ms.

## 8. Scene setup

### 8.1 Players see

A radio group named **Players see**:

- **Explore**: "Players see what their characters see. Ground they have not seen stays dark, walls and all, and what they explored stays as they last saw it."
- **Reveal by hand**: "Players see what you reveal with the fog tool."
- **Everything**: "Players see the whole scene."
- **Custom**, in place of a ticked option when fog is off and vision on: "Custom: party vision is on and fog is off, so players see the whole map, dimmed outside what their characters see."
- **Wall-less warning**, under Explore on a scene with a map image whose walls block no sight (`sightPotential === 0`): "This map has no walls yet, so party vision shows players all of it at once. Add walls first, or choose Reveal by hand." In Move players for another scene, whose chunks the DM's device lacks (MD-O-28): "If its map has no walls yet, party vision shows players all of it at once."
- **Leaving Explore** on a scene with explored ground, from the preset, the switches or the copy sheet (LK-9): "Players will see the build as it is now on everything they explored. Undo does not bring back what they remembered." Per player to Whole party: "Each player's own map joins the party's. Undo does not split them again."
- **Where.** The new-scene form for Battle mat, Map image (starter maps included) and Builder, under Kind of scene. The Universal VTT dialog, in place of "Start under fog", whose light help becomes the proposal's reason alone (MD-O-29). Duplicate keeps the original's settings. The top of the scene's What players see group.
- **Patches.** Explore sends `fogEnabled: true, vision: { on: true, light }`, Reveal by hand `fogEnabled: true, vision: { on: false, light }`, Everything `fogEnabled: false, vision: { on: false, light }`, in one `scene.update`. Light and Sight keep their values.

### 8.2 The room default and Like

- `RoomSettings.newScenePlayers?: "explore" | "reveal" | "all"`, read only by the new-scene form: every `scene.create` carries its own fields, so replay never reads it. New rooms set `"explore"` (shared/initial.ts). Absent reads as today's per-kind defaults.
- **Room settings** gain one group **New scenes** at the end (MD-O-27) holding **Players see on new scenes** (Explore, Reveal by hand, Everything, and while unset "As before": "Maps and the builder start under fog, battle mats without.") and the grid-shape default `newScenes` (HX-D19), whichever of this lane and HX-3 lands it first. Help: "New scenes start on this. Under Explore a map image with no walls starts on Reveal by hand, since party vision would show players all of it."

| Default | Builder | Universal VTT | Map image, starter map | Blank mat |
| --- | --- | --- | --- | --- |
| Explore | Explore | Explore | Reveal by hand, warned | Explore |
| Reveal by hand | Reveal by hand | Reveal by hand | Reveal by hand | Reveal by hand |
| Everything | Everything | Everything | Everything | Everything |
| unset (existing rooms) | Reveal by hand | Reveal by hand | Reveal by hand | Everything |

- **Like <scene>**: a fourth option, "Like Crypt", naming the DM's current scene, with help listing what it copies ("Explore, Dark, Per player, players' moves blocked"). It copies `fogEnabled`, `vision` (`on`, `light`, `perPlayer`) and `blockMovement`. Automatic walls keep the kind's rule: "all" for a mat or builder, "floor" for a map image or starter map, "off" for a Universal VTT import. A per-player copy starts with an empty holder list. The room's first Battle mat is Everything in every room.

### 8.3 Use these settings on other scenes

- A button at the end of What players see, "Use these settings on other scenes…", opens a sheet (a bottom sheet on a phone), "Use Crypt's settings on…": "Copies Players see, Light and Sight. Movement and walls stay as they are." Every other scene by folder, with a checkbox and its current preset. A scene's line adds "The players are here. They see the change at once.", "Players' remembered maps here reset." where it leaves Explore with explored ground, and "Each player's own map here joins the party's." where it leaves Per player (MD-O-18). "Select all" and "Copy to 3 scenes".
- One `scene.update` per scene under one undo group `g`, named "using Crypt's vision settings on 3 scenes". The sheet says: "Undo puts the settings back, not players' maps."
- Busy: "Copying…", refusing a second tap. The result: "Copied to 3 scenes." or "Copied to 2 of 3 scenes. Hall: <the refusal's words>".

### 8.4 The settings page

Today (SceneSettings.tsx): This scene (name, map image, Fog, starting view, suggested view, size, background), Map phases, Vision (VisionSettings.tsx:75), Grid, Movement (:115), Map builder, Export, Delete. Fog sits beside the name, away from party vision. Phone and wide show the same rows, and Top-down or Isometric changes nothing on the page.

Proposed, the scene name first with no header:

1. **What players see**: Players see, Light, Light with each map phase, Sight, Who sees for themselves, Who lends sight with its notes, a fold "Fog and party vision" (the two switches, open while Custom), and "Use these settings on other scenes…". "Turn fog on" goes: Explore does it.
2. **Map image and grid**: map image, map phases, grid lines, color, opacity, width, line up, find the grid, count the squares.
3. **Walls and movement**: "Walls and ledges block players' moves", automatic walls, Open the builder, Clear the build.
4. **Scene**: size in squares, background, starting view, suggested view.
5. **Export as image**. 6. **Delete**.

Each group header is a button with `aria-expanded`. On a phone (below `wideMinWidth`) groups 2 to 4 start folded, on a wide screen all open, and each remembers per device in `localStorage` (try/catch, open when unreadable).

## 9. UI checklist

- **Words** exactly as in 5.3, 6 and 8, and the builder's note on the players' scene while the party's sight meets a cell being built: "The party can see where you are building, so they see it as you build. Build before moving players here, or tap Fog all when you finish."
- **Loading.** Players see, the copy sheet and the forget question are busy and refuse a second tap until answered, with the shared indicator after 200 ms. A player's map needs nothing new: chunks come with their fog.
- **Keys and focus.** Players see is a radio group: Tab reaches it, arrows move. Fold headers take Enter and Space and keep focus. The copy sheet and the forget question trap focus, Escape answers no, and focus returns to what opened them. No new shortcut, so the shortcut sheet and FEATURES.md's key list are unchanged.
- **Screen readers.** The group is named "Players see" and described by the chosen option's help. Custom, the warnings, the copy result and the stop note are polite statuses kept mounted.
- **Large sizes and phones.** One option per row at 44 px, help wrapping inside its row at 320 px and 130%. `measureAlignment` at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, nothing over 1 px: the form's Players see, the Universal VTT dialog's, each settings group folded and open, Room settings' New scenes, the copy sheet and the forget question (new roots in e2e/alignmentRoom.ts).

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| A room the party never saw | No cell, wall, door, height, label or stamp of it in a player's data | MX1, e2e md-1 |
| A corridor running on into darkness | No wall at the edge of their map | project unit, e2e md-2 |
| A room's east wall on a chunk border, the next chunk unbuilt or unheld | The wall reaches them in a stub | project unit |
| A ledge beside a held empty cell in an unbuilt chunk | The ledge reaches them, device and server agree | project unit, MX4 |
| A hidden secret door on an automatic-wall edge | An `auto` bit, no gap | unit, mutant |
| A free wall crossing held and unheld cells | Only its held pieces, a hidden door's pieces cut as a wall's | unit, MX1 |
| Party leaves, DM adds a wall and removes a door | Their map shows the room as before, no frame holds the change | MX2, e2e md-3 |
| They come back and see it | The live build replaces memory | MX2, e2e md-4 |
| A monster opens a door far off | The door stays shut on their maps | MX2, e2e md-3 |
| A drag into the dark, a wall there | Lands at its last clear spot, "Something blocks the way." | touch unit, e2e md-5 |
| A diagonal past the corner of an unheld raised cell | The same generic words | touch unit |
| Resize, redo, companion placement, squeeze beside unheld ground | Refused in place with the generic words | touch units |
| Paired worlds differing only on unheld cells the core never touches | The same landing and words | differential |
| A blind creature in the dark | Moves as today, stopped by real walls | e2e md-5 |
| A label moved out of sight from in sight | Gone from where they saw it, not shown where it went | MX2 unit |
| A stamp set DM-only out of sight | Leaves their map | unit |
| A hide over part of an element | Its entry stays while it is held | MX2 case |
| `door.set` on a remembered door: gone, moved, state differs | Reach first, then GONE or a no-op, the touch recorded, no throw | permissions units |
| A stair run edited chunks away, out of sight | `upDir` stays as remembered, warm cache and reconnect | unit, MX2 |
| An area aimed past an unrevealed wall, nothing moving | No reminder or caught line for that player beyond held ground | areaTriggers unit (astra's repro) |
| Co-owners with equal fog and different memories | No corner from the mover's memory or private sight | differential |
| Fog all | Memory and explored ground forgotten | reducer unit, e2e md-6 |
| An edit past a layer's cap | The builder asks, then whole tiles are forgotten | step unit, e2e md-6 |
| Vision off, fog on | Revealed ground live, memory gone | reducer unit |
| Fog off | Today's whole map, every byte as before | golden |
| Fog-only scene | Unrevealed ground withheld, revealed live | MX1, e2e md-7 |
| Party on an empty mat, DM builds | Rooms in sight show as built, insides stay empty until seen | e2e md-8 |
| Replay, import, duplicate | Same memory, ids and art mapped, art kept by cleanup | replay, remap, duplicate, cleanup units |
| A room near full at deploy | Loads and takes edits, holder caps shrunk | sizeGuard unit |
| Map export's player view of a scene players left | The shared projection, memory included | server itest |
| New Map image, new Battle mat, the first Battle mat in a new room | Reveal by hand warned, Explore, Everything | client units, e2e ss-1 |
| Like Crypt on a map image | Fog, vision and movement copied, walls "floor" | e2e ss-2 |
| Use on 3 scenes, then Undo | Settings back in one step, the sheet named any reset | e2e ss-3 |

## 11. Security rules

1. On a scene with fog on, no player's projection or socket holds any piece of geometry, label or stamp on a cell their sight or a DM reveal never reached, except visible free doors and windows, whole by decision 2.
2. A held element is live only where it touches the viewer's sight or DM-revealed ground. Elsewhere it is the viewer's memory by decision 6.
3. `memory`, `memoryBy` and `sys.remember` reach no player's projection or socket. The DM gets them only in the room export.
4. A player's chunk carries derived facts only for held cells and edges: automatic walls on held edges and directions of held stairs, which may read unheld cells. Their scene copy never carries the real automatic walls rule on a scene with fog on.
5. The map step writes a holder's memory only from that holder's sight, and the party's only from the shared sight.
6. A stopped player walk lands at its last clear spot, stored. A refusal or stop whose swept core touches an unheld cell names no kind. No preview, refusal or reminder says anything about unheld ground the creature did not reach or touch.
7. A player's area reaches that player only for creatures on the caster's held ground. Corners of a private leg reach a non-moving owner only on their sight or DM-revealed ground.
8. No measure reads a holder's memory: each counts at its cap or its share.
9. Fail closed. Memory that cannot be kept forgets whole tiles. A device treats a missing chunk, `known` or fog tile as unknown.
10. Sight, explore, areas, traps and the walls test read the real build. With fog off nothing is withheld, as before.

## 12. Risks and accepted channels

1. **Touch.** What stops a creature on unheld ground, or on remembered ground changed since, is something it touched: the landing says where. Probing costs real moves, logged, and each undo and retry is another real touch. Door reach on remembered ground can be stopped the same way. A route can rarely bend around a wall added out of sight that touches no cell in sight (LK-13).
2. **Forgetting.** Past the cap, or with a shrunk share in a full room, whole tiles go back under fog, which says something changed there. Undo does not bring the players' map back.
3. **The map image is whole** (PV-IMAGE). **Visible free doors and windows are whole**, at most 8 cells past held ground.
4. **Per player.** `ownExplored` never adds party-held sub-cells to a holder's layer, so on party ground a holder's map returns to the party's memory once their own creature looks away. A shared walking ruler can walk differently on their device there.
5. **Own acts are public.** A party member, always shown, seen walking through a door others remember shut shows it open (beside per-player risks 4 and 6). Light reads real doors, so a torch through a door opened out of sight still lights what the party sees.
6. **A door a player touches** refreshes for everyone who shares that memory.

## 13. Lane plan

| Lane | Owns | After |
| --- | --- | --- |
| **MD1 Contract and reducer** | `shared/model.ts` (`MemoryChunk`, the collections, `newScenePlayers`, player chunk fields), `shared/protocol.ts` (`sys.remember`, `forget`, `blocked`, the setting, the DM-only code), `shared/keys.ts`, `shared/migrate.ts`, `shared/initial.ts`, `shared/limits.ts`, `shared/reducer.ts`, `shared/reducer/map.ts` (`sysRemember`, hides, resets, vision or fog off, the fold, the shape switch, tile forgetting), `duplicate.ts`, `room.ts` (member removal, DM-only stamps), `shared/referencedAssets.ts`, `server/rooms/stateSchema.ts` | design review |
| **MD2 Projection and rules** | `shared/project.ts` (`playerChunk`, stubs, clipping, labels and stamps by memory, the scene copy, `dependents`, `allKeys`), new `shared/rules/held.ts`, `shared/rules/walls.ts` (`known`, `auto`, `upDir`), `shared/permissions.ts` (the touch rule's cut and words, door ops), `shared/reducer/areaTriggers.ts` (decision 13), `shared/differential.ts`. MX1 to MX6, differential | MD1 |
| **MD3 Server** | `server/rooms/explore.ts` (the map step), `actor.ts` (the estimate, the cut, `blocked`), `fanout.ts`, `sizeGuard.ts` (reserves, deploy shares), `remap.ts`, `exportRoom.ts`, `importRoom.ts`, the map export's player-view request (server/http), `server/rooms/memory.itest.ts`, `scripts/bench-server4.ts` | MD2 |
| **MD4 Client readers** | `client/features/movement/*` (stop note, `blocked`), `client/features/attach/walk.ts`, `client/features/doors/*`, `client/features/measure/walkRuler.ts`, `client/features/mapexport/*` (the request), the builder's note and forget question (`client/features/builder/`), `e2e/mapdiscovery.e2e.ts`, notes in docs/design-v1-maps-vision.md (question 16) and docs/design-v1-per-player-vision.md (decision 8, 6.4, risk 4) saying D-261026-29 replaces them because the owner asked for explored ground as last seen (MD-O-26), FEATURES.md and the DM guide for part A | MD2, beside MD3, e2e after MD3 |
| **MS1 Scene setup** | `client/features/scenes/NewScene.tsx`, `create.ts`, `client/features/uvtt/ImportDialog.tsx`, `client/features/vision/*` (Players see, `UvttLightChoice.tsx`, the fold, Fog moved in from SceneSettings.tsx:78, the warnings, `moveWarning.ts`), new `client/features/vision/CopySettings.tsx`, `client/features/settings/form.ts` and `client/panels/SettingsPanel.tsx` (New scenes), `server/rooms/undoLabels.ts`, `e2e/scenesetup.e2e.ts`, FEATURES.md and the guide | MD1's setting field |
| **MS2 Settings page** | `client/features/scenes/SceneSettings.tsx`, `client/components/Panel.tsx` (`Section` folds), `client/features/movement/SceneSetting.tsx`, `client/features/phases/PhasesSection.tsx` placement, the alignment roots of 9, e2e steps that open folded groups, FEATURES.md and the guide | MS1 |

- MD2 and MS1 run beside each other once MD1 lands. MD3 and MD4 follow MD2. MS2 follows MS1. HX-3 may touch `client/features/settings/form.ts`: MS1 adds its group on its own lines at the end.
- **Property tests (MD2).** Random rooms of 1 to 8 players, whole party and per player, random builds (cells, edges, doors, secret doors, windows, free walls crossing chunks, heights, stair runs, rough, labels, stamps, both automatic walls rules, chunk-border rooms beside unbuilt chunks), random sight, reveals, hides, resets, switches, DM edits in and out of sight, moved labels, undo, blackouts, member changes, duplicates and imports.
  - MX1: no player holds any piece of geometry on a cell their sight or a reveal never reached, except visible free doors and windows, by an oracle recording every cell each viewer ever held.
  - MX2: each held element equals its value at the viewer's last sight of it, or live in sight or revealed. The oracle models the accepted exceptions: vision or fog off, Fog all, the fold, a door touched by a player sharing that memory, a DM-only stamp, forgotten tiles (MD-O-22).
  - MX3: events applied to each snapshot equal `projectState`.
  - MX4: where the swept core touches no unheld cell, the device's answer equals the server's, the chunk-border ledge and corner cases included.
  - MX5: no player projection holds memory, and replay rebuilds it. MX6: fog off gives today's bytes.
- **Mutants** each a test must fail on: chunks projected once per scene, `known` left out, stubs left out, the device deriving automatic walls, a hidden door on an auto edge as a gap, free walls sent whole, a hidden door left whole, an entry dropped by a hide while held, forgetting by cells, memory written behind a blackout as seen, a holder's memory from the shared sight, the generic words read from the shared fog, a stopped walk refused in place, an area reaching past held ground, corners from fog alone, the memo keyed without memory or the stair map.
- **e2e.** `e2e/mapdiscovery.e2e.ts` on a port offset no other file uses, with Ben's phone and a table display, steps md-1 to md-8 as in section 10, every frame Ben's page and the display received judged as in pervision's pv-8. Run with `reach`, `vision`, `pervision` and `iso`. `e2e/scenesetup.e2e.ts` ss-1 to ss-3. Each lane's last commit changes FEATURES.md and the DM guide for its part, with new screenshots.

## 14. Out of scope and follow-ups

Cutting the map image per player (PV-IMAGE). Isometric's undimmed walls with fog off (ISO-DIM). A DM view of where players' memory differs from the build. Memory for pins and found traps. Templates the DM manages.

## 15. As built

The builders fill this in, lane by lane, with every place the build went its own way.

## 16. Review dispositions

**Round 1**, all adopted, D-261026-29 settling the four owner questions and the movement rule.
- Touch rule replaces M4 (decision 11, 6, rules 6 and 9, risk 1, 10, MX4): MD-O-3, MD-O-4, MD-O-12, MD-O-31, MD-O-32, ASTRA-2, LK-3, LK-5, LK-14, LK-17, LK-18.
- Free walls clipped (decision 2, 5.2, rule 1, MX1): ASTRA-1, LK-1, MD-O-33, and MD-O-22's MX1 point kept strict.
- Secret door on an auto edge (5.2): MD-O-1. Border walls and ledges by stubs (decision 14, 5.2): MD-O-2, LK-8, LK-12.
- Hides and tile forgetting (5.3, 5.4): MD-O-5, MD-O-30, LK-2, LK-19, MD-O-16. The builder's ask (5.3): MD-O-34.
- Door ops (6, 5.3): MD-O-6, LK-4. Areas (decision 13): MD-O-11, LK-15. Corners (decision 12, risk 5): ASTRA-3, LK-6, MD-O-13, LK-13.
- Precedence (decision 6, risk 4): LK-7, MD-O-23. Stairs (5.2, 5.3, 5.6): ASTRA-4, MD-O-8. Auto versus drawn (5.3): MD-O-7. Moved entities (5.3): MD-O-9.
- Ids, art and DM-only stamps (5.4): ASTRA-5, ASTRA-6, MD-O-10. Map export (4, rule 3, MD3, MD4): ASTRA-7, LK-10, MD-O-17. Deploy reserve (5.5): MD-O-14. Hexes (5.5): MD-O-15, LK-11.
- Part B (8): MD-O-18, LK-9, MD-O-19, MD-O-27, MD-O-28, MD-O-29. Fan-out (5.6): MD-O-24, MD-O-25. Sizes (5.5): MD-O-20, LK-16. Bench (7): MD-O-21. Stale docs (MD4): MD-O-26. The movement.ts path (4).
