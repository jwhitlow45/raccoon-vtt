# raccoon-vtt v1: per-player vision

Status: draft 1, 2026-10-25, for design review. Code is cited from `main` at `cf98b4be`. It extends docs/design-v1-maps-vision.md section 4.3 (called "the vision addendum" below) and docs/design.md sections 7.3, 9.10 and 13.6, and follows their rules: server-authoritative state, per-viewer projection as the security boundary, exact arithmetic, bounded everything.

## 1. The owner's words

- The project owner, 2026-10-25, after hearing that per-member sight was never added: "Once done with your current scope of work I'd like you to add support for per player vision (toggleable between whole party and per player by the dm) and also hex grids (keep square as the default though)."
- And right after: "Any designs these can be done ahead of time should be"
- Decided as D-261025-7 and its amendment: per-player vision is a DM switch per scene beside Party vision, whole party by default, so nothing changes for existing scenes. It amends the vision addendum's question 1 (party vision, 2026-10-14), which stays the default. The build waits for the current scope to land.

## 2. Summary

- **A per-scene choice under Party vision**: Sight, "Whole party" (today, the default) or "Per player". Stored only while per player, so every existing scene and backup reads as today.
- **Three sights per per-player scene, one computation.** The cache keeps each source's polygon once, as today. From those it draws the **union** (today's party sight, which still feeds exploration and the DM's tools), the **shared sight** (only the creatures the DM marked "Shares sight with the party") and, lazily, each **player's sight**: the shared sight plus the sources that player owns.
- **Each player's projection reads their own sight.** Creatures, their rows, areas, rulers, drag frames and log lines follow it, through the existing per-viewer projection.
- **Public rules read the shared sight.** Anything one viewer can observe of another's op (refusals, limits, traps going off, attach groups and turn sharing, routes, shared rulers) keeps reading "seen by all", which on a per-player scene means the shared sight. So public determinism holds unchanged: no player's bytes depend on what only another player's creatures see.
- **History marks become sets.** A path stop, a turn's start, a turn line, an HP or condition line, an area reminder and a roll keep `seen` (seen by all) and gain `seenBy`: the players who saw it through their own sight. Nobody but the DM gets the lists.
- **Explored ground stays one shared layer.** What any player's creature explores stays drawn, dimmed and empty, for every player.
- **The cost is small.** Measured at the caps on a development laptop, a whole-scene redraw for one player's sight takes 0.5 ms against 1.6 ms for the union of 12 sources, and the rest is shared.

## 3. Decisions, with rejected options

Asking the owner is off, so each choice the words leave open is a guess at the owner's likely answer, from the words, D-261025-7 and the 2026-10-14 answers.

1. **Whose sight a player has.** The sources they own, directly or through a character (`ownsToken`): their character, its companions, a monster or NPC lent to them, and a character they share with another player. Plus the shared sight. Rejected: tokens a player may only move under `playersMoveAny` (moving is not seeing), and companions lending to the whole party (FEATURES.md says a creature companion "lends the party its sight": under per player it lends its own player's).
2. **"Shares sight with the party" keeps its meaning**: a creature the DM marked lends its sight to every player, owned or not. Rejected: the mark lending only to an owner, which would make the DM's mark say something it does not do.
3. **The party still always sees each other.** Every party member stays shown to every player above the fog (design 13.3), on per-player scenes too. Rejected: other players' creatures following sight. It hides allies behind a wall on a phone, it is not what the words ask (they are about what each player's creatures see, not where the party stands), and `aboveFog` feeds the public rules.
4. **A player with no source of their own sees the shared sight**: explored ground, the party, and what shared-sight creatures see. That covers a player whose creatures are all down, hidden, past the cap or on no scene, and one who joins later. Rejected: such a player seeing the union, as a spectator. It contradicts "each player sees only what their own creatures see", and it would make a later joiner's view of history a special case.
5. **A table display sees the shared sight**, as the player who owns nothing it is projected as (design 7.3). Rejected: the union on the display, which would show the whole table what per player is meant to keep apart. The DM's Vision settings say what the display shows.
6. **Explored ground stays shared.** One explored layer, written from the union, as today. A player sees ground another player's creature explored, dimmed and without creatures. Rejected: an explored layer per player. It makes the fog per viewer, and with it labels, stamps, pins, found traps, routes, door reach, Fit map and the map export, it multiplies the explored reserve by the players, and switching back to whole party would need a merge rule. The 2026-10-14 answer to question 16 (door state on explored ground is shared map knowledge, rather than new per-player projection state) points the same way. It can come later as its own design.
7. **One tracker order.** The order is the room's. Each player gets the rows they may see, in that order, renumbered with no gap (`tieOrder`, design 7.3), and "Another creature's turn" while a row they cannot see acts. Rejected: a per-player order, which does not exist at a table.
8. **Seen by all means the shared sight.** On a per-player scene `seenByNonOwners`, `inSightOfNonOwners`, `seenAtEvery` and `rowSeenByNonOwners` read the shared sight. Rejected: "every player on the roster sees it" (the intersection). A table display and a later joiner are viewers too, so public inputs that read a creature they cannot see would change their bytes by hidden state.
9. **History per player only where players read history**: path stops, a turn's start, turn lines, HP, rest, concentration, effect, use, death save and life lines, area reminders and rolls. Rejected: per-player trap perception, found marks, route corners (`routeSeen`), joined legs (`joinedUnseen`), turn sharing and drag cost. Those are public rules, and the traps design already left "found per player" out of scope.
10. **The DM's view-as asks the server.** On a per-player scene, View as a player swaps the DM socket's sight for that player's (section 7.4). Rejected: sending the DM every player's sight always, up to 50 times the tiles in every DM snapshot.
11. **The DM's own tools read the union**: Party sight's veil, the Outliner's "Out of the party's sight", the tracker's "visible" add, the move warning and the trap notice. "The party" there means any player.
12. **No player-side notice** when none of their own creatures can see. Party vision shows none today when no source lends sight. Rejected: a new banner, which the words do not ask for.

