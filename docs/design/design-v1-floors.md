# Several floors in one scene: phases 1 to 3

## Summary

A scene can hold a tower, a keep or a cellar as up to 8 floors. Each floor is a scene linked to its main floor, so it keeps its own map, build, fog, light, weather, scene sound, tokens, traps and explored ground, while the Scenes list, the grid shape, the 500 tokens, the 200 areas and the size budget belong to the whole scene. The DM builds floors in the scene's settings and moves creatures between them with Move to floor. A player's device holds only the floors their party has reached and the floors where a creature they own stands, and shows the floor of the creature it follows.

This note is the design as built in phase 1. Phase 2 (stairs and ladders players take themselves, keeping the turn's feet) and phase 3 (floors from Universal VTT files and generated dungeons, the walking ruler over stairs, and Move to floor in the search) are built, and their designs as built are the last parts of this note. The later phases (openings and falls, sight between floors) are not built. The design's full text, with its rounds of review, is kept outside the repository, and this note gives what was built and where the build went its own way. Decision ids are in the project's decisions log.

Versions: OP_VERSION 56 and SNAPSHOT_VERSION 43. The snapshot step is the identity, since `Scene.floor` and the room's `openFloors` are optional and absent reads as a scene of one floor, so no data migrates. The number moves so that an older build, which knows nothing of floors, refuses a v43 snapshot (its Delete would remove a main floor alone and leave the other floors naming a scene that is gone).

## 1. Model

- `Scene.floor?: { of, level, name, height }`. `of` names the main floor, which holds the scene's place in the list, its folder, order and thumbnail. `level` runs 0 to n - 1 from the lowest. `name` is unique in the scene and at most 40 characters. `height` is feet above the floor below, 5 to 50 in steps of 5, 10 by default. Every floor's record name is the scene's name. A scene of one floor has no `floor`.
- `RoomState.openFloors?: Record<SceneId, SceneMark>`: one mark for a floor that is open to the players (reached or shown). It is bookkeeping outside undo, written by `markOpened` after every op from op version 56, and a floor stays marked when the players leave it. A DM's projection carries it as `keys.opened` and `openFloors`.
- A player's copy of a floor is `{ level, name }`, numbered among the floors that player holds and sent only while two or more are held, with `unseen` on a floor no player sees, which the player holds only through a creature the DM hid. `of` and `height` stay the DM's.
- `meta.partyFloors` is on a table display's copy only: the held floors with the most unhidden party members, lowest first, absent when empty.
- The rules live in shared/rules/floors.ts: `floorsOf`, `startFloor`, `onPlayersScene`, `openFloor` (blind to a blackout), `playersSee`, `heldFloors` and `floorProblem`. `floorProblem` runs beside `checkLimits` in the actor and on import, never in the reducer, so a pending replay on a redacted copy never meets it.
- Ops: `scene.create` takes `floor: { beside, side, besideName? }`, `scene.update`'s patch takes `floor: { name?, height? }`, and `floor.order` and `floor.open` are new. Ephemeral events from the server carry `sceneId`.

## 2. Rules

- A new floor copies size, background, grid look and shape, what players see, light with Time of day, Sight, walls block moves, automatic walls and suggested view from the floor beside it. It has no map, build, fog, contents, weather or scene sound. The scene's first added floor names the original one "Ground floor", and a new one is "New floor", then "New floor 2" and on while the name is taken.
- Remove floor is refused on the main floor, on the start floor and while an unhidden party member stands there. Hide from players is refused on the start floor and while an unhidden party member stands there on the players' scene. Delete of a main floor removes every floor and waits while the players start on any of them. A removal that leaves one floor makes a plain scene again, and its undo brings the floors back.
- A grid shape change on a scene of several floors is refused, and so are a ninth floor and a name the scene has.
- Traps go off by themselves only on floors players have reached, outside a blackout, and a walk's traps fire on the floor of its first named token. Sight and light never cross floors.
- Six questions replace "the players' scene" wherever it was asked: `playersSee`, `openFloor`, `onPlayersScene`, `heldFloors`, `startFloor` and co-location, the same floor compared by `sceneId`. Each site of design 8.3 asks the one that fits.
- Move to floor moves creatures to the same squares on another floor, standing on its ground (a flier keeps its height), with what they carry, drag and their areas. Each creature it names drops its nudge and squeeze as in a move to another scene, and its path, so Moved starts again.

## 3. Privacy

Each recipient's projection covers a held set of floors, decided before any cache is shared. A floor not held sends nothing: no record, name, count, image, video, token, row, ping or log line, and the asset route answers 404 for its files. The fan-out projects each socket's held floors, and a change of the held set re-projects the whole copy. Ephemeral events reach only the sockets that hold their floor, with their tokens on it. The size guard measures a scene's floors together, and explores each floor the players see.

## 4. Client

- The store's `floorView` is the cut of the room for the floor on screen. Every reader in the board's folders takes floor-bound collections from it, and a guard test (canvas/floorViewReads.test.ts) fails if one reads `view` instead. Readers that mean every floor (the tracker, dice, rolls, combat, reminders) stay on `view`.
- Floor in the top bar, the Floors menu, the Viewing notice, `[` and `]`, a player's follow rule, a table display's party floor, the turn chip's floor, the party panel's and the tracker's floor tags and the search's Floor rows are in client/features/floors/. The Floors group and a floor's page are in client/features/scenes/ (FloorsGroup.tsx, FloorPage.tsx, floorWords.ts), Move to floor in client/features/tokens/, and the DM menu's floor words in client/pages/chipWords.ts.

## 5. UI checklist

- **Loading:** a floor's map says "Loading Upper floor…", Add a floor and Move to floor show busy and refuse a second tap, and each has a plain refusal.
- **Keys and focus:** `[` and `]` step through floors with nothing open and say so at the top and bottom. A pick in Floors closes it and returns focus to Floor. Back on the Viewing notice puts focus on Floor, or on the map where Floor folded into the Menu panel.
- **Screen readers:** "Showing Upper floor." and "Thorn is on Upper floor. Showing Upper floor." are polite statuses, and each Floors row's name carries its marks.
- **Large sizes:** Floor, Floors, the Viewing notice, the Floors group, a floor's page, the DM menu on an unreached floor, the party panel and the tracker row are measured at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within 1 px (floors-view, floors-menus and the alignment files).
- **Words:** quoted in FEATURES.md and the DM guide.

## 6. Cases

| Case | Expected | Test |
|---|---|---|
| A room with no floors | Projection, permissions, seen marks and replay as before | floors.replay.test.ts |
| The first add, a second add, two co-DMs at once | "Ground floor", "New floor", "New floor 2" | reducer/floors.test.ts |
| A ninth floor, a shape change, a name taken | Refused in the design's words | floorProblem.test.ts, permissions.floors.test.ts |
| Players on Ground, floors unreached below, between and above | No trace of them in any snapshot, key, row, asset or log line | project.floors.test.ts, floors.differential.test.ts, floors.wire.itest.ts |
| Ana's creature upstairs, Bree and the display beside her | Ana holds Upper, the others get nothing of it, in both connection orders | floors.wire.itest.ts |
| A trap on a floor not reached | Never goes off by itself | floors.wire.itest.ts, rules tests |
| Remove with the party there, Hide with the party there on the players' scene, Delete while the players start on one of the floors | Refused with the reason shown, and Hide goes on a scene the players are not on | permissions.floors.test.ts, floorWords.test.ts, floors-build.e2e.ts |
| Move to floor of a nudged or squeezed token, then undo | Lands unnudged and unsqueezed on the ground of its full space, and the undo puts both back | reducer/floors.test.ts, moveToFloor.test.ts |
| A rider and its mount, or a chain of three, named in any order | Every link holds on the new floor, and each creature named drops its nudge | moveToFloor.test.ts |
| A ruler, area or drag that ends or goes on after `[` or `]` | Its end goes to the floor it was drawn on, before any frame on the new one | socket.test.ts |
| Thorn moves to Upper | Ana's phone follows and says so, Bree's desk stays, the DM's menu marks Upper | floors-view.e2e.ts |
| Ana picks another floor | "Viewing Ground floor." with Back to Thorn, in line at every size | floors-view.e2e.ts |
| A fight across floors | Rows of both floors, tagged, the turn chip's name ending "on Upper floor" | floors-view.e2e.ts, floorRow.test.ts |
| A tracker or search row on another floor, and a player's selected companion moved upstairs | The floor shows with the creature selected, and the player's device stays with the companion | scene.test.ts, store.floors.test.ts, floors-view.e2e.ts, floors-menus.e2e.ts |
| Ana asks for saves upstairs with a hidden creature, which the DM brings down and gives to Bree | No snapshot or frame of Bree's names Upper | project.floors.test.ts, floors.wire.itest.ts |
| A hand-made group move across two reached floors, an area changed to a caster on another floor | Refused | permissions.floors.test.ts, floors.wire.itest.ts |
| A drag on a floor held only through a hidden creature, and the DM's on a floor not reached | The device counts the dragged group as the server does | floors.differential.test.ts, project.floors.test.ts |
| The display with the party split, then joined | Ground, then Upper with "Weather here: Heavy rain, Strong wind." | floors-view.e2e.ts |
| Bring everyone here on a floor not reached | Off, with "Players haven't reached Attic, so their maps stay." | chipMenus.test.ts, floors-menus.e2e.ts |
| Random adds, removals, moves, undos and held-set changes | floorProblem holds, no unheld floor in a player's copy, an incremental copy equals a fresh one | floors.random.test.ts |
| 20 switches among 8 floors, one with a video and one with rain | Heap within 10% over the last 10 | floors-view.e2e.ts |

## As built

Where the build went its own way, with the decision ids from the decisions log (D-261108-270 to 380, and 421 to 437 for the fixes after review):

- **Shared rules.** `SceneFloor.of` and `height` are optional, since a player's copy lacks them (D-261108-270). An add's `scene` carries only id, name and size, and the reducer copies the rest. `floorProblem` also holds every floor's record name to the main floor's. The floor rules restate the party and ownership tests, because limits.ts sits in sight's arithmetic closure and must not import project.ts, and a test holds both to project.ts. Reorder and Duplicate naming a floor that is not a main floor are refused, not mapped.
- **Projection.** `viewerFloors` takes a scene without floors as itself alone and skips `heldFloors` (D-261108-283), `partyFloors` is absent when empty (D-261108-280), and the DM gets every opened mark (D-261108-281).
- **Server.** The explore step runs on every floor players see, per-player floors included. Every scene-budget refusal of a floor add reads the floor words, and players' memory is reserved on every floor of their scene (D-261108-290 to 297).
- **A pick in Floors closes it**, because Room.tsx closes an open pop-up whenever the scene shown changes. The DM's marks say "Reached", since one opened mark cannot tell "Reached" from "Shown to players" (D-261108-300 and 301).
- **Moving to a floor** lands a creature on the new floor's ground under its full space, since the move drops a squeeze, and keeps a flier's height. Whether it stood on the ground reads the space it stood in, squeezed or not (D-261108-425). Move to floor had no search entry in this phase, since its control is in the action bar and the More sheet, which carry no search anchors (D-261108-350). Phase 3 added selection rows for it.
- **A floor's page** has Back to Floors alone on its row with no tag, and Go to this floor on a row of its own, since a tag or a third button wrapped alone at some sizes (D-261108-351). An off Bring everyone here shows its reason as a dim line (D-261108-352).
- **The floor on the DM's screen** wears an On screen tag in the Floors group, and the folded group says "3 floors · Upper floor on screen". "Shown" read as shown to players beside Show to players, and the page's button reads Go to this floor for the same reason (D-261108-379 and 380).
- **The party panel** reads "On Upper floor" for a member on another floor of the scene, and a tap shows that floor (D-261108-353). A floor's map says "Loading Upper floor…" (D-261108-354).
- **View as a player** follows a floor pick in its own socket store, which sends nothing, and the Viewing notice stays off in a preview (D-261108-355).
- **A floor's mark** is one rule in the Floors group and the Floors menu: "Players here" on the start floor and where an unhidden party member stands on the players' scene, "Reached" by an opened mark, and a party member on a scene the DM prepares in private opens nothing (D-261108-357). Hide from players reads the same rule, so it goes there, while Remove floor still waits for the party on any scene, since a removal deletes them.
- **Move to floor sends holders first**, down every chain of links, because the server takes each creature's op alone and a rider sent before its mount would come loose. The mount takes its rider along, and the rider's own op then names only the floor, which drops its nudge and keeps the height the mount carried it to (D-261108-428). A creature dragged along lands on the ground under its own new space, or, when it was in the air, keeps its height over its holder but never goes below the ground. The reducer's plan gives both heights for a move between floors of one scene from the floors op version, so stored moves to other scenes replay as before (D-261108-433).
- **A preview's end** goes to the floor its frames went to, though the floor shown changed since, and a preview that goes on after a switch ends on the old floor first, since the server routes an end only to the floor it names.
- **Replacing a floor's map** asks first on every open floor of the players' scene (D-261108-358). The tracker row's floor tag, which the design listed and no lane owned, was built in the wiring commit with the floors icon (D-261108-359).
- **The action bar** reads `floorView` wholesale, as the board does, and the guard test checks it (D-261108-360).
- **A switch of floors keeps the selection** on the floor now shown and lets go of the rest, since Room lets go of it on a change of the scene projected rather than of the floor shown. A start floor moved within the scene lets go of nothing. So a tracker or search row on another floor selects its creature, and a player's device stays with a selected companion that moved (D-261108-421).
- **An ask for saves** made on a floor carries a mark, from the floors op version, which the DM's copy, backups and the DM's reopened save page keep and no player's copy carries. Only the server marks, so a player's device predicts its own ask as the projection sends it (D-261108-432 and 434). A marked ask, or one whose scene has floors now, reaches only a player who holds its floor, and only such a player may withdraw it or count it among their asks waiting. That holds whatever becomes of the floor, so an undo that brings an ask back after its floor is gone still reaches no one else (D-261108-431). A marked ask goes when its floor stops being one, in the op's undo step, so the undo brings it back: a floor removed by Remove, Delete or the undo of its add, the floor a removal leaves alone (D-261108-426), and the main floor when the scene's first add is undone. An ask made before the scene's first floor was added carries no mark and stays through that add's undo. On a scene without floors, or naming no scene, an unmarked ask still follows its player to another scene, as before (D-261108-422 and 427).
- **A group move names one floor's creatures:** the server refuses a hand-made `token.moveMany` across floors from anyone, since a walk's traps go off on its first token's floor alone. An area's caster and what it follows stay on its floor when the area changes, as when it is made (D-261108-423).
- **A floor no player sees**, which a player holds only through a creature the DM hid, carries `unseen` on that player's copy, and the server's seen marks and every device's count of what all players see read one rule, `unseenFloor`, the DM's device included, so a drag there takes the group the server takes. A player's copy holds no opened marks to work it out from (D-261108-424).
- **A scene of one floor is cut too** while the view holds another scene's records, as a DM's predicted ops on a scene not shown add them, so the board draws nothing new for a dungeon's Make. A view with nothing on another floor is still given back as it is (D-261108-436).

Not built in phase 1: Universal VTT files and generated dungeons onto a floor, seeing between floors, and a Move to floor entry in the search. Phase 3 built the first and the last, and seeing between floors is phase 4.

# Phase 2: stairs and ladders

Players take stairs and ladders themselves, and the turn keeps its feet across floors. This part is the design as built. The full text, with its five rounds of review, is kept outside the repository. Decisions: D-261109-011 to 030 (some revised in review), D-261109-099 to 104, 106 and 108, and D-261109-130 to 152 from the build.

Versions: OP_VERSION 58 and SNAPSHOT_VERSION 45 (`FLOOR_LINKS_OP_VERSION`, `FLOOR_LINKS_SNAPSHOT_VERSION`, gate `floorLinksOps`). Both steps are the identity, since an absent `floorLinks` and `prior` read as none. The snapshot number moves so that an older build refuses a v45 snapshot: it would keep creatures on floors only stairs let them reach, drop the feet a turn took on floors left, and leave ends naming a floor it removed. From the op version a change of floor within one scene folds the turn's path into `prior` in place of dropping it, and every op ends by taking away the stairs whose floors went.

## 7. Model and ops

- `RoomState.floorLinks?: Record<FloorLinkId, FloorLink>`, key `floorLink`. An end holds `sceneId`, `to` (the floor just above or below), `pair`, `rect` (1 to 4 a side, the same on both ends), `kind`, `locked`, `grid` (the hex shape it was written under), `ground` (the one height of its squares, fixed while the pair stands) and `made` (the seq of the op that placed the pair, never reused). Code names are `FloorLink` and `floorLink`, since Attach already calls a holder's tie a link (D-261109-011).
- `TokenPath.prior?: PathPrior { moved, cost, diag, seenDiag }` holds the legs on floors left. The first stop of a path is where the creature's moves on this floor began.
- Ops: `floorLink.put` (DM, Setup, writes both ends), `floorLink.update` (`kind` and `locked`, Play when `locked` alone), `floorLink.delete`, and `token.climb { tokenId, linkId }` (Play, a pose op, planned by the reducer with the scene-change plan of `tokenUpdate`). `sys.restore` may carry a server-made `climb { tokenId, linkId, rev, made, from, to }`, never from a device.
- Limits: 16 pairs a scene (`LIMITS.floorLinksPerScene`), 4 a side. The size guard counts both ends.
- `floorProblem` holds each end to its pair, floors, shape, squares, ground and the walls and pits there. It reaches the stairs' rules through a hook that `rules/floorLinks.ts` sets as it loads (D-261109-133). `scenesOf` and `floorsWritten` name the floors a climb, a stairs op, a trap op and any chunk write touch, so every op meets the check.
- A trap's 50 per scene now checks when a `trap.create` is made, since the trap op meets its scene's checks.

## 8. Climbing

- Cost: stairs the upper floor's height, a ladder twice it without a Climb speed, prone adding crawling's foot. No terrain, area or diagonal. The climb is the new floor's first leg, two stops on one spot, the second holding the feet, so two stops draw no line and non-owners read 0 ft.
- A holder the requester does not receive counts as absent, so its rider climbs alone. A seated creature the requester does receive is refused (D-261109-130). A dragged creature is let go, as at a teleport.
- A player's climb waits for the server, since only the DM's device holds the far floor whole to work the climb out, and only it predicts the climb (D-261109-102). Phase 3 sends a player who holds both floors the climb's height as `rise`, for the walking ruler, which changes neither rule. A second press or key sends nothing while one is out (D-261109-139).
- Move to floor keeps the turn's feet too (D-261109-016).
- The walking ruler and a drag do not route through stairs (D-261109-029). Phase 3 lets a walking ruler be carried over them by a button. Landing sets off no trap or area reminder (D-261109-027).

## 9. Undo

- The actor keeps the `climb` record on the climb's step, the DM's too, and copies it onto a player's `sys.restore`. `pushRestored` copies it both ways, and a climb step never merges with another (D-261109-148).
- An undo reads the end on the creature's floor now, which must be the stored end's pair at the stored `rev` and `made`, unlocked, holding the creature's space. A redo reads the stored end. Else "the stairs changed", naming the end's current kind (D-261109-132). A pair placed again has a new `made`, so an old step fails.
- The climber, its passengers and their areas go back with it. An area follows the creature it follows now, and one it cannot put back is left out without a word (D-261109-147).
- A DM's undo or redo that a stairs rule refuses keeps its step, in words true whoever placed the stairs (D-261109-108). An end no DM edit explains drops the step (D-261109-134).
- A backup carries `floorLinks` and `prior`. Its import remaps ids, keeps `made` and starts its op numbering past the largest. A backup holds at most 800 ends (D-261109-149).

## 10. Privacy

A player's copy of an end is built field by field from `LINK_FOR_PLAYERS` (D-261109-135): no `pair`, `ground` or `made`, `to` only while that floor is held, `dir` added from the levels, `rev` zeroed. It is sent on a held floor outside a blackout, not under full fog, as a found trap is, and a per-member kind re-projects it on a held-set change, fog under it or a level change, with no cache across viewers (D-261109-136). Owners get `prior` whole and other players `seenDiag` alone. The twins in `floorLinks.differential.test.ts` and `floors.wire.itest.ts` hold the answers equal across far-floor differences. Three channels are accepted: the climbed height to the climber's owners (D-261109-100), "Stairs up" telling a player that a floor lies next to this one (D-261109-101), and a floor change out of sight restarting a hidden creature's trail.

## 11. Client

- Go up and Go down lead the bar's passing row and take Roll's place in a phone's strip, as words or the stairwell icon, and `}` and `{` press them (D-261109-019, 020). An off button stays dim with its reason, and a press says it again (D-261109-141).
- `LinkLayer` draws each end under the fog, named by what the viewer holds, flat in Isometric with its name standing up.
- The builder's Between floors mode, its pane, and the floor page's reasons are in `client/features/builder/` and `client/features/scenes/`. Every word is in `client/features/floors/linkWords.ts` and `shared/rules/floorLinks.ts`.

## Phase 2 as built

Where the build went its own way:

- **The icon.** Lucide 0.525.0 has no `door-stairwell`. It is copied from release 1.41.0 with that release's notice (`credits.ts`, `CREDITS.md`).
- **The ruler.** `walkRuler.ts` is unchanged, since the ruler reads its own legs as a stop list that carries no `prior`. A turn's trail draws a ring with one spot where a copy holds `prior` and no leg here.
- **Isometric.** An end lies on the ground and its name stands up where its cells are revealed, as a trap's does.
- **Focus.** The pane's Escape blurs its control, since the board takes no focus (D-261109-145). The key's focus stays where it was, and a button press moves it to the other way (D-261109-140).
- **Keys.** The key the other way says "going up" or "going down" (D-261109-138), and the landing's name gives way wherever the turn's mover stands where its moves on this floor began (D-261109-142).
- **Builder.** To lists only floors next to the one shown, and the mode leaves the builder key's cycle on a scene of one floor (D-261109-143, 146).
- **The grid rule of a retained undo** across a re-created floor with a new shape cannot be reached through ops, since the one-shape rule refuses the return first. It is held by `floorProblem`'s own test and the import's check.
- **Alignment.** The measured roots of Go up and Go down, the DM's bar, a phone's strip and the locked button, are in `e2e/floors-links.e2e.ts`, beside the steps that put a creature on stairs, not in `e2e/alignmentRoom.ts`.
- **Areas on an undo.** A restore that puts a creature on another floor, a climb's or the DM's of Move to floor, takes every area attached to that creature now, read from the room, so one cast or attached after the step crosses too (FL2-OPUS-1).
- **The words of a kept step.** An undo that would put removed stairs back names what blocks them now in the builder's words, since no stairs stand to remove (FL2-OPUS-2). They are judged on the room as the undo would leave it, so stairs that come back with their floor are not held against the floor's absence (FL2-OPUS-10). The placer's sentence stays for stairs that stand.
- **The far floor's limits.** A DM's climb meets the far floor's limits, its cap on lit token lights among them. A player's leaves them unread (FL2-ASTRA-03), and a player's undo or redo of a climb reads neither floor's own limits (FL2-SOL-05).
- **The walls under an end.** `wallInside` tests only the walls whose box meets the end's box (`scripts/bench-floor-links.ts`).
- **Not built:** arrival traps, hidden stairs (D-261109-026) and a move or resize of a pair after placing (D-261109-022). Phase 3 brought the ruler through stairs.

# Phase 3: floors from files and dungeons, the ruler over stairs, the search

A floor can come from a Universal VTT file or a generated dungeon, a walking ruler can be carried over stairs, and the search can move a creature to another floor. This part is the design as built. The full text, with its four rounds of review, is kept outside the repository. Decisions: D-261110-070 to 084, 110 to 119, 180 to 202.

Versions: OP_VERSION 59 (`FLOOR_SOURCE_OP_VERSION`) and no SNAPSHOT_VERSION step, which stays 45. The step is the identity, since the new fields are optional and a stored add without them replays as it did. It moves so that an older build, whose strict schema would refuse a stored sourced add, refuses it cleanly (D-261110-127 numbered it 59, ahead of the privacy change).

## 12. A floor from a file or a dungeon

- `scene.create`'s `floor` gains `name` and `own`. `own` carries the source's size, background, grid look, automatic walls, map and file mark, and may carry fog and vision. The reducer lets it replace what `newFloorFrom` copied, patches vision as a scene patch does, and names the floor by `freeName`, which cuts by code point and numbers a taken name (D-261110-071, 072, 074).
- A floor from a file or a dungeon is one `scene.create`, with the source's walls, lights, doors, traps and pins after it in one Setup group. `floorCreateOf` in `scenes/floorSource.ts` builds it from the scene the source would have made, so the import and the generator build as they always do and only the first op changes. Like the floor beside, with its light untouched, sends no fog or vision and copies the floor beside whole. Any other pick is sent whole, with `byClock: false`, even where it equals the floor beside, so a co-DM's edit in between never changes it (D-261110-110, 186).
- The Floors group's **Map** (Blank, VTT file, Dungeon) sits over the two adds and is off for VTT file and Dungeon on a hex scene (D-261110-073, 075). The import dialog and Generate a dungeon take a floor target. The import's `ImportTarget` gained `kind: "floor"`, and GenerateDialog takes `floor?: FloorTarget`.
- Both dialogs check the floor's limits (8 floors, stairs between, 50 scenes) on the latest view before sending, and the import checks again after its upload. `floorAddRefusal` and `SCENES_FULL` in `floorSource.ts` hold the rules (D-261110-187).
- A dungeon floor's key page and pins go after the create is answered, titled from the stored name, in the same Setup group (D-261110-113). Until then the dialog cannot close, and a native close the browser makes (Chrome's, after repeated Escape) reopens it through an opt-in `keepOpen` on `useModalDialog`, so no op of this device lands inside the group (D-261110-183, 192).
- The server fills `own.map` from its asset row (`withAssetSizes`) and checks it and its video as it checks a new scene's.
- A floor from a source is a floor not reached, so a player holds nothing of it, and the asset route answers 404 for its map until it opens.

