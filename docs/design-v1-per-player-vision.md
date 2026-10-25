# raccoon-vtt v1: per-player vision

Status: draft 4, 2026-10-25, revised for design review rounds 1 to 3 (section 15 maps every finding to its fix), D-261025-12, D-261025-14 and D-261025-17. Code is cited from `main` at `cf98b4be`. It extends docs/design-v1-maps-vision.md section 4.3 ("the vision addendum") and docs/design.md sections 7.3, 9.10 and 13.6, and follows their rules: server-authoritative state, per-viewer projection as the security boundary, exact arithmetic, bounded everything.

## 1. The owner's words

- The project owner, 2026-10-25, after hearing that per-member sight was never added: "Once done with your current scope of work I'd like you to add support for per player vision (toggleable between whole party and per player by the dm) and also hex grids (keep square as the default though)."
- And right after: "Any designs these can be done ahead of time should be"
- D-261025-7 and its amendment: a DM switch per scene beside Party vision, whole party by default, so nothing changes for existing scenes.
- D-261025-12 (round 1): explored ground is per player, the DM's reveals and hides apply to every player, labels, stamps and pins follow each player's own layer, a player's auto-route treats a creature only that player sees as one under fog, and an aura's reminder reaches each player who sees both the creature and the area.
- D-261025-14 and its amendment (round 2): when more players could see for themselves than the cap allows, the DM picks who does in the Vision settings' list. View as a player never shows whispers between players. A player's own drag routes over the ground that player remembers, while shared and kept walking rulers keep to shared ground. View as a player uses the server's preview on every scene. The holders are an explicit list. The cap is 6 if the server box passes its timing row, else 5.
- D-261025-17 (round 3, superseding D-261025-15): on a per-player scene door states stay shared and live, as every scene sends them today, drawn only on each player's own explored ground. No door memory. The channel is an accepted risk, written in the risk list and the DM guide.

## 2. Summary

- **A per-scene choice under Party vision**: Sight, "Whole party" (today, the default) or "Per player". A **per-player scene** is one with `vision.perPlayer` stored, whatever `vision.on` says.
- **Holders.** At most 6 players per scene (`LIMITS.sightHoldersPerScene`) see and remember for themselves, by an explicit list the DM can change. A holder's sight is the **shared sight** (creatures marked "Shares sight with the party") plus their own sources. Everyone else, a table display included, has the shared sight. The **union** of every source is today's party sight and serves the DM.
- **Memory per holder**: an explored layer each. A player's fog is the DM's layer, the party's layer and their own.
- **Each player is projected alone**: creatures, rows, areas, rulers, frames, log lines, fog, labels, stamps, pins and found traps. Sight rasters are shared between viewers with the same sources. Door states stay the same for every player (D-261025-17).
- **Public rules read what every viewer shares**: the shared sight and the shared fog. So refusals, limits, traps, attach groups and turn sharing, and shared rulers are the same on every device.
- **History marks become sets**: stops, turn starts, turn lines, HP and condition lines, area reminders and rolls gain `seenBy`. DM only.
- **Measured** at the worst legal ownership (6 holders each owning 11 of the 12 sources): every row passes on the laptop at the gate's ratio, informational until the server box gates it.

## 3. Decisions, with rejected options

Asking the owner is off, so each choice the decisions leave open is a guess at the owner's likely answer.

1. **Whose sight a holder has**: the sources they own (`ownsToken`), so their character, its companions, a lent monster or NPC and a shared character, plus the shared sight. Rejected: tokens a player may only move, and companions lending to the whole party.
2. **"Shares sight with the party" lends to every player**, owned or not. Rejected: only to an owner.
3. **The party still always sees each other** (design 13.3). Rejected: allies following each player's sight.
4. **Holders are a list per scene** (D-261025-14). The step after each batch decides joins by ownership at that moment and records them in `sys.explore { join }`: a player joins the first time they own a seeing creature there, ticked while fewer than 6 are, else unticked. The DM ticks and unticks in the Vision settings. A fold and member removal take entries off. What was explored never changes the list. Rejected: holders derived from layers (a place would rest on what someone explored), and switching modes to re-choose.
5. **A player who is not a holder has the shared sight and fog**, and so does a table display (design 7.3). Rejected: the union, as a spectator or on the TV.
6. **Explored ground per holder** (D-261025-12). Rejected: one shared layer, and exploring from the shared sight only.
7. **Whole party pools memory, Per player starts from the pool.** The switch to Whole party folds every holder's layer into the party's and empties the holder list. Rejected: layers kept apart under Whole party, and copying the pool into each layer.
8. **Doors stay shared and live** (D-261025-17), drawn only on each player's own explored ground, as every scene sends them today. Rejected: per-player door memory, which round 3 found disclosed unseen doors when seeded, leaked private door knowledge through route corners, grew without bound and broke on import. It can come back as its own feature.
9. **One tracker order**, each player getting the rows they may see, renumbered with no gap. Rejected: a per-player order.
10. **Seen by all is what every viewer shares**: the shared sight with vision on, the shared fog with fog alone, everything with both off, party members and exempt tokens always. Rejected: the roster's intersection, since a display and a later joiner are viewers too.
11. **Routes** (D-261025-14 amendment): a player's own drag searches the ground that player remembers, and passes creatures only some players see. Shared and kept walking rulers keep to shared ground. A leg's corners reach a non-owner only where every spot of it is on shared ground, and an owner only where every spot is on ground that owner's own fog reveals. Rejected: routes on shared ground only, which find nothing on a typical per-player scene, and corners for every owner, which draw one co-owner's memory for another.
12. **Per-player history only where players read history**: stops, turn starts, turn lines, HP, rest, concentration, effect, use, death save and life lines, area reminders and rolls. Rejected: per-player trap perception, found marks, route corners, joined legs, turn sharing and drag cost, which are public rules.
13. **View as a player is the server's preview on every scene** (D-261025-14), never showing whispers between players. Rejected: the on-device preview, which lacks a player's own copies and memory.
14. **The DM's tools read the union**: Party sight, the Outliner, the tracker's "visible" add, the move warning and the trap notice.
15. **A new gate row, a light every source sees, takes 30 ms**, the budget of a source moved among lit lights, since every source's sight reads it. The server gate times each row end to end and keeps every whole-party budget as today. Rejected: holding it to the 10 ms of a light change, which the union alone nearly fills (4.7 ms on the laptop, 6.6 ms at the ratio) and which would take the cap to 2.
16. **No player-side notice** when a player's creatures cannot see, as under party vision today.

