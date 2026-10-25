# raccoon-vtt v1: per-player vision

Status: draft 2, 2026-10-25, revised for design review round 1 (section 15 maps every finding to its fix) and D-261025-12. Code is cited from `main` at `cf98b4be`. It extends docs/design-v1-maps-vision.md section 4.3 ("the vision addendum") and docs/design.md sections 7.3, 9.10 and 13.6, and follows their rules: server-authoritative state, per-viewer projection as the security boundary, exact arithmetic, bounded everything.

## 1. The owner's words

- The project owner, 2026-10-25, after hearing that per-member sight was never added: "Once done with your current scope of work I'd like you to add support for per player vision (toggleable between whole party and per player by the dm) and also hex grids (keep square as the default though)."
- And right after: "Any designs these can be done ahead of time should be"
- D-261025-7 and its amendment: a DM switch per scene beside Party vision, whole party by default, so nothing changes for existing scenes. It amends the vision addendum's question 1 (party vision, 2026-10-14), which stays the default.
- D-261025-12 (this design's round 1): explored ground on a per-player scene is per player, the DM's reveals and hides apply to every player, and labels, stamps, pins and doors on explored ground follow each player's own layer, with the cost bounded. A player's auto-route treats a creature only that player sees as it treats a creature under fog: not a blocker. An aura's reminder reaches each player who sees both the creature and the area.

## 2. Summary

- **A per-scene choice under Party vision**: Sight, "Whole party" (today, the default) or "Per player", stored only while per player.
- **Sight holders.** On a per-player scene at most 6 players (`LIMITS.sightHoldersPerScene`) see through their own creatures. Each holder's sight is the **shared sight** (creatures marked "Shares sight with the party") plus their own sources. Everyone else, a table display included, has the shared sight. The **union** of every source is today's party sight and serves the DM.
- **Memory per holder.** Each holder has an explored layer of their own beside the party's. A player's fog is the DM's layer, the party's layer and their own. The shared sight explores into the party's layer.
- **Each player's projection reads their own sight and fog**: creatures, rows, areas, rulers, drag frames, log lines, labels, stamps, pins and found traps.
- **Public rules read only what every viewer shares**: the shared sight and the shared fog (the DM's layer and the party's). Refusals, limits, traps going off, attach groups and turn sharing, routes and shared rulers stay the same on every device.
- **History marks become sets**: stops, turn starts, turn lines, HP and condition lines, area reminders and rolls gain `seenBy`, the holders who saw them. DM only.
- **Measured cost** at the caps on a development laptop: a holder adds 0.4 to 0.9 ms to a batch, and the worst row, a light every holder sees, is why the cap is 6.

## 3. Decisions, with rejected options

Asking the owner is off, so each choice the words and D-261025-12 leave open is a guess at the owner's likely answer.

1. **Whose sight a holder has**: the sources they own, directly or through a character (`ownsToken`), so their character, its companions, a lent monster or NPC and a shared character, plus the shared sight. Rejected: tokens a player may only move under `playersMoveAny`, and companions lending to the whole party.
2. **"Shares sight with the party" lends to every player**, owned or not. Rejected: only to an owner.
3. **The party still always sees each other**: every party member stays shown to every player (design 13.3). Rejected: allies following each player's sight, which hides friends on a phone and feeds `aboveFog` into the public rules.
4. **At most 6 sight holders per scene**: the players with a layer there, then, while fewer than 6, players who own a lending source, in the source cap's order, each source's owners by member id. The cap is the largest the light row of section 8 passes. Rejected: 12 (the source cap), whose light row measures 14 ms at the gate's ratio against 10 ms.
5. **A player who is not a holder sees the shared sight and the shared fog**: one whose creatures are down, hidden or past the cap, one with none here, one past the 6, and one who joins later. Rejected: the union, as a spectator.
6. **A table display has the shared sight and fog**, as the player who owns nothing it is (design 7.3). Rejected: the union on the TV.
7. **Explored ground per holder** (D-261025-12). Rejected: one shared layer (every player watches another's live field of view, a light's trail, labels and pins), and exploring from the shared sight only (players remember nothing).
8. **Whole party pools memory, Per player starts from the pool.** Switching to Whole party folds every holder's layer into the party's. Switching to Per player starts every holder from the party's layer. Rejected: layers kept apart under Whole party (whole party would not share), and copying the pool into each layer (bytes for nothing).
9. **Doors are drawn on each player's own ground, and their state stays map knowledge.** A player's fog hides doors on ground they never saw, as it hides the map. The door states in the build chunks stay the same for every player, as design 13.5 and the addendum's question 16 accepted. Rejected: masking door states per player, which gives each device a different wall set, so routes, drags and shared rulers would disagree between devices and with the server.
10. **One tracker order**: the room's, each player getting the rows they may see, renumbered with no gap, and "Another creature's turn" for a row they cannot see. Rejected: a per-player order.
11. **Seen by all means the shared sight and fog.** On a per-player scene `seenByNonOwners`, `inSightOfNonOwners`, `seenAtEvery` and `rowSeenByNonOwners` read them. Rejected: the roster's intersection: a display and a later joiner are viewers too.
12. **Routes keep to shared ground and pass creatures only some players see** (D-261025-12 for creatures, the same rule for ground). A holder's auto-route treats ground only they remember like unexplored ground. Rejected: routes over a holder's own memory, whose corners and trap spots other players would see.
13. **Per-player history only where players read history**: stops, turn starts, turn lines, HP, rest, concentration, effect, use, death save and life lines, area reminders and rolls. Rejected: per-player trap perception, found marks, route corners, joined legs, turn sharing and drag cost, which are public rules.
14. **View as a player asks the server** on a per-player scene for that player's whole projection. Rejected: swapping only the sight (the preview would miss that player's own lines and fog).
15. **The DM's own tools read the union**: Party sight, the Outliner, the tracker's "visible" add, the move warning and the trap notice. "The party" there means any player.
16. **No player-side notice** when a player's creatures cannot see, as under party vision today.

