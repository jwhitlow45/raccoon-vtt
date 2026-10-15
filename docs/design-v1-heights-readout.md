# raccoon-vtt design: the players' height readout

Status: draft 2, after design review round 1. It writes the design only and changes no app code. It is built after the whole-app design pass deploys.

J asked: "As a player what's the easiest way to see the height of a raised area". Players have no readout today. Height mode's "↑10 ft" pills show only to the DM while Heights and stairs is open (`client/features/builder/heights/HeightLayer.tsx:41`). Raised ground only looks lighter with a shadow, and a token on it shows "↑10" on its badge. J chose both fixes the owner offered: a tap on raised or lowered ground shows its height (section 2), and a ruler stop on raised ground stands on it (section 3). J also set the builder's top height to 100 ft (section 5).

## 1. What a player may learn

- A player's client holds the player scene's build chunks with `heights` and `up` (stair marks) exactly as stored, under fog or not, explored or not (`shared/project.ts:713-717`). They are map data, not secrets (`docs/design-v1-maps-vision.md` 4.2, Projection).
- It holds nothing of another scene. Chunks, kept rulers and ephemeral frames go only to viewers of their scene (`project.ts:632`, `project.ts:615`, `server/rooms/ephemeral.ts` `routeEphemeral`). Behind a blackout a player has no scene at all (`viewerSceneId`).
- A live ruler reaches a player only when every stop on a token is on one they can see (`ephemeral.ts` `allowed`). A kept ruler follows the same rule (`projectDrawingCtx`).
- So every viewer of a scene holds the same heights. What differs is the screen: the fog hides the ground. The app never says what the fog hides, even from data the client holds: a door under the fog cannot be tapped or named (`client/features/doors/doors.ts` `doorSeen`, `noteDoor`). Both features keep that rule through one helper, `seenGround(cell)`. It is the cell's ground for the DM. For a player on a scene with fog on, it is unknown on a cell the merged fog fully covers (`isCellFullyFogged`, the doors' test). A cell with any revealed part counts as seen, as for doors, and explored ground counts as seen.
- Neither feature adds anything the server sends a player beyond what the projection already gives. The ruler's new `z` (section 3) is ground the receiver's own chunks already hold, and the protocol refuses one on a stop on a token.

## 2. The tap readout

**Where.** The Select tool only, on the tap the canvas reports as a tap on empty map (`client/canvas/Stage.tsx`, `tapOnEmpty`). Pins are not shapes that catch a tap, so a tap on one arrives here too, and the pin layer answers it on its own (`features/pins/PinLayer.tsx`, `useTapPin`). The tap's chain becomes:

1. Deselect, as today. The tap that closes a token's bar may also show the readout, which is intended: the bar is gone, so one thing still floats at a time.
2. A map label (DM only), as today. A tap that opens or closes the label pane is taken.
3. A door, as today. A tap that closes the door pill now counts as taken too (`tapDoor` returns true), matching the label pane, so it shows no readout.
4. The readout, in `tapGround`. It yields to a pin under the tap, by a new `pinUnder(view, sceneId, camera, screenPoint)` around `pinAt` (`features/pins/rules.ts`), checked before the ground is read.

Steps 2 to 4 need a press shorter than `LONG_PRESS_MS` (500 ms). A longer still press on empty map is the hold-to-ping (`features/pings/PingLayer.tsx`), and `CameraGesture` reports it as a tap today, so a ping on a door opens the door pill. `CameraGesture` records when the press began and `up` reports whether it was held that long (`lib/gestures.ts`). The label step takes the same rule, since a hold that pings should open nothing.

Every other tool keeps its tap as it is: the ruler adds a stop, Ping pings, the builder paints, and Fog, Draw, Area, Pin and Place act. "Select several" and a Shift-drag box make no empty tap today, so they show no readout.

**What it shows**, from `seenGround` and the stair marks the viewer holds (directions from the cached `sceneWalls(...).stairAt`, which movement reads):

| Cell | Pill | Screen reader |
| --- | --- | --- |
| Ground 10 ft up | ↑10 ft | Ground 10 ft up. |
| Ground 10 ft down | ↓10 ft | Ground 10 ft down. |
| A stair at 0, pointing east | Stairs | Stairs, up to the east. |
| A stair 5 ft up, no direction | Stairs · ↑5 ft | Stairs, 5 ft up. |
| A stair 5 ft up, pointing east | Stairs · ↑5 ft | Stairs, 5 ft up, up to the east. |
| Ground at 0, outside the scene, or not seen | nothing, and a readout showing goes | nothing |

