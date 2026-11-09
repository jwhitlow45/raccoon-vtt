# Several floors in one scene: phase 1

## Summary

A scene can hold a tower, a keep or a cellar as up to 8 floors. Each floor is a scene linked to its main floor, so it keeps its own map, build, fog, light, weather, scene sound, tokens, traps and explored ground, while the Scenes list, the grid shape, the 500 tokens, the 200 areas and the size budget belong to the whole scene. The DM builds floors in the scene's settings and moves creatures between them with Move to floor. A player's device holds only the floors their party has reached and the floors where a creature they own stands, and shows the floor of the creature it follows.

This note is the design as built in phase 1. Phase 2 (stairs and ladders players take themselves, keeping the turn's feet) is not built, and neither are the later phases (Universal VTT files a floor, openings and falls, sight between floors). The design's full text, with its rounds of review, is kept outside the repository, and this note gives what was built and where the build went its own way. Decision ids are in the project's decisions log.

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

Where the build went its own way, with the decision ids from the decisions log (D-261108-270 to 380, and 421 to 434 for the fixes after review):

- **Shared rules.** `SceneFloor.of` and `height` are optional, since a player's copy lacks them (D-261108-270). An add's `scene` carries only id, name and size, and the reducer copies the rest. `floorProblem` also holds every floor's record name to the main floor's. The floor rules restate the party and ownership tests, because limits.ts sits in sight's arithmetic closure and must not import project.ts, and a test holds both to project.ts. Reorder and Duplicate naming a floor that is not a main floor are refused, not mapped.
- **Projection.** `viewerFloors` takes a scene without floors as itself alone and skips `heldFloors` (D-261108-283), `partyFloors` is absent when empty (D-261108-280), and the DM gets every opened mark (D-261108-281).
- **Server.** The explore step runs on every floor players see, per-player floors included. Every scene-budget refusal of a floor add reads the floor words, and players' memory is reserved on every floor of their scene (D-261108-290 to 297).
- **A pick in Floors closes it**, because Room.tsx closes an open pop-up whenever the scene shown changes. The DM's marks say "Reached", since one opened mark cannot tell "Reached" from "Shown to players" (D-261108-300 and 301).
- **Moving to a floor** lands a creature on the new floor's ground under its full space, since the move drops a squeeze, and keeps a flier's height. Whether it stood on the ground reads the space it stood in, squeezed or not (D-261108-425). Move to floor has no search entry, since its control is in the action bar and the More sheet, which carry no search anchors (D-261108-350).
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

Not built: stairs and ladders (phase 2), Universal VTT files and generated dungeons onto a floor (phase 3), seeing between floors (phase 4), and a Move to floor entry in the search.
