# raccoon-vtt design: the players' height readout

Status: draft 1. It writes the design only and changes no app code. It is built after the whole-app design pass deploys.

J asked: "As a player what's the easiest way to see the height of a raised area". Players have no readout today. Height mode's "↑10 ft" pills show only to the DM while Heights and stairs is open (`client/features/builder/heights/HeightLayer.tsx:41`). Raised ground only looks lighter with a shadow, and a token on it shows "↑10" on its badge. J chose both fixes the owner offered: a tap on raised or lowered ground shows its height (section 2), and a ruler stop on raised ground stands on it (section 3). J also set the builder's top height to 100 ft (section 5).

## 1. What a player may learn

- A player's client holds the player scene's build chunks with `heights` and `up` (stair marks) exactly as stored, under fog or not, explored or not (`shared/project.ts:713-717`). They are map data, not secrets (`docs/design-v1-maps-vision.md` 4.2, Projection).
- It holds nothing of another scene. Chunks, kept rulers and ephemeral frames go only to viewers of their scene (`project.ts:632`, `project.ts:615`, `server/rooms/ephemeral.ts` `routeEphemeral`). Behind a blackout a player has no scene at all (`viewerSceneId`).
- A live ruler reaches a player only when every stop on a token is on one they can see (`ephemeral.ts` `allowed`). A kept ruler follows the same rule (`projectDrawingCtx`).
- So every viewer of a scene holds the same heights. What differs is the screen: the fog hides the ground. The app never says what the fog hides, even from data the client holds: a door under the fog cannot be tapped or named (`client/features/doors/doors.ts` `doorSeen`, `noteDoor`). Both features keep that rule through one helper, `seenGround(cell)`. It is the cell's ground for the DM. For a player on a scene with fog on, it is unknown on a cell the merged fog fully covers (`isCellFullyFogged`, the doors' test). A cell with any revealed part counts as seen, as for doors, and explored ground counts as seen.
- Neither feature adds anything the server sends a player beyond what the projection already gives. The ruler's new `z` (section 3) is ground the receiver's own chunks already hold, and a stop on a token never carries one.

## 2. The tap readout

**Where.** The Select tool only, on the tap the canvas reports as a tap on empty map (`client/canvas/Stage.tsx`, `tapOnEmpty`). That tap already deselects, then goes to a map label (DM only), then to a door. The readout becomes a third step and shows only when neither a label nor a door took the tap. Every other tool keeps its tap as it is: the ruler adds a stop, Ping pings, the builder paints, and Fog, Draw, Area, Pin and Place act. No tap loses a function, since the deselect still comes first. "Select several" and a Shift-drag box make no empty tap today, so they show no readout.

**What it shows**, from `seenGround` and the stair marks the viewer holds (directions from the cached `sceneWalls(...).stairAt`, which movement reads):

| Cell | Pill | Screen reader |
| --- | --- | --- |
| Ground 10 ft up | ↑10 ft | Ground 10 ft up. |
| Ground 10 ft down | ↓10 ft | Ground 10 ft down. |
| A stair at 0, pointing east | Stairs | Stairs, up to the east. |
| A stair 5 ft up, no direction | Stairs · ↑5 ft | Stairs, 5 ft up. |
| Ground at 0, outside the scene, or not seen | nothing, and a readout showing goes | nothing |

The pill's height is Height mode's `regionText`, so it reads like the DM's pills and a token's badge. Ground at 0 shows nothing, so the common tap to deselect stays quiet on an ordinary map.

**The look.** One `Pill` (`features/measure/Pill.tsx`), `small`, at a fixed size on screen like a ruler's readings, which must read at any zoom (`docs/design.md:1502`). It sits `above` the tapped cell's center with its pointer down to it, or `below` when it would cross the top of the screen. Its outline is Height mode's: light for raised ground and stairs, grey for lowered (`RAISED_EDGE` and `LOWERED_EDGE`, exported from `heights/boardText.ts`). It draws on the overlay layer at order 50, above the rulers and area previews. It reads the cell from the viewer's view on each render, so it follows a DM's repaint and goes when the ground turns 0 or the fog covers it.