## 13. The ruler over stairs

- A walking ruler that ends on stairs to a held floor offers a button in its row. A press prices the climb, builds `prior` (the feet so far, the 5-10-5 counters, the walker's shape, and inbound only the creatures it sat on and the ends it crossed), shows the far floor and publishes the ruler there from the landing. `carry.ts` holds the rules, `walkRuler.ts` measures on from `prior`, and rulerStore keeps the carry on the device.
- A ruler frame has two schemas. The device's goes to the server with `anchors` and `ends`, and the server's goes to receivers without them (`outboundEph`). The server sends a carried frame only to a receiver who sees every anchor and holds every end, and ends the preview on a screen in the batch that takes one of them out of that screen's copy (`lost`, the fifth parameter of `publishBatch`, run right after each connection's `ev`, D-261110-189).
- A player's copy of an end gains `rise`, the climb's height, set where `to` is, so it comes only with `to`. A height edit is a global change. `linkHeight` reads `rise` first on any copy (D-261110-190).

## Phase 3 as built

Where the build went its own way:

- **Only the button keeps a ruler.** `[`, `]`, the Floors menu and a follow end the ruler and its carry, as any switch ends a ruler (D-261110-197). The design's case 10 read that it goes on without `prior`.
- **A frame over 4 KB is not sent.** The ruler keeps the last frame that fit and says once "A ruler over stairs can't take more stops. Clear it to measure again." (D-261110-196).
- **Anchors name the walker.** A carried frame's `anchors` also name the walk's own walker, the mount for a rider, so the server withholds the frame from anyone who cannot see the creature that walks. A ruler restarted away from its landing is carried no more and sends no `prior` (D-261110-198, 199).
- **An unexplored landing.** The design's "a straight leg fails at its first unseen square" does not hold on open ground. A stop on unseen open ground reads the straight walk, as review MV-O-21 set for any shared ruler. "No way through" shows only where the public route has none.
- **The stairs button** keeps priority 1, so at 320 by 568 at 130% a player's row shows it with Measure, Keep and Clear behind the overflow. A ruler of one stop on a creature standing on stairs offers them too. Shared's and Straight's off reasons are tooltips.
- **The rows of the search** show for a selected creature on any held floor of the scene in view, not only the floor on screen, and judge the floor again at Enter (D-261110-200, 201). The list and the search share `sendMoveToFloor` (D-261110-202).
- **Words the design left open** (D-261110-192 to 195): Hide's busy words "Making the floor…", a refusal that stops the dialog in place with Back or Make still on, Map back on Blank on each open, and "Ground floor" before the first add. A lost create answer whose floor never shows within 30 seconds reads unconfirmed.
- **The twins** (T1 to T6) are in `floors.wire.itest.ts` beside the phase 2 ones, not in `floorSources.itest.ts` (D-261110-191). The delayed create answer and the other-device split order have unit and source tests only, since an e2e cannot delay one server answer.
- **Alignment.** The Floors group per pick and both dialogs are measured in `e2e/floors-sources.e2e.ts`, and the ruler's row in `e2e/floors-ruler.e2e.ts`, not in `e2e/alignmentRoom.ts`.
- **Not built:** openings and falls, fliers through openings, arrival traps, hidden stairs, moving a pair, ends on different squares, Export every floor, Start a fight on every floor and a new scene from several files (D-261110-084, 111).