## 4. Today

One `PartySight` per scene (`shared/rules/vision.ts` `partySight`, through `shared/ruleHooks.ts` `visionRules`), the union over at most 12 sources. `shared/project.ts` reads it through `partySightOf` and `sightReader`, which take no viewer, so `Ctx.sight` is the same for every player. `withheldFromPlayers` (project.ts:367) is the one rule under every token projection and every "seen" helper. The fan-out projects `sight` once per batch for all players (`SAME_FOR_EVERY_PLAYER`, server/rooms/fanout.ts:96). View as a player re-projects the DM's view on the device from the DM's held tiles (client/features/dm/preview.ts:21). The cost of a per-player model was named in the vision addendum 4.3.2 and left out in 4.3.10.

## 5. Audit: everything the server decides from sight

"Own" is the viewer's sight (section 6.1), "shared" the shared sight, "union" today's party sight.

| What a player may see or learn | Where it is decided | Reads today | On a per-player scene |
| --- | --- | --- | --- |
| A creature's token | `tokenVisibleTo` (project.ts:342) | party sight | own |
| Its HP, conditions, name, image (and the image's asset grant) | token projection, `visibleAssetIds` | follow the token | follow the token, so own |
| Its carried light | token field allowlist | DM and owners | unchanged |
| Tracker rows, `tieOrder`, `activeEntryId`, `started` | `entryShown`, `projectEncounterCtx` (1282, 1306) | per viewer, token by party sight | own (decision 7) |
| A turn's starting spot | `TurnStart.seen` (encounter.ts:70), `projectTurnStart` (1340) | one bit | `seen` or `seenBy` |
| A turn's path stops | `stopAt` (tokens.ts:651), `stopsForNonOwners` (rules/path.ts) | one bit | `seen` or `seenBy` |
| Route corners, joined legs | `routeSeen` (tokens.ts:632), `joinedUnseen` | one bit | unchanged, seen by all |
| HP, rest, concentration, effect, use, death save, life lines | `Tx.about` (tx.ts:502), `creatureReach` (1469) | one bit | `seen` or `seenBy` |
| Turn lines, a take-back's resumed row | encounter.ts:282, 487, 620, 642, `eventReach` (1417) | one bit | `seenBy`, `toSeenBy` |
| Rolls naming a token | dice.ts:44, `diceRollReach` (1484) | one bit | `seenBy` per roll |
| Area reminders | areaTriggers.ts:118, 127 | `seen` and `hidden` | `seen` gains `seenBy`, `hidden` stays seen by all |
| Log line audiences and copies | `lineReach`, `Tx.settleLog` | per roster player, by projection | unchanged code: per-player reads make party lines |
| Toasts and alerts | the projected log and tokens | follow them | follow them |
| Areas on a token, a cast's `casterId` | `projectTemplateCtx` (698) | follow the token | own |
| Kept rulers on a token | `projectDrawingCtx` | follow the token | own |
| A copied ruler made DM only | duplicate.ts:172 | seen by all | unchanged, shared |
| Live rulers, drag frames | ephemeral.ts:102, 129 to 139, 183 | per receiver token, one spot test for all players | own, per receiver |
| `path` and `ft` on frames | `forPlayer` (ephemeral.ts:84) | stripped on fog and vision scenes | unchanged |
| Pings, laser, focus, AoE previews | ephemeral.ts `default: true` | no sight test | unchanged (they name no creature) |
| Labels, stamps, pins, found traps | merged fog (`fogReader`) | shared | unchanged (decision 6) |
| Traps going off, players' trap lines, found marks | traps.ts:167, rules/traps.ts:406, 1370, 1427 | seen by all | unchanged, shared |
| The trap notice (DM only) | trapNotice.ts:114 | party sight | union |
| Explored ground | explore.ts:27 | party sight | union |
| Sight tiles | `projectSightCtx` (875) | party sight, all alike | own, plus `sightAll` (section 7.5) |
| Light's effect | inside sight tiles | party sight | own |
| Attach links, groups, riders, mounts sharing a turn | permissions.ts:1368, attach.ts:230, encounter.ts:104, 124, tokens.ts:442 | seen by all | unchanged, shared. The GP2-2 follow-up lands under the same helpers |
| Movement's public pass, walkers, sampling | moveLeg.ts:123, walkWorld.ts:83, 245 | seen by all | unchanged, shared |
| Undo of a passenger | undo.ts:459 | seen by all | unchanged, shared |
| A player's guarded Next or Previous | `activeRowShownTo` (encounter.ts:392) | the actor's view | own (the actor's) |
| A refusal "that is not here" | `canApply` through `projectEntity` | the actor's projection | own (the actor's) |
| Handouts, journal pages, roll requests | their own lists | no sight | unchanged |
| Build chunks, doors | `projectChunkForPlayer` | map knowledge | unchanged |

## 6. The model

### 6.1 Three sights

- **Sources** are chosen as today (design 9.10): party members that are visible, creatures, alive, not Unconscious, not inside the ground, at most 12 per scene in the fixed order. The union of all of them is today's party sight, bit for bit, so the cap, its order and the DM's list keep their meaning.
- **The shared sight** is the union over sources marked `partyVision`.
- **A player's sight** is the shared sight plus the sources the player owns (`ownsToken`: the token's `ownerIds` or its character's). A source owned by two players is in both. Only members of kind `player` have one. A DM is never in a list.
- **One level rule.** A source's level at a sub-cell is one function of its polygon spans, its senses and the light rows. The raster calls it, and so does the point query below, so a drawn tile and a token test never disagree.
- **A creature is in a player's sight** when any sub-cell under its footprint (the squeezed one while it squeezes, as today) has a level above 0 for the shared sources or the player's own. The query reads each source's spans and the shared light rows directly, so the reducer's marks and the projection need no raster of their own.
- **Rasters only for what is sent.** A player's tiles are drawn only while a socket holds them: a player, or a DM viewing as that player. Players with the same own sources share one raster (a sight group). So the cost follows connected sockets, not the roster.

### 6.2 Who sees what on a per-player scene

| Viewer | `sight` it receives | Creatures it gets |
| --- | --- | --- |
| A player | their sight | party members, exempt tokens, and others in their sight |
| A player with no source here | the shared sight | the same rule, so the shared sight only |
| A table display | the shared sight | as a player who owns nothing |
| A DM | the union, or one player's while viewing as them (7.4) | everything |

Every viewer also receives the shared sight as `sightAll` (7.5), for the rules that must read alike on every device.

### 6.3 Explored ground

`sys.explore` and the explored layer are unchanged: the actor explores from the union on the player scene. A player's fog is still the DM's layer and the explored layer merged, the same for everyone, so labels, stamps, pins, found traps, routes, door reach, Fit map and the map export are unchanged. Ground any player's creature saw shows to every player dimmed and empty (decision 6). That shows where some creature could see, never what stood there.

### 6.4 The marks

- `seenMark(state, token, env)` replaces the boolean where history is written. It returns `{ seen: true }` when the token is seen by all (decision 8), else `{ seenBy }`: the sorted ids of every member of kind `player` on the roster who does not own the token and has it in their sight, absent when empty. On a whole-party scene it returns what `seenByNonOwners` returns today, so those scenes write exactly today's marks.
- Written with `seenBy`: `PathStop`, `TurnStart`, `AboutCreature` events, `turn` events (`seenBy`, and `toSeenBy` beside `toSeen`), `area` events and `DiceRoll`. A row's set reads the encounter projection's own rule per player (`orderShown` with the viewer, then the token). A path's first stop copies its turn start's marks, the list included (`startStop`, and attach's copies onto a mount's path).
- Read: a player who does not own the creature gets the item when it has `seen` or `seenBy` names them. `creatureReach` and the `turn` case of `eventReach` return the owners plus `seenBy`. `stopsForNonOwners` and `projectTurnStart` take the viewer's id.
- **A reader's copy reads as seen.** When `projectEventCtx` gives a line to a player named in `seenBy`, their view carries `seen: true` and no `seenBy`. So the copy `lineReach` makes for them reads as theirs, and no player's data ever holds a list.
- **DM lines drop their lists once settled.** `Tx.settleLog` fixes each line's readers and makes the copies, then strips `seenBy` and `toSeenBy` from the DM line, whose readers are now fixed. Lists stay only on stops and turn starts, which projection reads later.
- **Unchanged one-bit marks**: `routeSeen` and `joinedUnseen` (a stop seen only through `seenBy` is not seen by all, so a joined leg through it keeps its mark from everyone but the owners), the area `hidden` mark, the trap line's `seen` indexes, `trapSeen.by` and `perceived`.
- **On a client** the reducer's marks are predictions, as today: the device holds only its own `sight` and `sightAll`, so `seen` reads `sightAll` and `seenBy` can only name the viewer. The server's marks replace them in the batch's `ev`.

### 6.5 Storage, versions and migration

```ts
Scene.vision?: { on: boolean, light: LightLevel, perPlayer?: true }   // stored only while true
PathStop.seenBy?: MemberId[]           // sorted, never with seen
TurnStart.seenBy?: MemberId[]
AboutCreature, area, DiceRoll: seenBy?: MemberId[]
turn event: seenBy?: MemberId[], toSeenBy?: MemberId[]
```

- **Snapshot version**, the next free one when the lane lands (24 at `cf98b4be`): the state schema (`server/rooms/stateSchema.ts`) learns the fields. No data step: an absent field reads as whole party and no list.
- **Op version**, the next free one (23 at `cf98b4be`): `scene.update`'s `vision` patch takes `perPlayer`. No op before it ran on a per-player scene, so replay keeps every older mark, and the marks follow the scene's flag, not the op's version.
- **Undo**: the switch is an ordinary scene edit, named "making sight per player on the scene Crypt" and "making sight whole party on the scene Crypt". `isGlobalChange` (tx.ts) compares `perPlayer` with `on` and `light`, for the edit, its undo and its redo.
- **Duplicate** keeps `perPlayer` with the rest of `vision`. **Room import** (`server/rooms/remap.ts`) keeps it, and maps every `seenBy` on stops and turn starts through `memberList`, dropping ids it does not map.
- **Existing rooms** need nothing: a scene is whole party until the DM chooses otherwise.

### 6.6 Limits

- `seenBy` names only players on the roster, at most 50 (`membersPerRoom`), each a 36-character id: about 2 KB at most, about 0.3 KB in a room of 8 players. A path holds at most 50 stops (`MAX_PATH_STOPS`), a fight one turn start.
- **Refusals must not read the lists.** Path stops and turn starts are measured state, and whether a stop names a player depends on another player's sight. So on a per-player scene the size guard counts each stop and turn start of a non-party token at its widest, as if its `seenBy` named every player on the roster, a reserve like the explored layer's (`exploredReserve`). The measure then depends on stops and the roster, which today's measure already reads, and never on who saw what. The switch to per player is refused with the room's full answer when the reserve does not fit.
- **Two sight maps per projection** on a per-player scene (`sight` and `sightAll`), so the sight reserve (`sightReserve`, sizeGuard.ts:237) counts twice for that scene, and turning per player on is refused when the scene cannot hold it.
- **Cache**: each sight group adds at most about 0.4 MB to its scene's entry (packed tiles and their encodings), counted in the cache's bytes under the existing 64 MB cap.

## 7. Proposal

### 7.1 The switch

In a scene's settings, Vision section (`client/features/vision/VisionSettings.tsx`), right under the Party vision switch and only while it is on:

- A row **Sight** with a two-option segmented control: **Whole party** (the default) and **Per player**.
- Its help line follows the choice. Whole party: "Every player sees what any party creature sees." Per player: "Each player sees only what their own creatures see, and what creatures that share sight with the party see. Explored ground stays shared."
- While the change is on its way the control shows busy and refuses another tap, and after about 200 ms the help reads "Working out what each player sees…" (or the existing "Working out what the party sees…" when going back).
- **Who lends the party sight** becomes **Who lends sight** on a per-player scene, and each lending row's last line names who gets it: "Lends its sight to Ana", "Lends its sight to Ana and Ben", or "Lends its sight to every player" for a creature marked to share. Rows that lend nothing keep their reasons. Under the list: "A player with no creature that lends sight here, and the table display, see only what creatures that share sight with the party see."
- Nothing else in the settings moves. The row sits right under the switch it qualifies, not at the end of the section, since it means nothing while Party vision is off and hides with it. In code it is added on its own lines.
- `perPlayer` counts only while Party vision is on. Turning Party vision off keeps the choice stored, so turning it on again brings it back.

### 7.2 Flipping mid-session

The edit sets `global`, so every viewer is projected again from the committed state:

- Each player's `sight` becomes their own sight (or the union, going back). A creature only another player sees leaves their map, its row leaves their tracker (with "Another creature's turn" while it acts), and its areas and kept rulers go with it. Going back, every creature in the union returns for everyone.
- Log lines a player already holds follow the read-time rule (design 7.3): a line about a creature out of their sight now drops from their live log until it is seen again. Nothing already written is rewritten: marks made under whole party keep `seen`, and lists made under per player keep their readers after a switch back.
- Drag previews and live rulers a player holds are judged again at once: the ephemeral channel re-judges every held preview on a `global` batch for its scene and sends `dragCancel` or `rulerEnd` to each receiver that may no longer have it.
- A DM viewing as a player keeps that player's sight on a per-player scene, and gets the union back on a whole-party one.
- The explored layer, the turn's path, the order and every fog rule are untouched.

### 7.3 What stays shared

The map and its memory (fog, explored ground, chunks, doors, labels, stamps, pins, found traps), the party's tokens, the tracker's order and `started`, the turn under way, handouts, chat and the roster. And every public rule of decision 8.

### 7.4 View as a player

- On a per-player scene, opening View as a player for a member sends `{ t: "sightOf", memberId }` on the DM's socket. The actor swaps the socket's held `sight` for that member's, sends the difference as one `ev`, and sets the derived `sightFor` key to the member. Closing the view sends `{ t: "sightOf", memberId: null }`, which brings the union back.
- The preview draws only once `sightFor` names its member. Until then it shows the shared loading indicator after 200 ms with "Loading what Ana sees…". If no answer comes in 10 s, or the socket drops, it reads "Could not load what Ana sees. Close and try again." It never draws the union as one player's view.
- DM sockets only. A `sightOf` from a player or display socket closes it with `4003`, as other frames only a broken client sends. At most one per second per socket, over that answered `retry` with `busy`, and the client keeps one in flight and sends the latest choice when it settles. A member who is not a player gets the union back, with `sightFor` removed.

### 7.5 Projection and fan-out

- **Keys.** `sight:<sceneId>:<tx>,<ty>` keeps its shape and is the viewer's own. On a per-player scene a projection also holds `sightAll:<sceneId>:<tx>,<ty>`, the shared sight, in a `sightAll` map, and a DM's holds `sightFor` while viewing as a player. `allKeys` and `sightKeys` list them.
- **Ctx** gets `sight(sceneId)` per viewer: the union for a DM (or `sightFor`'s member), the viewer's own for a player, and `sightAll` on a device. `partySightOf` keeps its name and means "seen by all": the union on a whole-party scene, the shared sight on a per-player one. New `memberSight` and `unionSight` sit beside it in `visionRules`.
- **Fan-out.** `sightAll` joins `SAME_FOR_EVERY_PLAYER`. `sight` leaves it on per-player scenes and is projected once per sight group, each changed tile object hashed once per group. A DM socket's viewer class (`viewerClass`, fanout.ts:37) adds its `sightFor`, so two DMs on one scene never share a projection while one views as a player. `changedSightKeys` diffs the union, the shared sight and every held group, and `tileDependents` takes the union of their changed tiles, so a token on a tile that changed for any group is projected again for every viewer.
- **Ephemeral.** `withheld()` (ephemeral.ts:183) is worked out per sight group instead of once for all players. The walker test inside it keeps `inSightOfNonOwners` (seen by all), the spot test reads the receiver's sight. The DM's frames go everywhere, as today.

## 8. Cost and risk

### 8.1 Measured and estimated

Measured on a development laptop with Node 24, at the vision gate's caps (`capRoom` of scripts/bench-vision.ts: 200 x 200 cells, 6,000 sight pieces, 12 sources with 150 ft darkvision, 120 lights), medians of 5 to 15 runs, by a scratch script not committed. The server box runs about 1.5 times slower.

| Work | Union of 12 sources (today) | One player's sight |
| --- | --- | --- |
| Every tile drawn again, bright (a senses edit) | 1.6 ms | 0.5 ms |
| One source moved, bright | 3.8 ms | 2.9 ms, of which its sweep is shared with the union |
| One source moved, dark | 6.8 ms | 5.9 ms, the same |
| Cold, bright | 29.9 ms | 3.1 ms with its own sweep |
| Cold, dark | 103.8 ms | 72.9 ms, almost all of it lights, which are shared |

- **Per op**, a move adds one group's redraw over the move's dirty tiles to today's work: under 1 ms on a bright scene, an estimated 1 to 3 ms on a dark one. Other groups' rasters are untouched.
- **Cold** (room load, the switch, a light level change), 8 connected groups add about 8 x 0.5 ms bright and an estimated 8 x 3 ms dark: the dark first snapshot measured at about 126 ms on the laptop becomes about 150 ms, about 225 ms on the server, under the 250 ms budget. The gate measures it (section 10).
- **Projection per player per op, full room (8 players, 500 tokens).** The fan-out already projects tokens per player. Per player adds only the point query per token, at most 12 sources' boxes and 16 sub-cells for a Medium creature: estimated 1 to 3 microseconds, so a `global` batch (the switch, a fog change) re-projecting 500 tokens for 8 players adds about 4 to 12 ms. Each mark asks at most the roster's players, under a millisecond for 8.
- **Bandwidth.** A player's own sight is at most the union, so their tiles are no more than today. `sightAll` is empty unless a shared-sight creature is on the scene. A DM receives the union as today, plus `sightAll`.
- **Log rings.** A line some players saw becomes a party line: a DM line and a copy per reader. Each member keeps 50 copies (fewer past 8 members), where shared lines keep 200, so on a per-player scene a player's live log of monster lines is shorter. Older lines stay in the archive's pages.

### 8.2 Every seen bit that becomes a set

| Mark | Where it lives | Set | Limit |
| --- | --- | --- | --- |
| `PathStop.seen` | the token's path | `seenBy` | 50 players a stop, 50 stops a path, measured at its widest (6.6) |
| `TurnStart.seen` | the encounter | `seenBy` | 50 players, one a fight, measured at its widest |
| `AboutCreature.seen` (hp, rest, concentration, effect, use, death save, life) | log | `seenBy` | stripped from the DM line when settled |
| `turn` `seen` and `toSeen` | log | `seenBy`, `toSeenBy` | stripped when settled |
| `area` `seen` | log, reminders | `seenBy` | stripped when settled |
| `DiceRoll.seen` | log, each roll | `seenBy` | 20 rolls a line, stripped when settled |

### 8.3 Risks

1. **The boundary grows again.** Creature visibility now depends on ownership as well as geometry. The property and differential tests of section 10 are the guard, against an oracle that recomputes each player's sight from nothing.
2. **Public rules see less.** On a per-player scene a creature not in the shared sight is unseen by every public rule, as a creature under fog is today. A DM's horse a character rides shares no turn with its rider, a monster's trap goes off unperceived, and its route corners stay hidden. The fix is the DM marking it "Always visible, even under fog" or "Shares sight with the party". The DM guide says so.
3. **Explored ground hints.** A dimmed patch can appear far from a player's own creatures where another's sight reached, such as round a monster's torch. Accepted with decision 6. It never carries a creature.
4. **Cold sight on the event loop.** Bounded by connected groups and gated (section 10).

## 9. Security rules

1. A player's projection judges creatures by that player's sight alone: the shared sight plus the sources that player owns in the committed state. It never reads another player's sources.
2. Every public input reads only seen by all, which is the shared sight on a per-player scene: refusals, limits, traps, attach groups and turn sharing, routes and shared rulers, copied rulers, undo's silent passengers. No player's bytes, refusal or drag frame may depend on what only another player's creatures see.
3. `seenBy`, `toSeenBy` and `sightFor` reach DMs only. A reader's copy says `seen: true` and holds no list.
4. A player gets a past stop, turn start or line about a creature only when they own it, it was seen by all, or `seenBy` names them. A later joiner and a table display get only what was seen by all.
5. Only the server writes marks. A device's marks are predictions, replaced by the batch's `ev`, and decide nothing any other viewer receives.
6. `sightAll` is the same for every viewer of the room and never holds a player's own sight.
7. A swapped sight (`sightOf`) goes only to the DM socket that asked. A player or display socket that sends `sightOf` is closed with `4003`.
8. Drag frames, live rulers and their cancels are judged per receiver by the receiver's sight. A frame withheld from one player is never inferred from another's.
9. Fail closed. A device on a per-player scene with missing or unreadable `sight` tiles sees nothing in sight, and missing `sightAll` tiles count as no shared sight.
10. Measures read no list: path stops and turn starts count at their widest on per-player scenes (6.6).
11. Blackout still comes first: nothing behind it is seen, by any player.

## 10. Tests

- **Rules (PV2).** A player's sight equals a cold computation over the shared sources and their own, bit for bit. The union of every group and the shared sight equals today's party sight on the gate's scenes and on random ones. The point query equals the raster on random footprints, squeezed and Tiny included. Shared is within each player's, and each player's within the union. Groups drawn lazily equal cold after random moves, lights, doors and ownership changes. Golden bits for one per-player scene. The banned-functions test covers the new code.
- **Property test (PV1)**, random rooms of 1 to 8 players with shared characters, lent monsters, companions, shared-sight creatures, sources past the cap, down and Blinded sources, walls, lights and all three levels, under random op sequences that include the switch both ways and its undo, ownership changes, Next and Previous, and a blackout:
  - For every viewer, its events applied to its snapshot equal `projectState` (design 7.3's invariant), the display included.
  - No player's projection holds a non-party, non-exempt creature outside that player's sight, judged by an oracle that recomputes it cold.
  - No stop, turn start, line or roll about a creature reaches a player who neither owned it nor had it in sight at the moment it was written, judged by the oracle's record at each mark.
  - No player's data holds `seenBy`, `toSeenBy` or `sightFor`, and `sightAll` is equal for every viewer.
- **Differential (PV1, shared/differential.ts).** Paired rooms that differ only in what one player's creatures see (a torch radius, a goblin inside or outside that light, a lent monster's senses): every other player's and the display's `ev` streams, drag frames, refusals and limit answers are identical.
- **Marks (PV1).** `seenBy` sorted, players only, no owners, absent with `seen`. Settled DM lines hold no lists. A whole-party scene writes exactly today's marks (the existing tests of the marks pass unchanged).
- **Server (PV3).** Fan-out hashes each group's changed tile once, and the switch reaches every socket. `sightOf` swaps one DM socket only, refuses players with `4003`, keeps its rate, and falls back to the union. Size guard: two sight maps reserved, stops counted at their widest, the switch refused when either does not fit. Import remaps `seenBy`. Ephemeral frames judged per receiver, and held previews cancelled on the switch.
- **Bench (PV2).** `scripts/bench-vision.ts` and `scripts/bench-server4.ts` gain rows at the caps with 8 groups: a move, cold bright and dark, and a `global` batch of 500 tokens for 8 players, gated at today's budgets.
- **e2e (PV5)**, `e2e/pervision.e2e.ts` with two players on one dark scene (steps `pv-1` on):
  1. The DM turns Sight to Per player. Thorn's player sees a goblin in Thorn's torchlight and its row, and Bree's player sees neither, and "Another creature's turn" while it acts.
  2. View as Bree shows no goblin and View as Thorn shows it, after its loading line.
  3. Whole party again: the goblin appears for Bree at once, and back to Per player it leaves.
  4. Ground Thorn explored shows dimmed for Bree, empty.
  5. No frame Bree's page received held the goblin while per player, and no page logged an error.
  Run with `reach`, `vision` (touched rules) and `display` (the display's sight). `e2e/alignment.e2e.ts` adds the Vision section of the scene settings as a root, which it does not cover today.

| Case | Expected | Test |
| --- | --- | --- |
| An existing scene, or a backup from before | Whole party, the same marks and bytes as today | PV1 golden replays, migrate test |
| Per player, goblin in Thorn's torchlight only | Thorn's player gets it, Bree's player and the display do not | property, e2e pv-1 |
| Bree's player opens devtools | No goblin, no row, no `seenBy`, no frame, no copy of its lines | property, e2e pv-5 |
| A creature marked "Shares sight with the party" | Every player sees what it sees, the display too | PV2 rules, property |
| Thorn is Unconscious | Thorn's player sees only the shared sight and explored ground, Thorn still shown | property |
| Two players share a character | Both see through it | PV2 rules |
| A monster lent to Bree's player | Bree's player sees through it, and it stays shown to all | property |
| A player with no creature on the scene | The shared sight | property |
| The goblin's turn, seen by Thorn's player only | Thorn's player gets its start, stops and turn line. Bree's player gets "Another creature's turn" | property, e2e pv-1 |
| HP line for the goblin seen by Thorn's player only | A party line: a copy for Thorn's player, none for Bree's | marks, property |
| A player joins mid-fight | Gets only what was seen by all | property |
| The switch back to Whole party | Union for all at once, old lists keep their readers | property, e2e pv-3 |
| The switch mid-drag | Players who may no longer see the drag get its cancel | PV3 ephemeral |
| A trap the goblin sets off, seen by Thorn's player only | Not perceived: no players' line, no found mark | PV1 differential |
| A DM's horse ridden by Thorn, not shared | No turn sharing until it is Always visible | PV1 differential |
| View as Thorn's player before the swap lands | Loading line, never the union | PV4 unit, e2e pv-2 |
| A player socket sends `sightOf` | Closed with `4003` | PV3 |
| A room near its byte limit turns per player on | Refused with the room's full answer | PV3 size guard |
| 8 players, 500 tokens, dark scene at the caps, cold | Under 250 ms on the server box | PV2 bench |

## 11. UI checklist

- **Words**, exactly: "Sight", "Whole party", "Per player", the two help lines and the busy line of 7.1, "Who lends sight", "Lends its sight to Ana", "Lends its sight to Ana and Ben", "Lends its sight to every player", the list's note, "Loading what Ana sees…", "Could not load what Ana sees. Close and try again.", and the undo names of 6.5. A player's drop note on a per-player scene reads "Goblin is out of your sight now." or "3 creatures are out of your sight now." (`intoFogText`, client/canvas/dragNotes.ts).
- **Loading.** The control is busy and refuses a second tap until its op is acknowledged, with the shared indicator after 200 ms. The preview waits as 7.4 says and always ends in its view or its error.
- **Keys and focus.** The control is a radio group: Tab reaches it, arrows move between the two, and focus stays on it through the change and its busy state. No new shortcut, so the shortcut sheet and FEATURES.md's key list are unchanged.
- **Screen readers.** The group is named "Sight" and described by its help line. Busy sets `aria-busy` and the working line is a polite status. The preview's loading and error lines are a status.
- **Large interface sizes.** At 130% the two options stay on one row at 320 px or wrap whole, never mid-word. Measured with `measureAlignment` at 1440x900, 390x844 and 320x568, at 100% and 130%, nothing over 1 px: the scene settings' Vision section (new root) and the preview's loading state.
- **Phones.** The settings are the existing sheet, 44 px targets, nothing on hover or long-press.

## 12. Lane plan

| Lane | Owns | After |
| --- | --- | --- |
| **PV1 Contract and marks** | `shared/model.ts`, `shared/protocol.ts` (`perPlayer`, `sightOf`), `shared/keys.ts` (`sightAll`, `sightFor`), `shared/migrate.ts`, `shared/ruleHooks.ts` (`memberSight`, `unionSight`), `shared/project.ts` (per-viewer `Ctx.sight`, `seenMark`, the readers, `sightAll`, `changedSightKeys`, `tileDependents`), `shared/rules/path.ts`, `shared/reducer/tx.ts` (`isGlobalChange`, `about`, `settleLog`), the mark writers in `shared/reducer/encounter.ts`, `tokens.ts`, `dice.ts`, `areaTriggers.ts` and `attach.ts`, `shared/reducer/trapNotice.ts` (union), `shared/differential.ts` generators, `server/rooms/stateSchema.ts`. Unit, property and differential tests, with the rules stubbed through `visionRules` as today's tests do. | the current scope |
| **PV2 Rules** | `shared/rules/vision.ts` (owner groups, shared sight, the level function, point query, lazy group rasters, cache bytes) and its tests, `scripts/bench-vision.ts`, `scripts/bench-server4.ts` | PV1's hook types |
| **PV3 Server** | `server/rooms/fanout.ts`, `server/rooms/ephemeral.ts`, `server/rooms/actor.ts` and `server/rooms/ws.ts` (`sightOf`, its rate, per-socket `sightFor`), `server/rooms/sizeGuard.ts`, `server/rooms/remap.ts`, `server/rooms/explore.ts` (union), integration tests in a new `server/rooms/pervision.itest.ts` | PV1, PV2 |
| **PV4 Client** | `client/features/vision/*` (the Sight row, the lending list), `client/features/dm/preview.ts` and `PlayerPreview.tsx` (`sightOf`, loading), the socket client's message list, `client/canvas/dragNotes.ts`, `client/features/outliner/rows.ts` and `client/features/encounter/logic.ts` (union reads) | PV1 |
| **PV5 Integration and docs** | `e2e/pervision.e2e.ts`, the Vision root in `e2e/alignment.e2e.ts`, docs/design.md (7.1 `sightOf`, 7.3, 7.6, 9.10, 13.5, 13.6), docs/design-v1-maps-vision.md (pointers at 4.3.2 and 4.3.10), docs/features.md, `FEATURES.md`, docs/dm-guide.md (Light and party vision: the Sight row, what the display shows, risk 2's fix, with new screenshots), this note's As built | all |

- PV2 and PV4 run beside each other once PV1's contract commit lands. PV3 needs PV2's rules. Each lane's new e2e steps take its prefix, and `pervision.e2e.ts` takes a port offset no other file uses.
- Each new test fails with its fix removed. The mutants to check: the own-sight filter (pass the union instead), `seenBy` including owners, the copy keeping `seenBy`, `sightAll` given a player's own sight, `partySightOf` reading the union on a per-player scene, the ephemeral spot test read once for all players, and the widest measure counting real lists.
- FEATURES.md and the guide change in PV5's last commit only.

## 13. Out of scope

Explored ground per player (decision 6). Door state remembered per player. Traps found or perceived per player, and every other public rule per player (decision 9). Per-player light levels. A player-side notice when their creatures cannot see (decision 12). The DM seeing several players' sights at once.

## 14. As built

The builder fills this in the lane's docs commit with every place the build went its own way.