**How long.** Until the next tap on the map, a token selection, a change of tool or scene, or 5 s (the toasts' `TOAST_MS`). A pan or pinch keeps it, since it sits in world cells. It uses one timer and no animation loop.

**Screen readers.** The canvas says nothing to them, so a visually hidden `role="status"` line (polite) beside the door pill's host speaks the words in the table, and clears with the pill. The arrows are never spoken.

**Phone.** One finger taps. The pill shows after the finger lifts, over the cell, so the finger never covers it. Two fingers pan and pinch as always.

**Computer.** A left click on empty map with Select. The middle or right button, or Space, still moves the map. There is no hover readout: it would flash under every mouse move, and nothing may need hover. The map has no keyboard cursor today, so no keyboard path reaches a cell. The pill is never focused and takes no key.

**The DM** gets the same readout with Select, without the fog rule, since the DM sees all ground. In Height mode the Build tool's taps paint, and the region pills already show every height. "View as a player" is a player's page, so it follows the player rule. A table display sends nothing and never taps.

## 3. A ruler stop stands on the ground

Today a free stop stands at z 0 (`client/features/measure/ruler.ts`), and every receiver computes the same reading from the frame.

**The change.** A free stop carries `z`: the measurer's `seenGround` under it, in feet, left out at 0. A stop on a token carries none, since the token's own box decides there. Every receiver measures a free stop with `pointCellBox({ x, y, z })`, which `shared/rules/distance.ts` already reads. So the reading is the measurer's, the same on every screen, whatever the receiver's fog.

- A player's stop on ground their fog hides stays at 0, as today, so a ruler cannot probe the dark.
- The DM's stops stand on all ground. Once the DM shares a ruler, players read the DM's numbers, which may count ground under their fog. That ground is in their chunks already, and the DM chose to share (question 1).
- Receivers computing ground from their own chunks was rejected: each would need the measurer's fog, and the DM's client would have to rebuild the players' merged fog.

**Frames.** `rulerPoint` gains an optional `z`, an integer from `MIN_HEIGHT_FT` to `MAX_HEIGHT_FT` (`shared/protocol.ts:1290`). A free stop with `z` takes at most 32 bytes (`{"x":-999.5,"y":-999.5,"z":-100}`), under the about 75 of a stop on a token with its 36-character id. So the largest frame is still 50 stops on tokens, about 3.9 KB, inside `MAX_EPH_BYTES` (4,096). The server forwards `z` untouched.

**Kept rulers.** `Drawing` gains `z?: number[]`, one per stop and 0 on a stop on a token, written only when some stop has a non-zero `z` (`keptDrawing`, `keptStops`). `drawing.create` refuses `z` on any other kind and a `z` whose length is not the number of stops, as it checks `anchors`. A kept ruler keeps the heights it was measured with: a later repaint or fog reveal leaves it as it was, just as its free stops never move. A kept ruler from before the build has no `z` and reads as today. A scene duplicate that frees a stop from a token left behind keeps it at 0, as today, because reading the ground there would change how stored duplicates replay.

**Rollout.** No migration and no op version: an op or a ruler without `z` means 0, as today. A page left open from before the deploy ignores ruler frames that carry `z` (`client/state/socket.ts:489`) until it reloads.

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
- **The stepper on a phone** has 25 values, and the default 10 ft takes 18 taps to reach 100. Keep the 5 ft steps J asked for, and make − and + repeat while held: a step after 400 ms, then one every 80 ms, about 1.5 s from 10 to 100. Every tap still steps once, so nothing needs the hold. The buttons stop the long-press callout and stop repeating on lift, cancel, or a finger sliding off. The value's 112 px already fits "100 ft up". A typed number was the alternative, and it opens the keyboard over the map being painted.
- **Tests and docs naming 30 ft.** No test pins the stepper's top. `canvas/tokenShadow.test.ts` names 30 ft as a flier's full lift, which stays. The docs that say 30 ft up are `docs/design-v1-maps-vision.md:541` (4.2's "-20 ft to +30 ft"), `docs/design.md:1379`, `docs/features.md:117` and `FEATURES.md:80`.

## 6. Tests

Unit:

- `heights/ground.test.ts` (new): `seenGround` for the DM, and for a player with fog on (fully fogged, partly revealed, explored), with fog off, and outside the scene. The pill text and spoken words for every row of the table, stairs with and without a direction.
- `measure/ruler.test.ts`: a free stop takes `z` from the ground reader and leaves it out at 0 and on a token. `measureStops` counts it: from a cell at 0 to the next cell 10 ft up reads 10 ft under "every diagonal 5 ft", where it read 5 ft. A kept ruler keeps `z` through `keptDrawing` and `keptStops`, and one without `z` reads as today.
- `shared/protocol.test.ts`: `z` bounds on a ruler point and on a drawing, and 50 free stops with `z` at their widest fit `MAX_EPH_BYTES`.
- `shared/reducer.test.ts`: `drawing.create` refuses `z` off a ruler and at the wrong length.
- `server/rooms/stateSchema.test.ts`: a stored kept ruler with `z` loads.
- `server/rooms/ephemeral.test.ts`: a ruler frame with `z` reaches each allowed receiver unchanged, and a stop on a token a player cannot see still withholds it.
- A `stepHeight` test: the stepper stops at -20 and at 100. `relief.test.ts`: `tintOf(100)` equals `tintOf(30)`, and `shadowLength(100)` is 0.5. The hold repeat under mocked timers: one step per tap, repeats only after 400 ms, stops on lift.

End to end, all in `e2e/vision.e2e.ts`, which already has the 10 ft platform, the stair at (5, 14), fog and vision, a phone player and a desktop DM. Its layout also paints the closet, (14, 18) to (15, 19), 10 ft down. The party never sees the closet.

- After the ledge and stair step: the player taps the platform with Select and the status line says "Ground 10 ft up.", taps the stair and hears "Stairs, up to the east.", and taps the closet and hears nothing. The DM clicks the closet and reads "Ground 10 ft down." A screenshot of each pill.
- The player measures from (5, 12) to the platform cell (6, 12). The ruler's options line reads 10 ft, and the DM's socket gets the frame with `z: 10` on that stop. A player's stop in the closet carries no `z`. The DM shares a ruler that ends in the closet, and the player's frame carries `z: -10`.
- The leak check (today's step 8) gains: in every ruler frame and kept ruler the player received, `z` sits only on stops without a token and equals the ground in the player's own chunks at that cell. No other field is new.

## 7. FEATURES.md

- Building maps, Heights and stairs: "from 20 ft down to 100 ft up in 5 ft steps. Hold + or − to step quickly." and "Past 30 ft the look stays the same, so tap the ground to read its height."
- Height and elevation, a new line: "With Select, tap raised or lowered ground to see its height for a few seconds, such as "↑10 ft", or "Stairs" on a stair. Under the fog it shows nothing. Screen readers hear it too."
- Measuring and movement, the ruler's line gains: "A point on raised or lowered ground stands on it, so the distance counts the height. A player's ruler counts only ground they can see, and everyone reads the same numbers."

## 8. The build

One part, scheduled after the design pass deploys. It touches:

- Shared and server: `shared/protocol.ts`, `shared/model.ts`, `shared/reducer/tokens.ts` (`drawingCreate`), `server/rooms/stateSchema.ts`, and the tests in section 6.
- The ruler: `client/features/measure/ruler.ts`, `RulerTool.tsx`, `controls.tsx` (the hold repeat, an `OptButton` option), `ruler.test.ts`.
- The readout and the stepper, in `client/features/builder/heights/`: `ground.ts` (new: `seenGround` and the readout's words), `tap.ts` (new: `tapGround`), `ReadoutLayer.tsx` (new: the pill and the status line), `store.ts` (the readout's slot, the new top, `stepHeight`), `boardText.ts` (the edge colors exported), `HeightOptions.tsx`. Then one line in `client/features/layers.ts`, and in `client/canvas/Stage.tsx` the tap's third step and the status host beside `DoorPillHost`.
- The visually hidden style: `pages/Room.tsx:730` and `pages/RoomDock.tsx:217` each define `VISUALLY_HIDDEN`. Move it to one export in `client/lib/` for its third user, rather than add a third copy.
- `e2e/vision.e2e.ts`.
- Docs: `FEATURES.md` (section 7), `docs/features.md:117`, `docs/design-v1-maps-vision.md` 4.2 (the stepper's "-20 ft to +30 ft" at line 541 becomes "+100 ft", and Player behavior gains the readout and the ruler), and `docs/design.md` sections 6 (`Drawing.z`), 7.6 (free stops carry `z`, line 649), 9.2 (a free stop stands on its ground, line 778) and 12 (the stepper, line 1379).

## 9. Questions for J

1. A DM's shared ruler stands on all the ground the DM sees, including ground under the players' fog, so its numbers can hint at a pit players have not found. Recommended default: keep it. The DM chose to share, the line already runs into the fog, and the heights are already in players' data. The other way, a shared DM ruler that ignores ground under the players' fog, changes the DM's own numbers the moment Shared is tapped.