## 4. Today

One `PartySight` per scene (`shared/rules/vision.ts` `partySight`, through `shared/ruleHooks.ts`), the union over at most 12 sources, read through `partySightOf` and `sightReader` (project.ts:202, 328), which take no viewer. `withheldFromPlayers` (project.ts:367) is the one rule under every token projection and "seen" helper. One explored layer per scene, merged into the fog every player gets (project.ts:258). The fan-out projects `sight`, `fog`, labels, stamps and chunks once per batch for all players (`SAME_FOR_EVERY_PLAYER`, fanout.ts:96). A player's device treats every token it holds as public (`publicToken`, walkWorld.ts:81). View as a player re-projects the DM's view on the device (preview.ts:21).

## 5. Audit: everything the server decides from sight or memory

"Own" is the viewer's sight and fog, "shared" what every viewer shares, "union" today's party sight.

| What a player may see or learn | Where it is decided | Reads today | On a per-player scene |
| --- | --- | --- | --- |
| A creature's token, its HP, conditions, name, image and asset grant | `tokenVisibleTo` (342), `visibleAssetIds` | party sight | own |
| Tracker rows, `tieOrder`, `activeEntryId` | `entryShown` (1282), `projectEncounterCtx` | party sight | own |
| A turn's start, path stops | encounter.ts:70, tokens.ts:651, `projectTurnStart`, `stopsForNonOwners` | one bit | `seen` or `seenBy` |
| Route corners, joined legs | tokens.ts:632, path.ts:99 | one bit | unchanged, shared |
| HP, rest, concentration, effect, use, death save, life lines | `Tx.about` (tx.ts:502), `creatureReach` | one bit | `seen` or `seenBy` |
| Turn lines and a take-back's row | encounter.ts:282, 487, 620, 642 | one bit | `seenBy`, `toSeenBy` |
| Rolls naming a token | dice.ts:44 | one bit | `seenBy` per roll |
| Area reminders | areaTriggers.ts:118, 127 | `seen`, `hidden` | `seenBy`: both creature and area seen (D-261025-12) |
| Log audiences and copies | `lineReader` (1523), `Tx.settleLog` | one sight for all readers | per reader, lists make party lines (6.4) |
| Areas, kept rulers, live rulers, drag frames | 698, `projectDrawingCtx`, ephemeral.ts:102, 129, 183 | party sight | own, per receiver |
| Pings, laser, focus, AoE previews | ephemeral.ts default | none | unchanged |
| Fog tiles | `projectFogCtx` (840) | DM and party layers | DM, party and own layers |
| Labels, stamps, pins, found traps | `fogReader` (223) | shared fog | own fog |
| Door states | `projectChunkForPlayer` (781) | map knowledge | unchanged (decision 9) |
| Door reach | permissions, actor's fog | shared fog | the actor's own fog |
| Routes, drags, shared rulers (public world) | walkWorld.ts:81, 142, 245 | the device's tokens and fog | `sightAll` and `fogAll` (6.5) |
| Traps going off, players' trap lines, found marks | traps.ts:167, rules/traps.ts:406, 1370, 1427 | seen by all | unchanged, shared |
| Attach groups, mounts sharing a turn, mount cost | permissions.ts:1368, attach.ts:230, encounter.ts:104, 124, tokens.ts:442 | seen by all | unchanged, shared |
| Movement's public pass, undo's silent passengers, copied rulers | moveLeg.ts:123, undo.ts:459, duplicate.ts:172 | seen by all | unchanged, shared |
| Explored ground written | explore.ts:27 | party sight | shared sight to the party's layer, each holder's to theirs |
| The trap notice (DM only) | trapNotice.ts:114 | party sight | union |
| Sight tiles | `projectSightCtx` (875) | party sight | own, plus `sightAll` |
| A player's guarded Next or Previous, "that is not here" | encounter.ts:392, `canApply` | the actor's view | the actor's own |
| Handouts, pages, roll requests, chunks | their own lists | none | unchanged |

## 6. The model

### 6.1 Sources, holders and three sights

- **Sources** are chosen as today (design 9.10), at most 12 per scene in the fixed order, so the union is today's party sight bit for bit.
- **Holders** are chosen by decision 4 from the committed state, the same on the server and on replay.
- **Sights.** The shared sight is the union over sources marked `partyVision`. A holder's sight is that plus the sources the holder owns. Only members of kind `player` hold one.
- **One level function.** A source's level at a sub-cell reads its polygon spans, its senses and the light rows. The raster and the point query both call it.
- **Groups.** Holders with the same own sources share one raster. A group's raster is kept only while a socket holds it or the explore step needs it, which is every batch on the player scene, so at most 6 groups and the shared sight are drawn.
- **Invalidation.** `compute` keeps, per source and per light, the tiles its old and new spans or runs met. A group redraws a tile when a source in the group, the shared sight or any light changed it, when the light rows changed there, and everywhere when the walls, the level, its own sources or the holder set changed. So a group's tiles always equal a cold computation, which the tests check per group.
- **A creature is in a player's sight** when any sub-cell under its footprint has a level above 0 for the player's sources (the squeezed footprint while it squeezes). The reducer's marks use the point query, the projection the group's raster.