The pill's height is Height mode's `regionText`, so it reads like the DM's pills and a token's badge. Ground at 0 shows nothing, so the common tap to deselect stays quiet on an ordinary map.

**The look.** That of the board's small screen-size pill (`features/measure/Pill.tsx` with `small`: 12 px bold, the `overlay` fill, a 1.5 px outline, 6 px corners), at a fixed size on screen like a ruler's readings, which must read at any zoom (`docs/design.md:1502`). Its outline is Height mode's: light for raised ground and for every stair, a stair in a pit included, and grey for lowered ground (`RAISED_EDGE` and `LOWERED_EDGE`, exported from `heights/boardText.ts`). It reads the cell from the viewer's view on each render, so it follows a DM's repaint and goes when the ground turns 0 or the fog covers it.

**Where it sits.** On a phone the top bar and the docks cover the map's edges, and the Konva `Pill` ignores them: with `above` or `below` it neither slides nor clamps (`Pill.tsx` `pillPlace`), and its pointer stays at its middle. So the readout is a DOM element in a host beside `DoorPillHost`, which gets the camera, the viewport and the room's insets as the door pill does, with `pointer-events: none`. `cardPlace` (`features/movement/anchor.ts`, the door pill's) places its box over the tapped cell's center, flips it below when the top inset leaves no room, and slides and clamps it inside the insets. A pointer marks the cell when the box sits wholly above or below the cell's center and that x lies along the box's straight edge. Otherwise the pill shows clamped, with no pointer.

**How long.** Until the next tap on the map, a token selection, a change of tool or scene, or 5 s. The 5 s is the toasts' `TOAST_MS`, moved from `pages/Room.tsx:53` to one export in `client/state/store.ts` beside `notify`, so the two never drift apart. A pan or pinch keeps the pill on its cell. It uses one timer and no animation loop.

**Screen readers.** The canvas says nothing to them, so a visually hidden `role="status"` line (polite) in the same host speaks the words in the table, and clears with the pill. A new readout clears the line, then sets it on the next frame, so two areas at the same height are both spoken. The arrows are never spoken.

**Phone.** One finger taps. The pill shows after the finger lifts, over the cell, so the finger never covers it. A press held 500 ms pings, as today, and shows no readout. Two fingers pan and pinch as always.

**Computer.** A left click on empty map with Select, under 500 ms as on a phone. The middle or right button, or Space, still moves the map. There is no hover readout: it would flash under every mouse move, and nothing may need hover. The map has no keyboard cursor today, so no keyboard path reaches a cell. The pill is never focused and takes no key.

**The DM** gets the same readout with Select, without the fog rule, since the DM sees all ground. In Height mode the Build tool's taps paint, and the region pills already show every height. "View as a player" is a player's page, so it follows the player rule. A table display sends nothing and never taps.

## 3. A ruler stop stands on the ground

Today a free stop stands at z 0 (`client/features/measure/ruler.ts`), and every receiver computes the same reading from the frame.

**The change.** A free stop carries `z`: the measurer's `seenGround` under it when the stop was placed, in feet, left out at 0. A stop on a token carries none, since the token's own box decides there. Every receiver measures a free stop with `pointCellBox({ x, y, z })`, which `shared/rules/distance.ts` already reads. So the reading is the measurer's, the same on every updated page (Rollout below), whatever the receiver's fog. From a cell at 0 to the next cell 10 ft up, a ruler reads 10 ft under "every diagonal 5 ft" and under 5-10-5, and 11 ft under true distance (each leg rounds, `roundFeet`), where it read 5 ft.

- A player's stop on ground their fog hides stays at 0, as today, so a ruler cannot probe the dark.
- The DM's stops stand on all ground. Once the DM shares a ruler, players read the DM's numbers, which may count ground under their fog. That ground is in their chunks already, and the DM chose to share (question 1).
- Receivers computing ground from their own chunks was rejected: each would need the measurer's fog, and the DM's client would have to rebuild the players' merged fog.

**Frames.** `rulerPoint` gains an optional `z`, an integer from `MIN_HEIGHT_FT` to `MAX_HEIGHT_FT` (`shared/protocol.ts:1290`), and refuses `z` together with `tokenId`. So a live frame has at most one `z` per free stop, absent at 0. A free stop with `z` takes at most 32 bytes (`{"x":-999.5,"y":-999.5,"z":-100}`), under a stop on a token with its 36-character id. So `z` never makes a frame longer than the same frame with every stop on a token. 50 stops on tokens with UUID ids measure 3,732 bytes, inside `MAX_EPH_BYTES` (4,096). That is the measured example, not the largest frame: ids may be 64 characters, which make the same frame 5,132 bytes, and the byte guard already refuses it (`withinEphBytes`, with its oversized-frame test in `shared/protocol.test.ts`). The guard and its test stay. The server forwards `z` untouched.

**Kept rulers.** `Drawing` gains `z?: number[]`, written only when some stop has a non-zero `z` (`keptDrawing`, `keptStops`). Unlike a frame, it has one entry per stop: 0 for a stop on a token, and 0 for a free stop on ground the measurer could not see. `drawing.create` refuses `z` on any other kind, a `z` whose length is not the number of stops, and a non-zero entry where `anchors` names a token, as it checks `anchors` today. A kept ruler keeps the heights it was measured with: a later repaint, a fog reveal or a reconnect leaves it as it was, just as its free stops never move. A kept ruler from before the build has no `z` and reads as today. A scene duplicate that frees a stop from a token left behind keeps it at 0, as today, because reading the ground there would change how stored duplicates replay.

**Rollout.** No migration and no op version: an op or a ruler without `z` means 0, as today. A page left open from before the deploy differs in two ways until it reloads:

- It refuses live frames that carry `z` as unknown fields (`client/state/socket.ts:489`), so it does not show those rulers.
- It accepts kept rulers with `z`, since state arrives as `z.unknown()` (`protocol.ts:1357` and `:1367`), drops the field and reads those stops at 0. A kept ruler from a cell at 0 to the next cell 10 ft up reads 5 ft there, and 10 ft on updated pages.

So "every screen reads the same" holds once every page has reloaded. The deploy notes say to reload every open page, table displays included.

The ruler draws as today. Only its numbers change.

## 4. What stays the same

Token distances already count height, since a token on raised ground stands at that elevation (`tokenCellBox`). Areas of effect count it too, and a free area already takes the ground as its origin when placed (maps-vision 4.2, Out of scope). Range rings, the drag reading, movement and doors' reach read the token or the ground already. None of them changes.

## 5. Heights up to 100 ft

J: "Let's set max of 100ft". `HEIGHT_MAX_FT` goes from 30 to 100 (`heights/store.ts:23`), still in 5 ft steps. The model allows -100 to 200 and `build.height` checks that (`shared/model.ts:365`), so the server does not change. The minimum stays -20, since nothing found needs it to move.

At 100 ft:

- **Raised ground's look.** The tint is 4% per 5 ft and stops at 20%, reached at 25 ft. The shadow is 0.08 cell per 5 ft and stops at half a cell, reached past 31 ft (`relief.ts:28-33`). So 30, 50 and 100 ft look alike, and touching regions at 30 and 100 ft share a tint, parted by the rim, the ledge line and a half-cell shadow. Keep both caps: a deeper tint washes out the map art, and an uncapped shadow at 100 ft would fall 1.6 cells over the ground below. The number is one tap away (section 2) and in Height mode's pills.
- **A token's flight shadow** reads the lift above the ground under the token, not the ground (`canvas/tokenShadow.ts`, `tokenLift`). A token standing on 100 ft ground casts none, and a flier's shadow is as today, at its fullest from 30 ft of lift.
- **Height pills** read "↑100 ft", one character wider. Placement measures each text, so nothing else changes. A flier's badge already shows "↑100".
- **Sight over ledges** compares an eye with the edge's top and has no cap. From below, a 100 ft cliff hides everything on it, and from the top a creature sees down. The plateau simplification (a flier over a plateau is hidden from beside it, maps-vision 4.2) and horizontal light ranges (4.3) reach further but do not change.
- **Doors' reach** measures to each door cell at its own ground, so a door at the top of a 100 ft drop opens from either side as it does at 30. No change.
- **The stepper on a phone** has 25 values, and the default 10 ft takes 18 taps to reach 100. Keep the 5 ft steps J asked for, and make − and + repeat while held: besides the press's own step, one step 400 ms into the hold and one every 80 ms after, so a 1.68 s hold takes 10 to 100. Every tap still steps once, so nothing needs the hold. The rules:
  - Exactly one step per press, whichever event drives it, and the press's own `click` adds none. Enter and Space keep `click`, and the keyboard's own repeat repeats them.
  - The timer reads the store through `stepHeight` (`heights/store.ts`), never a render's value.
  - The repeat stops on lift, cancel, a finger sliding off, and at -20 or 100. It hears the lift on `window` or through pointer capture, since a button that turns disabled at the limit may never get its `pointerup`.
  - During a hold the value's live announcement is off (`StepValue live`), and the final value is spoken once on release.
  - The buttons stop the long-press callout. The value's 112 px already fits "100 ft up".

  A typed number was the alternative, and it opens the keyboard over the map being painted.
- **Tests and docs naming 30 ft.** No test pins the stepper's top. `canvas/tokenShadow.test.ts` names 30 ft as a flier's full lift, which stays. The docs that say 30 ft up are `docs/design-v1-maps-vision.md:541` (4.2's "-20 ft to +30 ft"), `docs/design.md:1379`, `docs/features.md:117` and `FEATURES.md:80`.

## 6. Tests

Unit:

- `heights/ground.test.ts` (new): `seenGround` for the DM, and for a player with fog on (fully fogged, partly revealed, explored), with fog off, and outside the scene. The pill text and spoken words for every row of the table, and the light outline on a stair in a pit.
- `heights/tap.test.ts` (new): a tap on a pin on raised ground shows no readout. A tap that closes the door pill shows none, and a tap that only deselects a token shows one. Two taps on two areas at the same height set the status line twice, cleared between.
- `client/lib/gestures.test.ts` (new): a press held for `LONG_PRESS_MS` or longer is reported as held, and Stage's chain runs no label, door or readout step for it.
- The readout's placement, a pure helper over `cardPlace`: a cell under the top bar's inset flips the pill below, a cell at a phone's left or right edge slides the box with the pointer still on the cell, and a corner cell over a dock shows a clamped pill with no pointer.
- `measure/ruler.test.ts`: a free stop takes `z` from the ground reader and leaves it out at 0 and on a token. From a cell at 0 to the next cell 10 ft up, `measureStops` reads 10 ft under "every diagonal 5 ft" and 5-10-5, and 11 ft under true distance. A kept ruler keeps `z` through `keptDrawing` and `keptStops`, with zeros for token stops and unseen ground, and one without `z` reads as today.
- `shared/protocol.test.ts`: `z` bounds on a ruler point and on a drawing, `z` with `tokenId` refused, and 50 free stops with `z` at their widest fit `MAX_EPH_BYTES`.
- `shared/reducer.test.ts`: `drawing.create` refuses `z` off a ruler, at the wrong length, and non-zero on a stop whose anchor names a token. A `build.height` and a fog reveal under a kept ruler leave its `z` unchanged. `shared/project.test.ts`: a player's projection, a snapshot as a reconnect gets it, carries a kept ruler's `z` as stored.
- `server/rooms/stateSchema.test.ts`: a stored kept ruler with `z` loads.
- `server/rooms/ephemeral.test.ts`: a ruler frame with `z` reaches each allowed receiver unchanged, and a stop on a token a player cannot see still withholds it.
- A `stepHeight` test: the stepper stops at -20 and at 100. `relief.test.ts`: `tintOf(100)` equals `tintOf(30)`, and `shadowLength(100)` is 0.5. The hold repeat under mocked timers: one step per press with no extra step from its `click`, a second step only after 400 ms, it stops at 100 while held and on lift, and a tap after a hold steps once.

End to end, all in `e2e/vision.e2e.ts`, which already has the 10 ft platform, the stair at (5, 14), fog and vision, a phone player and a desktop DM. Its layout (`vision.e2e.ts:120-141`) gains two things it lacks today:

- A `build.height` of -10 on the closet, (14, 18) to (15, 19), sent after the creatures are placed, so the Goblin Boss standing there sinks to -10 with it by the height paint's rule. Sent before, it would leave the boss at elevation 0 (`tokenCreate` defaults to 0, `shared/reducer/tokens.ts:57`). The party never sees the closet. The steps that touch the boss still hold: the leak asserts (`vision.e2e.ts:460-461`) look only at its id, and step 8's sight check (`seesToken`) ignores elevation, while the closet's walls keep it out of sight.
- A label-only pin on a platform cell the party has seen (`pin.put`, visibility all).

Its new steps:

- After the ledge and stair step: the player taps the platform with Select and the status line says "Ground 10 ft up.", taps the stair and hears "Stairs, up to the east.", taps the pin and gets its popover with no readout, and taps the closet and hears nothing. The DM clicks the closet and reads "Ground 10 ft down." A screenshot of each pill.
- The player measures from (5, 12) to the platform cell (6, 12). The ruler's options line reads 10 ft, and the DM's socket gets the frame with `z: 10` on that stop. A player's stop in the closet carries no `z`. The DM shares a ruler that ends in the closet, and the player's frame carries `z: -10`. The player keeps the platform ruler, and both states hold it with `z: [0, 10]`.
- The leak check (today's step 8) gains:
  - Every live ruler frame the player received carries `z` only on stops without a token, and each equals the measurer's ground at that cell when sent. The e2e paints nothing after its layout, so that is the layout's ground.
  - Every ruler frame the DM received from the player carries `z` only on cells that player could see when it was sent.
  - Every kept ruler the player received carries one `z` entry per stop, 0 where its anchor names a token.
  - No other field in a frame is new.

## 7. FEATURES.md

- Building maps, Heights and stairs: "from 20 ft down to 100 ft up in 5 ft steps. Hold + or − to step quickly." and "Past 30 ft the look stays the same, so tap the ground to read its height."
- Height and elevation, a new line: "With Select, tap raised or lowered ground to see its height for a few seconds, such as "↑10 ft", or "Stairs" on a stair. Under the fog it shows nothing. Screen readers hear it too."
- Measuring and movement, the ruler's line gains: "A point on raised or lowered ground stands on it, so the distance counts the height. A player's ruler counts only ground they can see, and everyone reads the same numbers."

## 8. The build

One part, scheduled after the design pass deploys. It touches:

- Shared and server: `shared/protocol.ts`, `shared/model.ts`, `shared/reducer/tokens.ts` (`drawingCreate`), `server/rooms/stateSchema.ts`, and the tests in section 6.
- The ruler: `client/features/measure/ruler.ts`, `RulerTool.tsx`, `controls.tsx` (the hold repeat, an `OptButton` option), `ruler.test.ts`.
- The readout and the stepper, in `client/features/builder/heights/`: `ground.ts` (new: `seenGround`, the readout's words and its placement over `cardPlace`), `tap.ts` (new: `tapGround`), `ReadoutHost.tsx` (new: the pill and the status line), `store.ts` (the readout's slot, the new top, `stepHeight`), `boardText.ts` (the edge colors exported), `HeightOptions.tsx`, and their tests.
- The tap's chain: `client/canvas/Stage.tsx` (the readout step, the held-press rule, and `ReadoutHost` beside `DoorPillHost`), `client/lib/gestures.ts` (the press time) with a new `gestures.test.ts`, `features/doors/tap.ts` (a closing tap is taken), `features/pins/rules.ts` (`pinUnder`).
- Shared constants: `TOAST_MS` moves from `pages/Room.tsx:53` to an export in `client/state/store.ts`. `VISUALLY_HIDDEN` has three copies, in `pages/Room.tsx:730`, `pages/RoomDock.tsx:217` and inline in `pages/RoomChrome.tsx:350`. They move to one export in `client/lib/a11y.ts`, which the readout uses too, rather than a fourth copy.
- `e2e/vision.e2e.ts`.
- Deploy notes: reload every open page, table displays included, after the deploy (section 3, Rollout).
- Docs: `FEATURES.md` (section 7), `docs/features.md:117`, `docs/design-v1-maps-vision.md` 4.2 (the stepper's "-20 ft to +30 ft" at line 541 becomes "+100 ft", and Player behavior gains the readout and the ruler), and `docs/design.md` sections 6 (`Drawing.z`), 7.6 (free stops carry `z`, line 649), 9.2 (a free stop stands on its ground, line 778) and 12 (the stepper, line 1379).

## 9. Questions for J

1. A DM's shared ruler stands on all the ground the DM sees, including ground under the players' fog, so its numbers can hint at a pit players have not found. Recommended default: keep it. The DM chose to share, the line already runs into the fog, and the heights are already in players' data. The other way, a shared DM ruler that ignores ground under the players' fog, changes the DM's own numbers the moment Shared is tapped. All three round 1 reviewers support the default, and it applies unless J says otherwise.