## 4. Today

One `PartySight` per scene (`shared/rules/vision.ts`, through `shared/ruleHooks.ts`), the union over at most 12 sources, read through `partySightOf` and `sightReader` (project.ts:202, 328) with no viewer. `withheldFromPlayers` (project.ts:367) is the rule under every token projection and "seen" helper. One explored layer per scene, merged into every player's fog (project.ts:258). Chunks carry every door's live state to every player (project.ts:781). The fan-out projects `sight`, `fog`, labels, stamps and chunks once for all players (`SAME_FOR_EVERY_PLAYER`, fanout.ts:96). A player's device treats every token it holds as public (walkWorld.ts:81). View as a player re-projects the DM's view on the device (preview.ts:21).

## 5. Audit: everything the server decides from sight or memory

"Own" is the viewer's sight and fog, "shared" what every viewer shares, "union" today's party sight.

| What a player may see or learn | Where it is decided | Reads today | On a per-player scene |
| --- | --- | --- | --- |
| A creature's token, its HP, conditions, name, image and asset grant | `tokenVisibleTo` (342), `visibleAssetIds` | party sight | own |
| Tracker rows, `tieOrder`, `activeEntryId` | `entryShown` (1282) | party sight | own |
| A turn's start, path stops | encounter.ts:70, tokens.ts:651 | one bit | `seen` or `seenBy` |
| Route corners (`via`) | tokens.ts:626, 632, path.ts:208, 226 | `routeSeen`, owners always | non-owners on shared ground, owners on their own revealed ground |
| Joined legs | path.ts:99 | one bit | unchanged, shared |
| HP, rest, concentration, effect, use, death save, life lines | `Tx.about` (tx.ts:502) | one bit | `seen` or `seenBy` |
| Turn lines and a take-back's row | encounter.ts:282, 487, 620, 642 | one bit | `seenBy`, `toSeenBy` |
| Rolls naming a token | dice.ts:44 | one bit | `seenBy` per roll |
| Area reminders | areaTriggers.ts:118, 127, `creatureReach` | `seen`, `hidden`, owners always | witnesses only, owners included (6.5) |
| Log audiences and copies | `lineReader` (1523), `Tx.settleLog` | one sight for all readers | per reader |
| Areas, kept rulers, live rulers, drag frames | 698, `projectDrawingCtx`, ephemeral.ts:102, 129, 183 | party sight | own, per receiver |
| Pings, laser, focus, AoE previews | ephemeral.ts default | none | unchanged |
| Fog tiles | `projectFogCtx` (840) | DM and party layers | DM, party and own layers |
| Labels, stamps, pins, found traps | `fogReader` (223), `anyFogTiles` (301) | shared fog | own fog and presence map |
| Door states in chunks | `projectChunkForPlayer` (781) | live, everywhere | unchanged (D-261025-17) |
| Door reach | permissions | shared fog | the actor's own fog |
| A player's own drag | walkWorld.ts:142 | the device's fog and tokens | own ground, shared creatures |
| Shared and kept walking rulers | walkWorld.ts:142, 245 | the device's fog and tokens | shared ground and creatures |
| Traps going off, players' trap lines, found marks | traps.ts:167, rules/traps.ts:406, 1370, 1427 | seen by all | unchanged, shared |
| Attach groups, mounts sharing a turn, mount cost | permissions.ts:1368, attach.ts:230, encounter.ts:104, 124, tokens.ts:442 | seen by all | unchanged, shared |
| Movement's public pass, undo's silent passengers, copied rulers | moveLeg.ts:123, undo.ts:459, duplicate.ts:172 | seen by all | unchanged, shared |
| Explored ground written | explore.ts:27 | party sight | shared sight to the party's layer, each holder's own to theirs |
| The trap notice (DM only) | trapNotice.ts:114 | party sight | union |
| Sight tiles | `projectSightCtx` (875) | party sight | own, plus `sightAll` |
| A player's guarded Next or Previous, "that is not here" | encounter.ts:392, `canApply` | the actor's view | the actor's own |
| Whispers | `projectLogEntryCtx` (1912) | their parties | unchanged, and never in a preview |

## 6. The model

### 6.1 Holders and sights

- **Sources** are chosen as today (design 9.10), at most 12 per scene in the fixed order, so the union is today's party sight bit for bit.
- **The holder list.** `RoomState.holders[sceneId]`, entries `{ memberId, on }`, DM only. The step after a batch that holds ops, on the player scene with vision on and no blackout, records in `sys.explore { join }` every player who owns a source there at that moment and has no entry, in the source cap's order, `on` while fewer than 6 entries are on. The DM's `vision.holders { sceneId, on }` op sets which entries are on (at most 6, players of the roster only, an entry added for a player who has none). Unticking a holder removes their layer, outside the undo step. The fold and `sys.memberRemove` remove entries. Nothing else changes the list, and nothing explored does.
- **Holders** are the entries that are on. A player whose entry is off has no layer and the shared sight.
- **Sights.** The shared sight is the union over sources marked `partyVision`. A holder's sight is that plus the sources the holder owns. Only members of kind `player` hold one.
- **Rasters are shared by source set.** Viewers whose sight reads the same set of sources share one raster: holders with the same own sources, and every non-holder and display (the shared set). Nothing else is shared between holders (6.9).
- **Invalidation.** `compute` keeps, per source and per light, the tiles its old and new spans or runs met. A raster redraws a tile when one of its sources, the shared sight or a light changed it, when the light rows changed there, and everywhere when the walls, the level or its own source set changed. So every raster equals a cold computation, which the tests check per raster.
- **A creature is in a viewer's sight** when any sub-cell under its footprint (squeezed while it squeezes) has a level above 0 in that viewer's raster. Projection and the marks of a committed state read the raster.
- **Sweep moments** (an area's crossing, a trap's springing, the mid-walk states of areaTriggers.ts:114) use a point query instead: each of the holder's sources' level at the footprint's sub-cells, from the moment's polygons and the light rows, by the same level function the raster calls. No holder raster is drawn for a moment.