### 6.2 Who sees what on a per-player scene

| Viewer | `sight` | `fog` | Also |
| --- | --- | --- | --- |
| A holder | shared plus own | DM, party and own layers | `sightAll`, `fogAll` |
| Any other player, a table display | shared | DM and party layers | `sightAll`, `fogAll` |
| A DM | the union | the DM's layer | `explored` (party layer), `exploredAny` (every holder's layer joined), `sightAll` |

`sightAll` and `fogAll` are the shared sight and fog, the same objects for every viewer, so devices judge "seen by all" alike (6.5). Players receive `vision.perPlayer` with the scene, which their devices need.

### 6.3 Explored ground per holder

- **Storage.** `RoomState.exploredBy`, keyed `"<sceneId>:<memberId>:<tx>,<ty>"`, values `{ sceneId, memberId, tx, ty, rev, bits }` in the fog tile's shape, written only by the server. The party's layer stays `exploredTiles`.
- **Bound.** Only holders have a layer, so at most 6 per scene.
- **Explore.** After a batch that holds ops, on the player scene with vision and fog on and no blackout: shared-sight bits the party's layer lacks go into it, and each holder's own bits that neither the party's layer nor theirs holds go into theirs. One `sys.explore { sceneId, tiles, members?: { memberId, tiles }[] }`, only adding, replayed as stored. A holder is the only player whose own creatures explore.
- **A player's fog** is the three layers merged. A non-holder's is the DM's and the party's.
- **The DM's tools.** A reveal writes the DM's layer, so every player sees it. A hide also clears the party's layer and every holder's under its shapes, and `fog.reset` clears them all, outside any undo step, setting `global`, as today. The fog tool's hint is unchanged.
- **Readers of a player's own fog**: the fog they draw, labels, stamps, pins and found traps (the labels' rule), tokens under fog when vision is off, door reach (the actor's own), Fit map and the heights readout.
- **Readers of the shared fog** (`fogAll` on a device, the DM's and party's layers on the server): the public world of routes, drags and shared rulers (decision 12), "seen by all" on a fog-only scene, and the map export's player view, which draws what every player knows.
- **A player who gains a creature later** becomes a holder if a place is free, and their map starts from the party's layer. They never get another holder's memory. A holder whose creatures leave or die keeps their layer and place.
- **Switching.** To Per player: holders start from the party's layer, with empty layers of their own. To Whole party: the reducer ORs every holder's layer into the party's and removes them, outside the undo step, so undoing the switch does not split them again. Turning vision off keeps the layers and stops exploring, as today.
- **Members.** `sys.memberRemove` removes the member's layers, freeing their place.
- **Scenes, import and export.** Duplicating a scene with its fog copies every layer under the new scene id. Deleting a scene removes them. A room export carries `exploredBy`, and a room import maps scene and member ids, dropping a tile it cannot map (`server/rooms/remap.ts`). A Universal VTT import makes a whole-party scene.

### 6.4 The marks

- **`seenMark(state, token, env, scope)`**, scope `"here"` (the player scene's rule, `seenByNonOwners`) for log lines, `"anywhere"` (`inSightOfNonOwners`) for stops and turn starts. Behind a blackout, for `visibility: "dm"`, and under `"here"` off the player scene: no mark. Seen by all (party member, exempt, or in the shared sight or fog, `revealSeenAnywhere(env.opVersion)` as today): `{ seen: true }`. On a whole-party scene otherwise: no mark, today's `false`. On a per-player scene otherwise: `{ seenBy }`, the sorted ids of the non-owner holders whose projection shows the token (`tokenVisibleTo` with that player's context), present even when empty, so whether a container holds the field never depends on who saw.
- **Rows and areas.** A turn line's set is the holders whose encounter projection shows the row (`entryShown`). An area reminder's set is the holders who see both the creature and the area (its template in their projection). Its `hidden` mark now means only an area that is DM only or attached to a token no player sees.
- **Copies.** A path's first stop copies its turn start's marks, the list included (`startStop`, and attach's copies onto a mount's path).
- **Reading.** A non-owner gets a stop, start or line when it has `seen` or `seenBy` names them. `creatureReach`, `eventReach` and `diceRollReach` return the owners plus `seenBy`.
- **Party lines.** On a per-player scene a line that holds any list, on the event, a roll or `toSeenBy`, settles as a party line, never as a shared line with parts. `Tx.settleLog` then strips the lists from the DM line, and each copy is the reader's view.
- **One strip.** `projectEventCtx` removes `seenBy` and `toSeenBy` with one allowlist step at its top and per roll in `projectDiceCtx`, and a reader named in a list gets `seen: true`. `stopsForNonOwners` and `projectTurnStart` already drop marks (path.ts:201, 223, 241), and `seenBy` joins them.
- **`lineReader`** builds each reader's context with that reader's own sight and fog, and its any-player reader with the shared ones.
- **Unchanged one-bit marks**: `routeSeen`, `joinedUnseen` (a stop seen only through a list is not seen by all), the trap line's indexes, `trapSeen.by` and `perceived`.

### 6.5 What each device reads

| Reader on a player's device | On a per-player scene |
| --- | --- |
| The map, sight overlay, fog, labels, stamps, pins, tracker, token panel | its own projection |
| Drop notes (dragNotes.ts:59) | own sight: "out of your sight now" |
| `publicToken` and `seenWhereMoved` (walkWorld.ts:81, 245) | a token without `aboveFog` is public only where `sightAll` covers it |
| `publicWorld` ground (walkWorld.ts:152) | `fogAll` |
| Attach walk and list, the drop, the walking ruler (attach/walk.ts:24, attach/list.ts:153, movement/drop.ts:105, measure/walkRuler.ts:244) | through walkWorld, so `sightAll` and `fogAll` |
| The reducer's predicted marks | `sightAll` and `fogAll`, never a list |
| Door reach before sending | own fog |

A table display's own sight and fog are already the shared ones. A DM's device keeps the union for its tools and reads the shared fog from the DM's and party's layers, as today.

### 6.6 Storage, versions and migration

```ts
Scene.vision?: { on: boolean, light: LightLevel, perPlayer?: true }   // stored only while true
RoomState.exploredBy: Record<string, FogTile & { memberId: MemberId }>
PathStop, TurnStart, AboutCreature, area event, DiceRoll: seenBy?: MemberId[]
turn event: seenBy?: MemberId[], toSeenBy?: MemberId[]
```

- **Snapshot version**, the next free one (24 at `cf98b4be`): the state schema learns the fields, and the step adds an empty `exploredBy`.
- **Op version**, the next free one (23 at `cf98b4be`). From it, a `vision` patch without `perPlayer` keeps the stored value and `perPlayer: false` clears it, so the Party vision switch and the Light control keep the choice. `withPhaseLight` spreads `scene.vision`, so a phase switch, a phase list change and an import keep it too (phases.ts:78, 106, 122, room.ts:171, remap.ts:673). `sys.explore` takes `members`. No op before it ran on a per-player scene, so replay keeps every older mark.
- **Undo**: the switch is an ordinary scene edit with its own names in `server/rooms/undoLabels.ts`, "making sight per player on the scene Crypt" and "making sight whole party on the scene Crypt". `isGlobalChange` compares `perPlayer`.
- **Import**: paths are not imported (remap.ts:343). The turn starts of the encounter and of every `encounterHistory` snapshot keep their lists through `memberList`.
- **Existing rooms** need nothing else: a scene is whole party until the DM chooses otherwise.

### 6.7 Accounting that reads no list

Whether a list names a player, and how much a holder explored, depend on that player's sight. So no measure the size guard takes may read them:

- **Layers.** On a scene with `perPlayer` stored, the party's layer and 6 holder layers each count at their widest, every tile of the scene present, whatever they hold, exploring or not. Measured: 149,045 bytes for the party's layer of a 200 x 200 scene with a 64-character id, 162,227 for a holder's, 1.12 MB for all 7. A fold measures exactly again, since every player then shares it.
- **History.** Every stop and turn start that carries a `seenBy` field counts at its widest, wherever it lives now (any token's path, `encounter.turnStart`, every `encounterHistory` snapshot's), whatever has changed since: as if it named the 6 longest encoded player ids on the roster. With the room's UUIDs that is about 250 bytes a stop and 12 KB a full path of 50, at most 414 bytes a stop with 64-character ids. The roster is public.
- **Lines.** A line that depends on a list is a party line, which the measures never count (6.4), so no shared line carries a part that depends on sight.
- **The DM's projection.** `exploredAny` and `sightAll` count at their widest in the projected scene check, beside `sight` (sizeGuard.ts:237).
- **Lists stay within the roster.** `sys.memberRemove` scrubs the member's id from every list, so a list never outgrows the widest.
- **Initialization.** A loaded room computes the reserves once from its state, cached by object identity, and each op adjusts them.
- **Refusal.** The switch to Per player is refused when the reserves do not fit: "The room is too full for per-player sight on this scene: each player's map and the paths this fight recorded need room. Delete unused scenes to free space."

## 7. Proposal

### 7.1 The switch

In a scene's Vision settings (`client/features/vision/VisionSettings.tsx`), right under the Party vision switch, shown while Party vision is on or `perPlayer` is stored:

- A row **Sight** with two options: **Whole party** (the default) and **Per player**. Help, Whole party: "Every player sees what any party creature sees, and the party shares one map." Per player: "Each player sees only what their own creatures see, and creatures that share sight with the party. Each player keeps their own map of where they have been. At most 6 players per scene."
- The Party vision switch's "On:" help on a per-player scene: "On: each player sees only what their own creatures see, by their senses and the light around them."
- Busy: the switch is busy only for a pending change of `on`, the row only for one of `perPlayer`. After about 200 ms the row's help reads "Working out what each player sees…" or "Working out what the party sees…".
- **Who lends sight** on a per-player scene: each lending row ends "Lends its sight to Ana", "Lends its sight to Ana and Ben" or "Lends its sight to every player". A player past the 6: "Gus sees only what creatures that share sight see here: at most 6 players see by their own creatures on one scene." Under the list: "Players without a creature that lends sight here, and the table display, see only what creatures that share sight with the party see."
- **A mount not every player sees** (Fable's note on decision 11): a creature a party member rides that is neither always visible nor sharing sight gets "Thorn rides Horse, which not every player sees, so they share no turn. Make Horse always visible to keep it."
- The row sits under the switch it qualifies, not at the end of the section. In code it is added on its own lines.

### 7.2 Flipping mid-session

- The edit sets `global`, so every viewer is projected again. Each holder gets their own sight and fog, a creature they cannot see leaves their map with its row, areas and kept rulers, and "Another creature's turn" shows while it acts. Going back, the layers fold (6.3) and everyone gets the union.
- Lines a player holds follow the read-time rule (design 7.3). Nothing written is rewritten: marks keep their readers after any switch.
- Held drag previews and live rulers are judged again at once. `previewsSent` (connection.ts:81) keeps the last frame each receiver got, so a `global` batch re-judges it and sends `dragCancel` or `rulerEnd` to each receiver that may no longer have it.
- The turn, the order, the DM's layer and the chunks are untouched.

### 7.3 What stays shared

The DM's fog layer, the party's layer, the chunks and their door states, the party's tokens, the order and `started`, the turn under way, handouts, chat, the roster, and every public rule of decision 11.

### 7.4 View as a player

- On a per-player scene, View as a player opens a **preview socket**: a second socket on the DM's grant whose `hello` carries `as: <memberId>`. The server projects the room for that member as a player (its sight, fog, log copies, everything) and fans out to it as to that player. Its archive pages come from the log endpoint with `as` on a DM grant (`server/http/log.ts`).
- It is read only: any `op`, `eph` or `scene` on it closes it with `4003`. It is in no presence list and counts as no member's socket. Its `hello` goes through the snapshot budget, and switching player sends a new `hello`.
- The preview draws only its own snapshot. Until it lands, the shared indicator after 200 ms reads "Loading what Ana sees…", and after 10 s with no snapshot, or a dropped socket, "Could not load what Ana sees. Close and try again."
- The DM's own socket and tools are untouched while the preview is open. On a whole-party scene the preview stays as today.

### 7.5 Projection and fan-out

- **Keys**: `sightAll:`, `fogAll:` and `exploredAny:` keyed `<sceneId>:<tx>,<ty>` like `sight:` and `fog:`, in maps of the same names. `allKeys` and `sightKeys` list them. `exploredBy` is never projected under its own key: a write to it brings the `fog:` key at its tile (per viewer) and `exploredAny:` (DMs).
- **Ctx** carries per viewer `sight(sceneId)` and `fogged(sceneId, cx, cy)`: own for a player, the union and the DM's layer for a DM. `partySightOf` keeps its name and means "seen by all": the union on a whole-party scene, the shared sight on a per-player one. `visionRules` gains `holderSight` and `unionSight`.
- **Fan-out**: on a per-player scene `sight`, `fog`, `label`, `stamp`, `pin` and `trap` leave `SAME_FOR_EVERY_PLAYER` and are projected once per group, each changed tile hashed once per group. `sightAll`, `fogAll` and chunks stay in it. `KEPT_AS_VALUES` (fanout.ts:166) adds `sightAll`, `fogAll` and `exploredAny`. `changedSightKeys` diffs the union, the shared sight and every group, and `tileDependents` takes their changed tiles together.
- **Ephemeral**: DM receivers get every frame, as today. For players, `withheld()` (ephemeral.ts:183) is worked out per group. Its walker test keeps "seen by all", its spot test reads the receiver's sight.

## 8. Cost and risk

### 8.1 Measured

On a development laptop with Node 24, at the vision gate's caps (`capRoom` of scripts/bench-vision.ts: 200 x 200 cells, 6,000 sight pieces, 12 sources with 150 ft darkvision in one hall, 100 free lights and 20 carried, each 120 ft), one source marked to share sight, 12 groups each holding that source and one of its own, medians of 5 to 61 runs. The scratch prototype draws group tiles from the union's own polygons and light rows with vision.ts's own `renderTile`, as 6.1 specifies. Not committed. The gate's ratio to the server box is 1.4 (`scripts/bench-vision.ts`).

| Row (server budget) | Union today | Added by groups | Total at 6, at the ratio |
| --- | --- | --- | --- |
| Own source moved, bright (25 ms) | 3.6 ms | its group 0.4 ms | 5.6 ms |
| Own source moved, dark (30 ms) | 7.3 ms | its group 0.5 ms | 10.9 ms |
| Shared source moved, bright (25 ms) | 3.8 ms | 12 groups 5.7 ms | about 9.4 ms |
| Shared source moved, dark (30 ms) | 8.2 ms | 12 groups 7.1 ms | about 16.5 ms |
| A light every source sees, dark (10 ms) | 5.1 ms | 5 groups 1.8, 6 2.1, 7 2.5, 12 4.9 ms | 10.1 ms (5 groups: 9.6, 12: 14.1) |
| A door every source sees (250 ms) | 36.3 bright, 60.9 dark | 12 groups 9.5, 11.0 ms | about 93 ms |
| Every source moved at once (250 ms) | 28.5 bright, 41.8 dark | 12 groups, whole scene, 11.0 ms | about 67 ms |
| Every tile of every group: the switch, a phase or level change (250 ms) | (cold 126 ms, addendum) | 12 groups 9.8 bright, 10.9 dark | about 184 ms |
| 500 creatures judged for 12 players | | 0.9 ms | |
| Explore bits for 12 holders, every tile | | 2.3 ms | |
| Sight fan-out: every group's tiles hashed once (10 ms) | | 12 groups 2.2 ms | 3.1 ms |
| A group's encoded tiles held | | 46 KB each, 553 KB for 12 | |

- **The cap.** Only the light row fails at 12. At 6 it sits on the line on the laptop, so the server-box gate (`scripts/bench-server4.ts`) runs it at 6, and `sightHoldersPerScene` drops to 5 if it fails there. The other rows pass at 12 with room.
- **Per player per op**, a full room of 8 players and 500 tokens: the token projections exist today. Each holder adds its raster's dirty tiles and 500 in-sight tests, under 1 ms. Each mark asks at most 6 holders.
- **Bytes at the caps.** One sight map at its largest is 245,050 bytes. The DM's projection adds `exploredAny` (149 KB) and `sightAll` (245 KB) to today's chunks (1.0 MB at the caps), DM layer, party layer and sight: about 1.95 MB of the 3 MiB projected scene. A player's projection holds two fog and two sight maps, less than the DM's. The stored state holds 1.12 MB for a 200 x 200 per-player scene's layers (6.7) of the room's 8 MiB, about 40 KB for a 40 x 30 one. That fits, so per-player scenes keep the room's limits. A room with several large per-player scenes reaches its 8 MiB sooner, with the refusal of 6.7.
- **Log rings.** Lines about creatures some players see become party lines: a copy per reader (each member keeps 50, against 200 shared lines) and a DM half that fills the DM's ring of 200. Both live logs shorten, and older lines stay in the archive.

### 8.2 Every seen bit that becomes a set

| Mark | Lives in | Bound and accounting |
| --- | --- | --- |
| `PathStop.seen` | token paths | 6 ids, 50 stops a path, counted at widest (6.7) |
| `TurnStart.seen` | `encounter`, every `encounterHistory` snapshot | 6 ids, counted at widest |
| `AboutCreature.seen`, area `seen`, `DiceRoll.seen` | log | party lines, stripped when settled |
| `turn` `seen`, `toSeen` | log | `seenBy`, `toSeenBy`, party lines, stripped when settled |

### 8.3 Risks

1. **The boundary grows.** Visibility now reads ownership, holders and four layers. The oracle tests of section 10 are the guard.
2. **Public rules see less.** On a per-player scene a creature outside the shared sight is unseen by every public rule, as one under fog: a DM's horse a character rides shares no turn, a monster's trap goes off unperceived, and route corners stay hidden. The DM marks such a creature always visible or sharing sight, which the settings flag (7.1) and the guide explains.
3. **Routes are shorter-sighted.** A holder's auto-route keeps to ground every player knows and walks through creatures only they see.
4. **Door states are map knowledge.** A door that opens on ground a player never saw changes their data, as under party vision today (decision 9).
5. **Six holders.** A table of more than 6 players on one scene leaves the rest with shared sight. The DM frees a place by switching to Whole party and back, which pools the maps. Who holds a place can rest on a lent creature's owner, which other players do not see, so a player past the cap learns only that six places are taken.

## 9. Security rules

1. A player's projection judges creatures by that player's sight and their fog by that player's layers, from the committed state. It never reads another player's sources or layer.
2. Every public input reads only the shared sight and the shared fog: refusals, limits, traps, attach groups and turn sharing, routes, drags and shared rulers, copied rulers, undo's silent passengers, and on a device `publicToken`, `seenWhereMoved` and the public world's ground.
3. `seenBy`, `toSeenBy`, `exploredBy` and `exploredAny` reach DMs only. A reader's copy says `seen: true` and holds no list. A line holding a list is a party line.
4. A player gets a past stop, start or line only when they own the creature, it was seen by all, or a list names them. A later joiner and a table display get only what was seen by all.
5. No mark or list is written behind a blackout, for a hidden token, or off the player scene under the `"here"` scope.
6. Only the server writes marks and layers. A device's marks are predictions, replaced by the batch's `ev`, and never lists.
7. `sightAll` and `fogAll` are the same for every viewer and never hold a holder's own sight or layer.
8. A preview socket projects one player for a DM, refuses every write with `4003`, and is no member's presence.
9. Drag frames, live rulers and their cancels are judged per receiver by the receiver's sight.
10. Fail closed: on a player's device, missing or unreadable `sight` or `sightAll` tiles see nothing, and missing `fog` or `fogAll` tiles are fully fogged.
11. No measure reads a list or a layer's contents (6.7).
12. With Sight on Whole party, every byte and mark is today's, and the existing replays pass unchanged.

## 10. Tests

- **Rules (PV2).** Each group's raster equals a cold computation over its sources after random moves, lights, doors, levels, ownership and holder changes (incremental equals cold, per group). The union of every group and the shared sight equals today's party sight on the gate's scenes and random ones. The point query equals the raster on random footprints, squeezed and Tiny included. Golden bits for one per-player scene. The banned-functions test covers the new code. Holders follow decision 4.
- **Property test (PV1)**, random rooms of 1 to 8 players with shared characters, lent monsters, companions, shared-sight creatures, more than 6 would-be holders, down and Blinded sources, walls, lights and all three levels, under random ops that include both switches and their undo, phase switches, phase list and light changes, fog reveals, hides and resets, ownership changes, members joining and leaving, Next and Previous with a resumed row, mixed dice lines and blackouts:
  - For every viewer, its events applied to its snapshot equal `projectState`, the display included.
  - No player's projection holds a creature, label, stamp, pin or trap that player's own sight or fog would not give them, by an oracle that recomputes both from nothing.
  - No stop, start, line or roll reaches a player who neither owned the creature nor saw it when it was written, by the oracle's record.
  - No player's data holds `seenBy`, `toSeenBy`, `exploredBy` or `exploredAny`, and `sightAll` and `fogAll` are equal for every viewer.
  - A phase switch, a phase list change, the Light control and the Party vision switch never change `perPlayer` (also a unit test each).
- **Differential (PV1, shared/differential.ts).** Paired rooms that differ only in what holder A's creatures see or explored: B's and the display's `ev` streams, drag frames, refusals and limit answers are identical, except for the DM's own edits. A variant compares only the public inputs of A's own drag (route, op and search inputs), which `checkPair`'s guard (differential.ts:106) would otherwise skip. A measure row runs the pairs a few bytes under the room's limit.
- **Marks (PV1).** Each scope, no list behind a blackout or for a hidden token, `seenBy` sorted and present when empty on a per-player scene, absent with `seen`, scrubbed on member removal. Golden replays of turns and moves on inactive whole-party scenes pass unchanged.
- **Server (PV3).** Two players in different groups on one per-player scene receive different `sight` and `fog` in one batch, and the display only the shared ones. The preview socket projects its member, refuses writes with `4003` and stays out of presence. Size guard rows for every container of 6.7 and the switch's refusal. Import maps lists and layers. Ephemeral frames are judged per receiver, and held previews cancel on the switch.
- **Bench (PV2).** `scripts/bench-vision.ts` and `scripts/bench-server4.ts` gain every row of 8.1 at 6 groups, gated at the budgets shown.
- **Mutants**, each a test must fail on: the union in a holder's place, `sight` or `fog` left in `SAME_FOR_EVERY_PLAYER`, a list keeping an owner, a copy keeping `seenBy`, a shared line keeping a list, `partySightOf` reading the union on a per-player scene, `publicToken` reading `sight`, the public ground reading own fog, the ephemeral spot test read once for all players, a list written behind a blackout or for a hidden token, a fold left out, a measure reading a real list, and `withPhaseLight` dropping `perPlayer`.
- **e2e (PV5)**, `e2e/pervision.e2e.ts`, two players on one dark scene, steps `pv-1` on: (1) Per player: Thorn's player sees a goblin in Thorn's torchlight and its row, Bree's player sees neither and gets "Another creature's turn". (2) Ground Thorn explores stays under Bree's fog, with a label in it. (3) View as Bree shows no goblin and no label, View as Thorn both, each after its loading line. (4) A Night phase switch keeps Per player. (5) Whole party: the goblin and Thorn's ground appear for Bree, and back to Per player they stay pooled. (6) No frame Bree's page received held the goblin or the label while per player, and no page logged an error. Run with `reach`, `vision` and `display`. `e2e/alignment.e2e.ts` adds the Vision section as a root.

| Case | Expected | Test |
| --- | --- | --- |
| An existing scene, a backup from before | Whole party, today's bytes and marks | migrate, golden replays |
| Goblin in Thorn's torchlight only | Thorn's player gets it, Bree's player and the display do not | property, e2e pv-1 |
| A label in a room only Thorn explored | Bree's player has neither the label nor the ground | property, e2e pv-2 |
| Bree's player opens devtools | No goblin, row, label, list, layer or frame | property, e2e pv-6 |
| The DM reveals or hides a room | Every player gets it, every layer cleared under a hide | property |
| A creature marked to share sight | Every player sees and remembers what it sees | rules, property |
| A seventh would-be holder | Shared sight only, named in the settings | property |
| Thorn is Unconscious | Thorn's player sees the shared sight and keeps their map | property |
| A player joins mid-fight | Only what was seen by all, the party's map | property |
| Switch to Whole party and back | Pooled maps, union, then each starts from the pool | property, e2e pv-5 |
| A Night phase switch, the Light control | Per player kept | unit, property, e2e pv-4 |
| Thorn's player drags Thorn past a goblin only they see | The route ignores it, the server agrees, others see nothing of it | differential |
| HP line or roll about the goblin seen only by Thorn's player | A party line, no list in anyone's data | marks, property |
| An aura on the goblin hits Thorn | Thorn's player gets the reminder, Bree's player does not | property |
| A room near its byte limit, ops by Bree's player | The same answers whatever Thorn's creatures saw | differential measure row |
| The switch mid-drag | Players who may no longer see the drag get its cancel | PV3 |
| A write on a preview socket | Closed with `4003` | PV3 |
| A light every holder sees, 6 holders at the caps | Within 10 ms on the server box, else the cap drops to 5 | bench |

## 11. UI checklist

- **Words**, exactly as in 7.1 and 7.4, the undo names of 6.6, the refusal of 6.7, and a player's drop note on a per-player scene: "Goblin is out of your sight now." or "3 creatures are out of your sight now." (`intoFogText`).
- **Loading.** The Sight row is busy and refuses a second tap until acknowledged, with the shared indicator after 200 ms. The preview waits as 7.4 says and ends in its view or its error.
- **Keys and focus.** The row is a radio group: Tab reaches it, arrows move, focus stays through the change and its busy state. No new shortcut, so the shortcut sheet and FEATURES.md's key list are unchanged.
- **Screen readers.** The group is named "Sight" and described by its help. Busy sets `aria-busy`, the working line and the preview's lines are polite statuses.
- **Large interface sizes.** At 130% the two options stay on one row at 320 px or wrap whole. `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px: the Vision section (new root) and the preview's loading state.
- **Phones.** The existing settings sheet, 44 px targets, nothing on hover or long-press.

## 12. Lane plan

| Lane | Owns | After |
| --- | --- | --- |
| **PV1 Contract, marks and memory** | `shared/model.ts`, `shared/protocol.ts`, `shared/keys.ts`, `shared/migrate.ts`, `shared/ruleHooks.ts`, `shared/limits.ts` (the cap), `shared/project.ts` (per-viewer `Ctx`, `seenMark`, readers, the strip, `lineReader`, new keys, fog merges, `changedSightKeys`, `tileDependents`), `shared/rules/path.ts`, `shared/rules/walkWorld.ts`, `shared/reducer/tx.ts`, `room.ts` (the merge rule, the scrub), `phases.ts`, the fog reducer (hides and resets over every layer, the fold), the mark writers in `encounter.ts`, `tokens.ts`, `dice.ts`, `areaTriggers.ts`, `attach.ts`, `trapNotice.ts`, `shared/differential.ts`, `server/rooms/stateSchema.ts`, `server/rooms/undoLabels.ts`. Unit, property and differential tests, rules stubbed through `visionRules`. | the current scope |
| **PV2 Rules** | `shared/rules/vision.ts` (holders' groups, shared sight, the level function and query, per-group invalidation, lazy rasters, cache bytes), tests, `scripts/bench-vision.ts`, `scripts/bench-server4.ts` | PV1's hook types |
| **PV3 Server** | `server/rooms/fanout.ts`, `ephemeral.ts`, `connection.ts`, `actor.ts`, `ws.ts` (the preview socket), `server/http/log.ts` (`as`), `sizeGuard.ts`, `remap.ts`, `explore.ts`, `server/rooms/pervision.itest.ts` | PV1, PV2 |
| **PV4 Client** | `client/features/vision/*` (the Sight row, the list, `settings.ts`'s patches), `client/features/dm/preview.ts` and `PlayerPreview.tsx` (the preview socket), the socket client, `client/canvas/dragNotes.ts`, `client/features/attach/walk.ts`, `attach/list.ts`, `movement/drop.ts`, `measure/walkRuler.ts`, `client/features/outliner/rows.ts`, `client/features/encounter/logic.ts` | PV1 |
| **PV5 Integration and docs** | `e2e/pervision.e2e.ts`, the Vision root in `e2e/alignment.e2e.ts`, docs/design.md (7.1, 7.3, 7.6, 9.10, 13.5, 13.6), docs/design-v1-maps-vision.md (4.3.2, 4.3.10), docs/features.md, `FEATURES.md`, docs/dm-guide.md (the Sight row, memory per player, the display, risks 2, 3 and 5, new screenshots), this note's As built | all |

PV2 and PV4 run beside each other once PV1's contract lands, and PV3 needs PV2. `pervision.e2e.ts` takes a port offset no other file uses. Each new test fails with its fix removed, by the mutants of section 10. FEATURES.md and the guide change in PV5's last commit only.

## 13. Out of scope

Door states remembered per player (decision 9). Traps found or perceived per player, and every other public rule per player (decision 13). Per-player light levels. More than 6 holders. A player-side notice when their creatures cannot see.

## 14. As built

The builder fills this in the lane's docs commit with every place the build went its own way.

## 15. Review dispositions, round 1

All findings adopted. SEC-1, PV-O-5, PV-ASTRA-4: memory per holder (6.3, decisions 7 and 8, the differential test). PV-O-1, SEC-2: device readers (6.5), PV1 and PV4 files, the public-input variant. PV-O-2: the merge rule (6.6) and its tests. PV-O-3: party lines and one strip (6.4). PV-O-4, PV-ASTRA-1, PV-ASTRA-2, SEC-5: accounting (6.7), the scrub, the measure row. PV-ASTRA-3, PV-O-6, SEC-6: invalidation (6.1), measured rows and the cap (8.1, decision 4). SEC-3, PV-O-8, PV-ASTRA-5: `seenMark` with its scope (6.4), golden replays. PV-ASTRA-6: the preview socket (7.4). PV-ASTRA-7, PV-O-7: area reminders (6.4). SEC-4: its mutant and the two-group test. SEC-7: "a player's device" and "table display" (6.2, 6.5). SEC-8: players receive `perPlayer` (6.2). SEC-9, PV-O-12, PV-O-13: the preview leaves the DM's tools alone, frame wording and `previewsSent` (7.2, 7.5), key grammar and `KEPT_AS_VALUES` (7.5). PV-O-9: import (6.6). PV-O-10: lane files (12). PV-O-11: busy states and help (7.1). PV-O-14: the DM's ring (8.1). Fable on decision 11: the mount flag (7.1) and the guide.