### 6.2 Who sees what on a per-player scene

| Viewer | `sight` (vision on) | `fog` | Also |
| --- | --- | --- | --- |
| A holder | shared plus own | DM, party and own layers | `sightAll`, `fogAll` |
| Another player, a table display | shared | DM and party layers | `sightAll`, `fogAll` |
| A DM | the union | the DM's layer | `explored`, `exploredAny`, `sightAll`, `holders` |

- **The three branches.** With vision on, creatures follow sight. With vision off and fog on, they follow the viewer's own fog, and nothing explores. With both off, nothing is withheld for sight or fog, as today with fog off. Party members and exempt tokens are always shown. Vision off keeps the list and the layers as stored.
- `sightAll` (with vision on) and `fogAll` (with fog on) are the shared sight and fog, the same objects for every viewer. Players receive `vision.perPlayer` with the scene.
- **Doors** reach every viewer live, as today. Each player's device draws them only on ground out of that player's fog.

### 6.3 Explored ground per holder

- **Storage.** `RoomState.exploredBy`, keyed `"<sceneId>:<memberId>:<tx>,<ty>"`, values in the fog tile's shape plus `memberId`, written only by the server. The party's layer stays `exploredTiles`. Only holders have a layer, so at most 6 per scene.
- **The step after each batch** that holds ops, on a per-player player scene with no blackout, writes one `sys.explore { sceneId, tiles, members?, join? }`, replayed as stored: the list's joins with vision on (6.1), and layer bits with vision and fog on. Shared-sight bits go into the party's layer, and each holder's own bits that neither layer holds go into theirs.
- **A player's fog** merges the DM's, the party's and their own layer, and their presence map (`anyFogTiles`) holds all three layers' tiles, so a label on a tile only their layer holds reaches them. The merged tile is kept per triple of tile objects, as `mergedOf` keeps pairs today.
- **The DM's tools.** A reveal writes the DM's layer, for every player. A hide clears the party's layer and every holder's under its shapes, and `fog.reset` clears them all, outside any undo step, setting `global`.
- **Own fog** decides labels, stamps, pins, found traps, tokens on a fog-only scene, door reach, Fit map, the heights readout, a player's own drag and an owner's route corners. **Shared fog** decides shared and kept walking rulers, non-owners' route corners, "seen by all" on a fog-only scene and the map export's player view.
- **Joining later**: a new holder's map starts from the party's layer. **Losing creatures** keeps the entry and the layer. Places are sticky, and the DM's ticks are the way to change them (the guide says so).
- **Switching.** To Per player: holders start from the party's layer. To Whole party: every holder's layer is ORed into the party's and the list empties, outside the undo step, so undoing the switch does not split them again.
- **Scenes, import and export.** Duplicating a scene with its fog copies the list and the layers under the new id (shared/reducer/duplicate.ts). Deleting a scene removes them. A room export carries them, and an import maps scene and member ids, dropping what it cannot map (`server/rooms/remap.ts`). New rooms start with empty collections (shared/initial.ts).

### 6.4 Doors (D-261025-17)

- Door states stay in the chunks, live and the same for every player, as on every scene today. A player's device draws a door only where it lies on ground out of that player's fog, as it draws the map.
- **The accepted channel.** A player's data can show a door changed where only another player's creature saw it. The rules that already read real door states stay as they are: movement, sight and door reach, areas (`blocksAreas`, walls.ts:384, used by areaTriggers.ts:72) and the light rows (vision.ts:1241, 1704), and a secret door's real state blocks areas (walls.ts:392). So an aura reaching through a door, or a torch's light through it, can show a player that it opened. Risk 4 and the guide say so.

### 6.5 The marks

- **`seenMark(state, token, env, scope)`**, scope `"here"` (`seenByNonOwners`, for log lines) or `"anywhere"` (`inSightOfNonOwners`, for stops and turn starts). Behind a blackout, for `visibility: "dm"`, and under `"here"` off the player scene: no mark. Seen by all (decision 10, `revealSeenAnywhere(env.opVersion)` as today): `{ seen: true }`. On a whole-party scene otherwise: no mark. On a per-player scene otherwise: `{ seenBy }`, the sorted ids of the non-owner holders whose projection shows the token, present even when empty. Lists under `"anywhere"` off the player scene are always empty, since a player's projection covers only the player scene, which is conservative.
- **Rows.** A turn line's set is the holders whose encounter projection shows the row.
- **Area reminders** on a per-player scene: the witnesses are the players, the creature's owners included, who saw both the creature and the area at the crossing (by the point query of 6.1). The event reaches exactly them: `seen` when every viewer did, else `seenBy`, and `creatureReach` gives owners no way past the list. `hidden` means only an area that is DM only or attached to a token no player sees. A whole-party scene keeps today's rule.
- **Copies.** A path's first stop copies its turn start's marks, the list included (`startStop`, and attach's copies onto a mount's path).
- **Reading.** A non-owner gets a stop, start or line when it has `seen` or `seenBy` names them. `eventReach` and `diceRollReach` return the owners plus `seenBy`, except for area events.
- **Route corners.** `routeSeen` on a per-player scene also needs every spot of the leg on shared ground, so a non-owner gets `via` only then. An owner gets a leg's `via` only where every spot of the leg (its route spots, as traps sample them) lies on ground that owner's own fog reveals now, else the leg draws straight for them, as for non-owners. `moved`, `cost` and `diag` stay the token's. The mover passes by construction, since their drag searched their own ground.
- **Party lines.** On a per-player scene a line holding any list settles as a party line, never a shared line with parts. `Tx.settleLog` strips the lists from the DM line, and each copy is its reader's view.
- **One strip.** `projectEventCtx` removes `seenBy` and `toSeenBy` at its top and per roll in `projectDiceCtx`, and a reader named in a list gets `seen: true`. `stopsForNonOwners` and `projectTurnStart` drop them with the other marks (path.ts:201, 223, 241).
- **`lineReader`** gives each reader their own sight and fog, and its any-player reader the shared ones.
- **One-bit marks**: `routeSeen`, `joinedUnseen`, the trap line's indexes, `trapSeen.by` and `perceived`.

### 6.6 What each device reads

| Reader on a player's device | On a per-player scene |
| --- | --- |
| The map, overlay, fog, labels, stamps, pins, tracker, token panel | its own projection |
| Drop notes (dragNotes.ts:59) | own: "out of your sight now" |
| `publicToken`, `seenWhereMoved` (walkWorld.ts:81, 245) | public only where decision 10's branch says: `sightAll` with vision on, `fogAll` with fog alone, always with both off |
| A player's own drag (attach/walk.ts:24, movement/drop.ts:105) | own fog, creatures by `publicToken` |
| Shared and kept walking rulers (measure/walkRuler.ts:244), attach lists (attach/list.ts:153) | `fogAll`, `publicToken` |
| The reducer's predicted marks | the shared branch, never a list |
| Door reach before sending | own fog |

Doors come from the chunks on every device, as today. A display's own sight and fog are already the shared ones. A DM's device keeps the union for its tools and reads the shared fog from the DM's and party's layers.

### 6.7 Storage, versions and migration

```ts
Scene.vision?: { on: boolean, light: LightLevel, perPlayer?: true }   // stored only while true
RoomState.holders: Record<SceneId, { memberId: MemberId, on: boolean }[]>
RoomState.exploredBy: Record<string, FogTile & { memberId: MemberId }>
PathStop, TurnStart, AboutCreature, area event, DiceRoll: seenBy?: MemberId[]
turn event: seenBy?: MemberId[], toSeenBy?: MemberId[]
```

- **Snapshot version**, the next free one (24 at `cf98b4be`): the schema learns the fields, and the step adds the two empty collections.
- **Op version**, the next free one (23 at `cf98b4be`). From it a `vision` patch without `perPlayer` keeps it and `perPlayer: false` clears it, and `withPhaseLight` spreads `scene.vision` (phases.ts:78, 106, 122, room.ts:171, remap.ts:673). `sys.explore` takes `members` and `join`, and `vision.holders` is new. No older op ran on a per-player scene, so replay keeps every mark.
- **Undo** names in `server/rooms/undoLabels.ts`: "making sight per player on the scene Crypt", "making sight whole party on the scene Crypt", "choosing who sees for themselves on the scene Crypt". `isGlobalChange` compares `perPlayer` and the list.
- **Import**: paths are not imported (remap.ts:343). Turn starts in the encounter and every `encounterHistory` snapshot map their lists through `memberList`.

### 6.8 Accounting that reads no list

Who a list names and what a holder explored depend on that player's sight, so no measure reads them. Bounds come from encoded byte lengths. UUID figures are examples.

- **Layers.** On a per-player scene the party's layer and 6 holder layers count at their widest, every tile present, whatever they hold. Measured: 149,045 bytes for the party's layer of a 200 x 200 scene with a 64-character id, 162,227 for a holder's, 1.12 MB for all 7.
- **History.** Every stop and turn start that carries `seenBy` counts as if it named the 6 longest encoded player ids on the roster, wherever it lives (any path, `encounter.turnStart`, every `encounterHistory` snapshot) and whatever has changed since. With UUIDs about 245 bytes a stop and 12 KB a full path of 50. The schema allows any 64-character id, and 6 fully escaped ones take 2,334 bytes.
- **Lines** that depend on a list are party lines, which no measure counts.
- **The DM's projection** counts `exploredAny` and `sightAll` at their widest beside `sight` (sizeGuard.ts:237).
- **The list** is DM data, whose size depends on ownership, as other DM data does.
- **Lists stay within the roster**: `sys.memberRemove` scrubs the member from every list, layer and holder entry.
- **Initialization**: a loaded room computes the reserves once, cached by object identity, and each op adjusts them.
- **The storage quota** (1 GiB, actor.ts:199) counts op and snapshot rows, which now hold holders' layers and `sys.explore` writes. Accepted, as it is for DM lines and copies, since it is not a measure that refuses one op.
- **Refusal** of the switch: "The room is too full for per-player sight on this scene: each player's map and the paths this fight recorded need room. Delete unused scenes to free space."

### 6.9 Projection classes

- **Rasters** are drawn once per source set (6.1) and reused for every viewer with that set.
- **Fog, labels, stamps and found traps** are projected per member for holders, and once for all non-holders and displays, whose inputs are equal: the DM's and party's layers. Each is kept per (entity object, fog class's tile objects), so an unchanged input returns the same object and is never hashed again.
- **Pins** stay per member, since they also read journal access (project.ts:1144).
- **Path stops** for an owner read that owner's fog (6.5).
- **The same for all viewers**: chunks with their doors, `sightAll`, `fogAll`, scenes, lights and drafts.

## 7. Proposal

### 7.1 The switch

In a scene's Vision settings (`client/features/vision/VisionSettings.tsx`), right under the Party vision switch, shown while Party vision is on or `perPlayer` is stored:

- A row **Sight**: **Whole party** (the default) or **Per player**. Help, Whole party: "Every player sees what any party creature sees, and the party shares one map." Per player: "Each player sees only what their own creatures see, and creatures that share sight with the party. Each player keeps their own map of where they have been. At most 6 players per scene."
- The switch's "On:" help on a per-player scene: "On: each player sees only what their own creatures see, by their senses and the light around them."
- Busy: the switch only for a pending change of `on`, the row only for `perPlayer` or the list. After about 200 ms the row's help reads "Working out what each player sees…" or "Working out what the party sees…".
- **Who sees for themselves** (per player only): every player of the roster with a checkbox, ticked for entries that are on. Ticking a seventh is refused: "At most 6 players see for themselves here. Untick one first." Unticking asks once: "Untick Ana? She forgets her map of this scene." A player with an entry that is off: "Gus sees only what creatures that share sight see here." Under the list: "Players not ticked, and the table display, see only what creatures that share sight with the party see."
- **Who lends sight** (per player): each lending row ends "Lends its sight to Ana", "Lends its sight to Ana and Ben" or "Lends its sight to every player".
- **A mount not every player sees**: "Thorn rides Horse, which not every player sees, so they share no turn. Make Horse always visible to keep it."
- The row sits under the switch it qualifies, not at the end of the section. In code it is added on its own lines.

### 7.2 Flipping mid-session

- The edit sets `global`. Each holder gets their own sight and fog, and a creature they cannot see leaves their map with its row, areas and kept rulers, "Another creature's turn" showing while it acts. Going back folds the layers (6.3), and everyone gets the union.
- Lines a player holds follow the read-time rule (design 7.3). Marks keep their readers after any switch.
- `previewsSent` (connection.ts:81) keeps the last frame each receiver got, so a `global` batch re-judges held previews and live rulers and sends `dragCancel` or `rulerEnd` to each receiver that may no longer have them.

### 7.3 What stays shared

The DM's fog layer, the party's layer, the chunks and their doors, the party's tokens, the order and `started`, the turn under way, handouts, chat, the roster, and every public rule.

### 7.4 View as a player

- On every scene, View as a player opens a **preview socket**, `/ws?as=<memberId>`, decided where the display's `as=display` is (ws.ts:118): only for a DM grant and a roster member of kind `player`, else 403 `no_access`. There is no `hello` field for it, and a `hello` carrying `as` on any connection closes it with `4003`.
- The server projects the room for that member as a player, and every snapshot, `ev` and archive page drops each whisper that does not include the requesting DM. The log endpoint takes `as` under the same rule (`server/http/log.ts`).
- It is read only: any `op`, `eph` or `scene` closes it with `4003`. It sends a `clientId` of its own, never becomes `current` for any key (connection.ts:23), is in no presence list and counts as no member's socket. Its `hello` goes through the snapshot budget, and another player means a new socket.
- Its notice: "You are viewing as Ana. Nothing you do here is saved. Whispers between players are not shown." Until its snapshot lands, the shared indicator after 200 ms reads "Loading what Ana sees…", and after 10 s, or a dropped socket, "Could not load what Ana sees. Close and try again."
- The DM's own socket and tools are untouched while it is open.

### 7.5 Fan-out and ephemeral

- **Keys**: `sightAll:`, `fogAll:` and `exploredAny:` keyed `<sceneId>:<tx>,<ty>`, and `holders:<sceneId>` (DM only), all with a colon for fanout.ts:122. `exploredBy` is never projected under its own key: a write brings the `fog:` key at its tile for the viewers whose fog reads it, and the paths of the tokens that holder owns on the scene. A write to the party's layer brings the paths of every owned token there. `KEPT_AS_VALUES` (fanout.ts:166) adds `sightAll`, `fogAll` and `exploredAny`.
- **Ctx** carries per viewer `sight`, `fogged` and a presence map. `partySightOf` means "seen by all" (decision 10). `visionRules` gains `holderSight` and `unionSight`.
- **Classes** by 6.9: `sight` per source set, `fog`, `label`, `stamp` and `trap` per member for holders and once for the rest, each changed tile hashed once per class. `changedSightKeys` diffs every raster, and `tileDependents` takes their changed tiles together.
- **Ephemeral**: DM receivers get every frame. For players, `withheld()` (ephemeral.ts:183) is cached by every input of its spot test, by decision 10's branches: per source set with vision on, per fog class (each holder alone, the rest together) with fog alone, and never withheld with both off. Its walker test keeps "seen by all".

## 8. Cost and risk

### 8.1 Measured

On a development laptop with Node 24, at the vision gate's caps (`capRoom`: 200 x 200 cells, 6,000 sight pieces, 12 sources with 150 ft darkvision in one hall, each carrying a 120 ft light every source sees, plus 100 free lights and 8 carried by monsters). The worst legal ownership: each holder owns 11 of the 12 sources, a different one missing, so no two share a raster (16 owners a token allows it), run again with 2 sources marked to share (the same within noise). A scratch prototype draws each raster from the union's own polygons and light rows with vision.ts's `renderTile`, as 6.1 specifies, not committed. `scripts/bench-server4.ts` gave today's end-to-end rows on the same laptop, through the actor with a database stub. The laptop rows are informational: the server box gates the cap, timing each row end to end with every whole-party budget as today.

| Row (server budget) | Union today | Added by 6 holders | Total at the ratio 1.4 |
| --- | --- | --- | --- |
| A held source moved, bright (25 ms) | 3.4 ms | 5.6 ms | 12.6 ms |
| A held source and its light every source sees moved, dark (30 ms) | 6.8 ms | 8.5 ms | 21.4 ms |
| The gate's light rows, dark (10 ms): added, moved, switched, removed | 2.0, 1.7, 0.8, 0.7 ms | at most 0.17 ms | at most 3.0 ms |
| A free light every source sees, dark (new, 30 ms, decision 15) | 4.7 ms | 7.3 ms (5 holders: 6.0) | 16.7 ms |
| A door every source sees (250 ms) | 34.0 bright, 58.6 dark | 9.9, 13.6 ms | 101 ms |
| Every raster whole: the switch, a level or phase change (250 ms) | 92.9 ms end to end today | 13.5 ms | 160 ms at bench-server4's ratio 1.5 |
| 500 creatures judged for every holder | | 0.4 ms | |
| Explore bits, every holder, every tile | | 1.8 ms | |
| Every raster's tiles hashed once (10 ms) | | 1.2 ms | 1.7 ms |

- **The cap.** At the worst legal ownership every row passes at 6 on the laptop. The server-box gate (`scripts/bench-server4.ts --server`) runs these rows with the 6-holder ownership above, and `sightHoldersPerScene` is 6 if it passes, else 5, else the largest number that passes.
- **Rows the build adds to the benches**, not yet measured: a routed walk crossing several areas with 6 holders, whose moments use the point query (6.1), and a `global` batch projecting fog, labels and stamps for 6 holders and the shared class with the memoized tiles of 6.9.
- **The first snapshot** draws only the DM's union. Each player's raster is drawn at their own snapshot or the next explore, at most 2.3 ms each.
- **Bytes at the caps.** One sight map at its largest is 245,050 bytes. The DM's projection adds `exploredAny` (149 KB) and `sightAll` (245 KB) to today's chunks (1.0 MB), layers and sight: about 1.95 MB of the 3 MiB projected scene. A player's projection is smaller. Stored state reserves 1.12 MB of layers for a 200 x 200 per-player scene, of the room's 8 MiB, about 39 KB for a 40 x 30 one. That fits, so per-player scenes keep the room's limits, and a room of several large ones fills sooner, with 6.8's refusal.
- **Log rings.** Lines some players saw become party lines: a copy per reader (50 a member, against 200 shared lines) and a DM half that fills the DM's ring of 200. Both live logs shorten, and older lines stay in the archive.

### 8.2 Every seen bit that becomes a set

| Mark | Lives in | Bound and accounting |
| --- | --- | --- |
| `PathStop.seen` | token paths | 6 ids, 50 stops a path, counted at widest (6.8) |
| `TurnStart.seen` | `encounter`, every `encounterHistory` snapshot | 6 ids, counted at widest |
| `AboutCreature.seen`, area `seen`, `DiceRoll.seen` | log | party lines, stripped when settled |
| `turn` `seen`, `toSeen` | log | `seenBy`, `toSeenBy`, party lines, stripped when settled |

### 8.3 Risks

1. **The boundary grows.** Visibility now reads ownership, holders and four layers. The oracle tests of section 10 are the guard.
2. **Public rules see less.** A creature outside the shared sight is unseen by every public rule, as one under fog: a DM's horse a character rides shares no turn, a monster's trap goes off unperceived, and route corners stay hidden. The DM marks such a creature always visible or sharing sight, which the settings flag and the guide explains.
3. **Routes.** A player's own drag routes over their memory and through creatures only they see. Its corners reach others only on ground they know. A trap it sets off is public, as any party member's walk is.
4. **Doors are shared and live** (D-261025-17, accepted). A player's data can show a door changed where only another player's creature saw it. Areas and light read real door states, so an aura or a torch through a door can show it opened, and a secret door's real state blocks areas, as today. A party member, always shown, walking through a door shows it too. The guide says so beside the existing notes on areas and light.
5. **Six places.** Who holds one rests on the order players first owned a seeing creature there, which a lent creature's hidden owner can affect, and on the DM's ticks, never on sight or exploration. A player past the cap learns only that the places are taken. Places are sticky until the DM changes them.

## 9. Security rules

1. A player's projection judges creatures by that player's sight, and fog, labels, stamps, pins, traps and an owner's route corners by that player's layers, from the committed state. It never reads another player's sources or layer. Only rasters are shared, by source set.
2. Every public input reads only the shared sight and fog, by decision 10's branches: refusals, limits, traps, attach groups and turn sharing, shared and kept rulers, non-owners' route corners, copied rulers, undo's silent passengers, and on a device `publicToken`, `seenWhereMoved` and the shared ground.
3. `seenBy`, `toSeenBy`, `holders`, `exploredBy` and `exploredAny` reach DMs only. A reader's copy says `seen: true` and holds no list. A line holding a list is a party line.
4. A player gets a past stop, start or line only when they own the creature, it was seen by all, or a list names them. An area reminder only when a list names them or it was seen by all.
5. No mark or list is written behind a blackout, for a hidden token, or off the player scene under `"here"`.
6. Only the server writes marks, lists and layers. A device's marks are predictions and never lists.
7. `sightAll` and `fogAll` are the same for every viewer and never hold a holder's own sight or layer.
8. A preview socket exists only for a DM grant and a roster player, is read only, never current, in no presence, and never carries a whisper that does not include the requesting DM.
9. Frames, live rulers and their cancels are judged per receiver, cached only by equal inputs (7.5).
10. Fail closed on a player's device: missing `sight` or `sightAll` tiles see nothing, and missing `fog` or `fogAll` tiles are fully fogged.
11. No measure reads a list or a layer's contents (6.8).
12. With Sight on Whole party, every byte and mark is today's, and the existing replays pass unchanged.

## 10. Tests

- **Rules (PV2).** Every raster equals a cold computation after random moves, lights, doors, levels, ownership and list changes. The union of every holder raster and the shared sight equals the sight of the shared sources plus every holder's own, and the DM's union equals today's party sight. A raster's in-sight test equals a brute force over its sub-cells, squeezed and Tiny footprints included, and the point query equals the raster on random footprints. Golden bits for one per-player scene. The banned-functions test covers the new code.
- **Property test (PV1)**, random rooms of 1 to 8 players with shared characters, lent monsters, companions, shared-sight creatures, more than 6 would-be holders, down and Blinded sources, walls, doors and lights, all three light levels and all three branches of decision 10, under random ops: both switches and their undo, the DM's ticks, phase switches, phase lists and light changes, fog reveals, hides and resets, ownership changes, members joining and leaving, Next and Previous with a resumed row, mixed dice lines and blackouts:
  - For every viewer, its events applied to its snapshot equal `projectState`, the display and a preview included.
  - No player's projection holds a creature, label, stamp, pin, trap or route corner their own sight, fog and journal access would not give them, by an oracle that recomputes each from nothing. In the giving direction, a label on ground only their layer holds reaches them.
  - No stop, start, line, roll or reminder reaches a player who did not witness it, by the oracle's record.
  - No player's data holds a list, `holders`, `exploredBy` or `exploredAny`, and `sightAll` and `fogAll` are equal for every viewer.
  - Two holders with the same sources and different past exploration, two with different pin access, and a holder whose creature went down each keep their own fog, labels and pins.
  - A phase switch, a phase list change, the Light control and the Party vision switch never change `perPlayer` (also a unit test each).
- **Differential (PV1, shared/differential.ts)**, exact: paired rooms that differ only in what holder A's creatures see or explored give every other player and the display identical `ev` streams, frames, refusals and limit answers. A variant holds A's own fog equal and compares what others observe of A's own drag, which `checkPair`'s guard (differential.ts:106) would otherwise skip. A pair of co-owners of one character with different layers: the mover's route corners reach the other only on ground the other remembers. A measure row runs the pairs a few bytes under the room's limit.
- **Marks (PV1).** Both scopes, no list behind a blackout or for a hidden token, lists sorted, present when empty and naming only holders whose entry is on, empty off the player scene under `"anywhere"`, scrubbed on member removal. An aura that crosses Bree's creature where Bree cannot see it, ending where she can, reaches Thorn's player only. Golden replays of turns and moves on inactive whole-party scenes pass unchanged.
- **Server (PV3).** Two holders with different sources on one scene receive different `sight` and `fog` in one batch, and the display only the shared ones. On a fog-only per-player scene, two holders with the same sources and different layers get different drag frames for a DM's drag into ground only one remembers, and the other gets its cancel. `/ws?as=` answers 403 to a player grant and to `as` naming a DM member, the display or an unknown id, a `hello` with `as` closes with `4003`, writes close with `4003`, the preview's `clientId` never takes another socket's acks, and a whisper between two players reaches no preview, live or archived. Size guard rows for every container of 6.8 and the switch's refusal. Import maps lists and layers. Held previews cancel on the switch.
- **Bench (PV2).** `scripts/bench-vision.ts` and `scripts/bench-server4.ts` gain every row of 8.1 with the 6-holder worst ownership, the new light row, and the two rows 8.1 names for the build.
- **Mutants**, each a test must fail on: the union in a holder's place, `sight` or `fog` left in `SAME_FOR_EVERY_PLAYER`, fog or labels reused per source set, a presence map without the holder's tiles, a list keeping an owner, a list naming an unticked player, an area reminder past its list, a copy keeping a list, a shared line keeping a list, `partySightOf` reading the union, `publicToken` reading `sight` or ignoring vision off, a shared ruler reading own fog, co-owners getting every `via`, `withheld()` once for all players with vision off, a list behind a blackout or for a hidden token, a fold left out, the list changed by explore, a measure reading a real list, `withPhaseLight` dropping `perPlayer`, a preview carrying a whisper, and `as` honoured on a player grant.
- **e2e (PV5)**, `e2e/pervision.e2e.ts`, two players on one dark scene, steps `pv-1` on: (1) Per player: Thorn's player sees a goblin in Thorn's torchlight and its row, Bree's player sees neither and gets "Another creature's turn". (2) Ground Thorn explores stays under Bree's fog, with a label in it. (3) Thorn opens a door on ground Bree never explored: it is drawn open on Thorn's map and not drawn on Bree's, and once Bree's creature explores there it is drawn open for her too. (4) View as Bree and as Thorn each show only that player's view, after the loading line, and no whisper between them. (5) A Night phase switch keeps Per player. (6) The DM unticks Thorn's player and ticks a third: the list and maps follow. (7) Whole party pools the maps, and back to Per player they stay pooled. (8) No frame Bree's page received held the goblin or the label while per player, and no page logged an error. Run with `reach`, `vision` and `display`. `e2e/alignment.e2e.ts` adds the Vision section as a root.

| Case | Expected | Test |
| --- | --- | --- |
| An existing scene, a backup from before | Whole party, today's bytes and marks | migrate, golden replays |
| Goblin in Thorn's torchlight only | Thorn's player gets it, Bree's player and the display do not | property, e2e pv-1 |
| A label in a room only Thorn explored | Bree's player has neither label nor ground, Thorn's has both | property, e2e pv-2 |
| Thorn opens a door on ground Bree never explored | Live in both players' data, drawn only on Thorn's map until Bree explores there (accepted) | e2e pv-3 |
| Bree's player opens devtools | No goblin, row, label, list, layer or frame | property, e2e pv-8 |
| The DM reveals or hides a room | Every player gets it, every layer cleared under a hide | property |
| A creature marked to share sight | Every player sees and remembers what it sees | rules, property |
| A seventh would-be holder | Shared sight only until the DM ticks them | property, e2e pv-6 |
| Thorn is Unconscious | Thorn's player sees the shared sight and keeps their map | property |
| A player joins mid-fight | Only what was seen by all, the party's map | property |
| Vision turned off on a per-player scene | Own fog for creatures, frames by fog class, nothing explored | property, PV3 |
| Switch to Whole party and back | Pooled maps, then each starts from the pool | property, e2e pv-7 |
| A Night phase switch, the Light control | Per player kept | unit, property, e2e pv-5 |
| Thorn's player drags Thorn through ground only they remember | Routed there, corners hidden from others | differential |
| Two co-owners, one drags through ground the other never saw | The other's trail draws that leg straight | differential |
| An aura crosses Bree's creature unseen by her | The reminder reaches Thorn's player only | marks |
| A room near its byte limit, ops by Bree's player | The same answers whatever Thorn's creatures saw | differential measure row |
| A preview of Ana, with a whisper from Ana to Ben | No whisper in the preview, live or archived | PV3 |
| `/ws?as=` from a player grant | 403 `no_access` | PV3 |
| 6 holders at the worst legal ownership, at the caps | Within every budget on the server box, else the cap drops | bench |

## 11. UI checklist

- **Words**, exactly as in 7.1 and 7.4, the undo names of 6.7, the refusal of 6.8, and a drop note on a per-player scene: "Goblin is out of your sight now." or "3 creatures are out of your sight now." (`intoFogText`).
- **Loading.** The Sight row and the list are busy and refuse a second tap until acknowledged, with the shared indicator after 200 ms. The preview waits as 7.4 says and ends in its view or its error.
- **Keys and focus.** The Sight row is a radio group and the list a set of checkboxes: Tab reaches each, arrows move in the group, Space toggles a box, and focus stays through a change, its busy state and the untick confirmation, which returns focus to its box. No new shortcut, so the shortcut sheet and FEATURES.md's key list are unchanged.
- **Screen readers.** The group is named "Sight" and the list "Who sees for themselves", each described by its help. Busy sets `aria-busy`, and the working line, the refusal and the preview's lines are polite statuses.
- **Large interface sizes.** At 130% the two options stay on one row at 320 px or wrap whole, and a long name in the list wraps inside its row. `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px: the Vision section (new root) and the preview's loading state.
- **Phones.** The existing settings sheet, 44 px targets, nothing on hover or long-press.

## 12. Lane plan

| Lane | Owns | After |
| --- | --- | --- |
| **PV1 Contract, marks and memory** | `shared/model.ts`, `shared/protocol.ts`, `shared/keys.ts`, `shared/migrate.ts`, `shared/initial.ts`, `shared/ruleHooks.ts`, `shared/limits.ts`, `shared/project.ts` (per-viewer `Ctx`, presence maps, fog merges, `seenMark`, readers, the strip, `lineReader`, keys, classes' inputs, owners' route corners, `changedSightKeys`, `tileDependents`), `shared/rules/path.ts`, `shared/rules/walkWorld.ts`, `shared/reducer/tx.ts`, `room.ts` (the merge rule, the scrub), `phases.ts`, `duplicate.ts`, the fog reducer (hides and resets over every layer, the fold), `vision.holders`, the mark writers in `encounter.ts`, `tokens.ts`, `dice.ts`, `areaTriggers.ts`, `attach.ts`, `trapNotice.ts`, `shared/differential.ts`, `server/rooms/stateSchema.ts`, `server/rooms/undoLabels.ts`. Unit, property and differential tests, rules stubbed through `visionRules`. | the current scope |
| **PV2 Rules** | `shared/rules/vision.ts` (source sets, shared sight, per-raster invalidation, lazy rasters, the point query, cache bytes), tests, `scripts/bench-vision.ts`, `scripts/bench-server4.ts` | PV1's hook types |
| **PV3 Server** | `server/rooms/fanout.ts`, `ephemeral.ts`, `connection.ts`, `actor.ts`, `ws.ts` and the auth preHandler (the preview socket), `server/http/log.ts`, `sizeGuard.ts`, `remap.ts`, `explore.ts` (layers and joins), `server/rooms/pervision.itest.ts` | PV1, PV2 |
| **PV4 Client** | `client/features/vision/*` (the Sight row, the two lists, `settings.ts`'s patches), `client/features/dm/preview.ts` and `PlayerPreview.tsx` (the preview socket on every scene), the socket client, `client/canvas/dragNotes.ts`, `client/features/attach/walk.ts`, `attach/list.ts`, `movement/drop.ts`, `measure/walkRuler.ts`, `client/features/outliner/rows.ts` and `OutlinerPanel.tsx`, `client/features/encounter/logic.ts` | PV1 |
| **PV5 Integration and docs** | `e2e/pervision.e2e.ts`, the Vision root in `e2e/alignment.e2e.ts`, docs/design.md (7.1, 7.3, 7.6, 9.10, 13.5, 13.6), docs/design-v1-maps-vision.md (4.3.2, 4.3.10), docs/features.md, `FEATURES.md`, docs/dm-guide.md (the Sight row, the list and sticky places, memory per player, shared doors beside the notes on areas and light, the display, risks 2 to 5, new screenshots), this note's As built | all |

PV2 and PV4 run beside each other once PV1's contract lands, and PV3 needs PV2. `pervision.e2e.ts` takes a port offset no other file uses. Each new test fails with its fix removed, by the mutants of section 10. FEATURES.md and the guide change in PV5's last commit only.

## 13. Out of scope

Door memory per player (decision 8, its own feature if the owner asks). Traps found or perceived per player, and every other public rule per player (decision 12). Per-player light levels. More than 6 holders. A player-side notice when their creatures cannot see.

## 14. As built

The builder fills this in the lane's docs commit with every place the build went its own way.

## 15. Review dispositions

**Round 1**, all adopted: SEC-1, PV-O-5, PV-ASTRA-4 (6.3). PV-O-1, SEC-2 (6.6). PV-O-2 (6.7). PV-O-3 (6.5). PV-O-4, PV-ASTRA-1, PV-ASTRA-2, SEC-5 (6.8). PV-ASTRA-3, PV-O-6, SEC-6 (6.1, 8.1). SEC-3, PV-O-8, PV-ASTRA-5 (6.5). PV-ASTRA-6 (7.4). PV-ASTRA-7, PV-O-7 (6.5). SEC-4, SEC-7, SEC-8, SEC-9, PV-O-9 to PV-O-14, and Fable on the mount (7.1, 7.5, 12).

**Round 2**, all adopted: N1, R2-SEC-2, PV-ASTRA-8 (6.9, the property test's pairs). N12, PV-ASTRA-9, R2-SEC-5 (6.1, decision 4, risk 5). N2, R2-SEC-3, PV-ASTRA-15 (7.4). R2-SEC-1 (7.4, PV3). N3 (decision 11, risk 3, the differential variant). PV-ASTRA-10, settled since by D-261025-17 (6.4). PV-ASTRA-7 (6.5). N4, PV-ASTRA-12 (6.2, 6.6). N5, PV-ASTRA-11 (8.1, decision 15). N7, PV-ASTRA-6 (7.4). PV-ASTRA-13 (10). R2-SEC-4 (6.3). R2-SEC-6 (7.4). R2-SEC-7 (10). PV-ASTRA-14 (6.8). N6, N8, N9, N10 (12, 6.5, 6.3, 6.8).

**Round 3**, all adopted. D-261025-17 removes door memory, the shared door field, its seeding, its reserve, its import ordering, its cleanup and its e2e steps, which closes PV-ASTRA-16, PV-ASTRA-17, PV-ASTRA-19, PV-ASTRA-20, PV-ASTRA-21, R3-O-2, R3-O-3, R3-SEC-4, R3-SEC-5 and R3-SEC-1's door view key by removal. PV-ASTRA-18, R3-O-1: `withheld()` cached by every input (7.5), its PV3 test and mutant. R3-SEC-2: owners' route corners (6.5, decision 11), the co-owner pair and mutant. PV-ASTRA-22: e2e step 3 rewritten for shared live doors. R3-O-4: the point query for sweep moments (6.1) and its bench row (8.1). R3-O-5: memoized fog projection (6.9) and its bench row. R3-O-6, R3-SEC-3: door wording, areas and light named (6.4, risk 4, the guide). R3-O-7: lists name holders whose entry is on, and an unticked player has no layer (6.1). R3-SEC-6: joins decided by ownership in `sys.explore { join }` (decision 4, 6.1). Opus on the 30 ms light: the dark held-source row moves a source carrying a light every source sees, gated at 30 ms, and the server gate keeps every whole-party budget (8.1, decision 15).
