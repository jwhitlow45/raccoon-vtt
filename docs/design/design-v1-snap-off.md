# raccoon-vtt: snap off for a drag

Status: built (2026-11-02). The "As built" section at the end says where the build went its own way. Decisions D-261102-100 to 104 and D-261102-430 to 439 (section 8), and the build's own guesses are in As built.

From [mvp.md](mvp.md) section 4: "Snap can be turned off for a drag." Counts and lines cited are from the tree before this feature, with OP_VERSION 41 and SNAPSHOT_VERSION 31. The build sets OP_VERSION 44 and SNAPSHOT_VERSION 34, both with identity migration steps.

## 1. Shape

A free drop changes only where a token is drawn. The token lands on its snap grid exactly as an ordinary drop does, and stores a small offset, the nudge, that only drawing reads. Every rule, route, check and projection reads what it reads today. The one invariant (5.1) makes the rules box always the box the token would snap to from where it is drawn, for every size, and one rule (5.3) decides when a placement survives a move, enforced by one pass after every op. The client separates drawn and rules coordinates at one boundary (6.3).

An earlier shape let an unsnapped box reach every rule. It is kept as the rejected option of D-261102-430: it would have touched every footprint, route, cost and distance site of section 12, and clashed with the squeeze rules.

## 2. What the table gets

A DM, or a player on a creature they may move, drops a token between squares for one drag. It stays drawn there: leaning into a doorway, a swarm spread across a room, a rider sitting forward on its mount, a token sitting on the art's own square where the art is a little off the grid. The rules count it in its snapped box, the box it would snap to from where it is drawn. The next ordinary drag puts it back on the grid.

Scope: square scenes, top-down and isometric. Hex scenes keep creatures on a hex (D-261102-103).

## 3. The rules and other tables

SRD 5.2.1, "Playing on a Grid": "If you play out a combat using a square grid and miniatures or other tokens, follow these rules." Those rules count whole squares ("Each square on the grid represents 5 feet"). "Creature Size and Space" gives each size its space in feet. So a creature on a grid is in squares, even when its miniature leans. Roll20 (Alt while dragging), Foundry (Shift while dragging) and Owlbear Rodeo snap by default and drop free with a held key. Ideas only. We take the held key, add a touch toggle, and keep the rules on the grid.

## 4. What players and the DM see and do

**Computer.** Hold Alt (Option on a Mac) while dragging a token. The token follows the pointer as every drag does, and the landing ghost shows the box it will count in. The drag label gains a line, "Placing freely". On the drop the token lands on that box and is drawn where it was let go, rounded to 1/8 square and held within 3/8 square of the box (1/8 for tokens that snap to half squares). For a creature of one square or more, every 1/8 spot is reachable except the exact half square. The key is read on every pointer move and at the drop. While a drag is live the handler calls `preventDefault` on Alt's keyup, so a lone Alt does not open the browser's menu bar on Windows. Linux desktops that take Alt+drag for windows have the toggle.

**Touch, and a mouse alone.** The selected token's bar gets "Place freely" at the end of its play row, after Attach. Tap it and it reads pressed. The next drag of that token is free, then the toggle turns itself off. A second tap cancels it. It also turns off on a drag of another token, a cancel, a tool change, a selection change and a scene change. It is per device and never stored. It shows only on a square scene, only to someone who may drag the token now (client/canvas/dragRights.ts), and never in Multi-select's group bar. On a phone held upright it is not a strip button: it sits behind Expand with Light and Attach, one tap away (barButtons.ts `REST_PLAY` unchanged).

**Back on the grid.** While a token has a nudge, "Snap to grid" shows in its play row right after Place freely, for the DM and for owners who may move it. It is not a strip button and not in the passing line (`PASSING` unchanged, so its "comes and goes with the move" comment still holds). It clears the nudge. It is not a move: nothing walks or pays. An ordinary drag to another box also clears it. An ordinary drop back on the token's own box clears it only when the release is at least 1/8 square from where the token is drawn, so touch jitter never undoes a careful placement.

**Where it counts.** The dashed outline of the rules box (`footprintRect`) shows on a nudged token while it is selected, while it is being dragged, while a ruler on this device starts or stops on it, while an area preview on this device covers it, and on every device while a shared or kept ruler starts or stops on it. In isometric it lies on the ground. The walking ruler, the drag label, areas, reach, sight and light read that box as today. Elsewhere, on the TV included, the picture alone shows the place, within 3/8 square. Two creatures one square apart, each nudged toward the other, can look adjacent. We accept that: every reach and distance label reads the rules box, and the outline shows the moment anyone measures (D-261102-433).

**By device.** Phone upright: the bar's strip expands up, and both buttons wrap in the expanded rows. Phone sideways, tablet and computer: the bar opens as its window or docks, with the same rows. Alt works wherever a keyboard is.

**Words.** "Place freely" (pressed by `aria-pressed` and the pressed style). "Snap to grid". Drag label line: "Placing freely". On a hex scene with Alt held: "Hex scenes keep creatures on a hex." On a group drag with Alt held: "A group keeps to the grid." Screen reader after a free drop: "Placed between squares." A nudged token's accessible name adds ", placed between squares". Undo labels: "placing Bree between squares" and "snapping Bree to the grid". Shortcut sheet, "Mouse with keys": "Alt+drag a token (Option on a Mac)" | "Place it between squares, where you drop it" | "on a square scene, on a token you may move". "Mouse and touch": "Place freely, then drag the token" | "The same, for one drag" | "from the token's bar, on a square scene". FEATURES.md says "drawn within 3/8 of a square of its square".

**Who.** The DM for any token. A player for any token they may drag now. Snap to grid and a free drop back on the same box are token updates, so they also need ownership, companions included (5.4).

## 5. Model

### 5.1 State and its invariant (D-261102-100)

New optional token field `nudge?: { x: number; y: number }`: integers in eighths of a square, each -3 to 3 (-1 to 1 for a snap step of half a square, `snapStep`), never both 0. The drawn top-left is `(x + nudge.x / 8, y + nudge.y / 8)`.

A nudge is valid only on a square scene, on an unsqueezed token (`isSqueezed` false) that stands on its own snapped spot (`footprintRect(g, t)` has its x and y). Then the rules box is the snapped box under the stored spot, and the drawn box is that box moved less than half a snap step on each axis. So **the rules box is always the box the token would snap to from where it is drawn**, for every size. For odd sides (Medium, Huge) that is the square under its middle. For even sides (Large, Gargantuan) the middle sits near a grid corner and the nearest box decides. Custom sides follow the same nearest-box rule. No rule, route, check, projection test or vision reads the field.

### 5.2 Ops (D-261102-431)

- `token.move` and each move of `token.moveMany` gain `drawnAt: { x, y }` (optional): where the token was let go or should stay drawn, absolute, in cells, each a multiple of 1/8 (`coord`, refined `Number.isInteger(v * 8)`).
- `tokenPatch` gains `drawnAt: { x, y } | null` (optional), the same point, or null to clear. It must be the patch's only field: a refine on the `token.update` schema in protocol.ts refuses a patch where `drawnAt` is present beside any other key, for both roles and for replay.
- `isPoseOp` also takes a `token.update` whose patch is exactly `{ drawnAt }`, so it undoes as a move (Undo move, undoMove.ts).

### 5.3 The rule and the pass (D-261102-101, 437)

One rule, said the same way everywhere: **a token named by a move keeps its placement only when the move lands it on the spot it was aimed at. Any other landing clears it. A token moved along by another (carried, dragged, seated, restored) keeps its placement wherever it ends on a spot where a nudge is valid.**

New `shared/rules/nudge.ts`:

- `nudgeValid(g, token)`: the test of 5.1.
- `nudgeAt(g, landed, drawnAt)`: none unless `drawnAt` is given, `nudgeValid` holds for the landed token, and `drawnAt` is within the bound of the landing on each axis and not equal to it. Aims are snapped spots. A move's every other possible landing is a snapped spot at least one step away (beyond the bound, since the bound is under half a step), or a spot off its snap grid (where `nudgeValid` fails). So "within the bound" holds exactly when the move landed where it was aimed. A trap stop on the aimed spot keeps the nudge, a stop anywhere short clears it.
- `keepNudges(tx, before)`: run once per op in shared/reducer.ts just before `tx.finish()` (:189), after the trap step and the pit's second link pass. Its writes land only on keys the op already touched, plus the tokens of a scene that changed grid shape, so `trapWrote` is unaffected. For every token the op wrote, and every token of a scene whose `gridShape` changed in the op, it drops a nudge that fails `nudgeValid`. This one pass covers carried and dragged tokens, attach seats (reducer/attach.ts:78, :92), detach landings, duplicates, carried moves to another scene, restores, undo and grid switches. A valid nudge restored onto squares survives, so a grid switch's undo and redo give back exactly what was there.

The reducer (shared/reducer/tokens.ts): `tokenMove` and `tokenMoveMany` set each named token's nudge from `nudgeAt(op's drawnAt)`, and a named move without `drawnAt` clears it. `tokenUpdate` with `drawnAt` sets the nudge by `nudgeAt` from the token's own spot. A patch of size, w, h, scene or place clears it, beside `SQUEEZE_FIELDS` (tokens.ts:366). `carriedAlong` spreads the token, and the pass judges what it keeps. Path stops, legs and costs never see the field. Old ops carry no `drawnAt` and no stored token has a nudge, so replay never runs a new branch.

### 5.4 Permissions (D-261102-432)

- `token.move` and `token.moveMany` with `drawnAt`: no new check. They are moves, judged as moves.
- `token.update` with `drawnAt`: handled first in the branch (permissions.ts:915), before the companion branch (:919, `companionUpdateCheck`) and the resize branch (:920). The patch holds only `drawnAt`, which the protocol refine of 5.2 already enforces. The player must own the token (`ownsToken`, character owners and a companion's owners included) and pass `moveCheck` (:1512), so a locked token refuses it. The DM passes. `OWNER_TOKEN_FIELDS` and `COMPANION_OWNER_FIELDS` stay as they are, so no mixed patch can skip `moveCheck`.
- `POSE_FIELDS` (:1758) gains `nudge`, so `restoreMoveCheck` accepts a player's undo or redo of a free move.
- One lock rule: `restoreMoveCheck`'s in-place owner path (:1790) also needs `moveCheck` when the restore changes the nudge. A locked token's nudge changes only by the DM.
- No check reads a link, a holder or anything hidden.

### 5.5 Undo (server/rooms/undo.ts, undoDm.ts, undoLabels.ts, shared/undoCorrection.ts)

- undo.ts `Place` (:32) gains `nudge`. `placeOf` copies it, `samePose` compares it, and `putBack` (:713) strips `nudge` from `current` with `squeeze`, so undoing a free drop from an unnudged start leaves none. `quietlyBack` keeps the current nudge and the pass judges it.
- undoDm.ts:8 and undoCorrection.ts:10 `POSE_FIELDS` gain `nudge`.
- undoLabels.ts (:100) names an update of only `drawnAt`: "placing X between squares", or "snapping X to the grid" for null.

### 5.6 Projection, frames and privacy (D-261102-434)

shared/project.ts:1322: a non-owner's projection gets `if (token.nudge) out.nudge = token.nudge` beside `squeeze`. Owners and the DM get the whole token already. A hidden token is projected out whole. The nudge says only where in its box a token every receiver already sees is drawn.

Drag frames carry the drawn spot: `dragStart` at `drawnAt` of the token, frames under the pointer as now, `dragEnd` at the landing plus its new nudge. server/rooms/ephemeral.ts does not change. `previewWithheld` (:145-148) judges any unsnapped point by the full box, which `footprintRect` snaps back to the rules box, and by the squeezed box, which errs toward withholding. A nudged token is never squeezed, so a frame at its drawn spot is withheld whenever its rules spot is.

### 5.7 Versions, replay, export (D-261102-435)

OP_VERSION 44 and SNAPSHOT_VERSION 34, both. Two ops and the token gain fields that older builds' strict schemas refuse. The migration is the identity. Rollback is the backup taken before the deploy. server/rooms/stateSchema.ts: the strict token schema (:373 area) gains `nudge` with its bounds and the both-zero refusal. The path-stop footprint schema (:329) is unchanged. Export and import carry the field.

## 6. Client

### 6.1 Two helpers (client/lib/scene.ts)

- `drawnAt(g, token)`: stored top-left plus the nudge on a square scene, the stored top-left otherwise.
- `rulesSpot(token, p)`: a drawn point back to rules coordinates, `p - nudge / 8`.

### 6.2 What reads the drawn spot

Rule E of section 12 finds 99 token position reads in 36 client files. Sorted:

- **Drawn:** TokenNode.tsx (node position, decor group, and the dashed outline at `-nudge / 8` inside the group when Stage asks for it), relief/stand.ts (below), relief/IsoBoard.tsx (standee spot and depth order by the drawn ground point, base height from the ground under the rules box so a standee never stands on a ledge it is not on), relief/isoText.ts, relief/renderCache.ts (the cache key takes the nudge), boardPick.ts:161 `ringCenter` (the iso marquee and drag grip), tokenShadow.ts, TokenShadow.tsx, textBoxes.ts, useBoardText.ts, RemoteDrags.tsx (the ghost's start), client/features/attach/groups.ts (press holes and inset, so a tap on a mount's middle under a forward rider picks the mount), client/lib/group.ts:81 `tokensInBox` (the top-down marquee), client/features/find/findToken.ts (the highlight), client/features/areas/labelSpot.ts (area labels avoid the drawn token), client/features/builder/lightTap.ts (tap boxes).
- **stand.ts:** `tokenBoxes` (:51-55) computes the body at `drawnAt` and the rules footprint at the stored spot (or at `rulesSpot` of a dragged point). So `tokenStands` (:101-107), `tokenBox` (dimming, flat clips) and `dimmedForDm` test the art where it is drawn and the footprint where the rules put it. A nudged token stands upright only where both are revealed, as Top-down would mask it, for players and on the TV.
- **Drag boundary:** Stage.tsx and stageHooks.ts, section 6.3.
- **Rules, unchanged:** drop.ts (except 6.4), measure/movement.ts, RulerLayer.tsx, walkRuler.ts, preview.ts, StopNote.tsx, areas/liveTokens.ts, tokens/resize.ts, resizeMemory.ts, factory.ts, useDuplicate.ts, CompanionsSection.tsx, attach/walk.ts, attach/tags.ts (an op's spot), DragMarks.tsx. Camera targets stay on the stored spot, since 3/8 square off center never shows in a camera aim: encounter/followTurn.ts, display/logic.ts, party/PartyBar.tsx, outliner/rows.ts and Stage.tsx:553 (Fit map's own-token targets).

### 6.3 The drag boundary (D-261102-433)

The node sits at the drawn spot, so every rules read in the drag path goes through `rulesSpot`: stageHooks.ts `aimAt` (:404, :454), the group delta (:459, `planGroup(view, group, at.x - token.x, …)`), the group label (:432), `pressedAim` (:165), `press` (:436), Stage.tsx `offsetNode` (:144-146), `setSpot` and the followers' offset (:1572-1580), and the iso grip's `rel` (:1431-1432) beside `ringCenter`. Followers move by `node - drawnAt(token)`. While the drag is free (Alt held at that frame, or the toggle on), `aimAt` at :404 and :454 reads the drawn node point with no `rulesSpot`, so the ghost, the route target and the plan all use the box under the drawn token. `rulesSpot` applies only to drags that are not free. Groups are never free, so they are unaffected.

The node adapter works both ways. Reads go from node to rules by `rulesSpot`. Writes go from rules to node by `drawnAt` of the token at that spot (the spot plus the token's current nudge): `offsetNode`'s position setter (Stage.tsx:146) converts the lead's spot and the pressed token's spot each with its own nudge, the held positions stageHooks.ts writes (:307, :329) are rules spots written that way, and a cancelled drag puts each node back at `drawnAt` of its token (Stage.tsx:1447-1450).

### 6.4 Dropping (new client/features/movement/free.ts)

The drop plan is built as today. drop.ts changes in one place: `Landed` gains an optional `drawnAt`, and `moveOpsOf` (:958) copies it into the op, `token.move` or each move of `token.moveMany`. Then `freeDrop` adds it:

- Free, and the lead lands on the snapped spot under the release: its move gets `drawnAt`, the release rounded to 1/8 and clamped to the bound.
- Free, release on the token's own box: `token.update { drawnAt }` for the DM or an owner, else nothing.
- Not free, a nudged token, release on its own box at least 1/8 square from its drawn spot: `token.update { drawnAt: null }` for the DM or an owner.
- In a group gesture, and in the named moves that keep a placement (group members, the one survivor of a group plan that `moveOpsOf` sends as `token.move`, a rider carried by its pressed mount's plan), a nudged token's move carries `drawnAt` = its landing plus its nudge, so the rule of 5.3 keeps it where it lands as aimed. An ordinary lone drag to another box omits `drawnAt`, so it clears the nudge. Arrow steps keep it by 6.5.
- "Teleport here" after a held free drop (client/features/movement/teleport.ts) carries the drop's `drawnAt`.
- Isometric (client/canvas/isoDrag.ts): the release is the ground point under the dragged ring's middle (isoDrag.ts `dragBound`, :64-68), less half the footprint, which is the drawn top-left, rounded the same way.

`landDrop` in Stage.tsx puts each node at `drawnAt` of its landed token.

### 6.5 Arrows, toggle, keys, outline set

- press.ts: an arrow step on a nudged token sends `drawnAt` = new spot plus nudge, alone or in a group.
- The one-shot `placeFreely` flag lives in the local UI state (client/state/store.ts), keyed by token id.
- barButtons.ts gains `placeFreely` and `snapToGrid` in the play row (section 4), outside `REST_PLAY` and `PASSING`. TokenActionBar.tsx renders them.
- Stage.tsx computes the outline set of section 4: the selection, the dragged tokens, the token ends of this device's ruler and of shared or kept rulers (`RulerStop.tokenId`, drawing anchors), and the tokens an area preview covers, which AreaPreviewLayer.tsx exports as it already finds them.
- shortcuts.ts `BEHAVIORS` gains the two rows of section 4, which FEATURES.md repeats.

## 7. Performance and sizes

One rounding per pointer move, one addition per drawn token, and a pass over the tokens an op wrote, which it already touched. Two small integers per token. Nothing grows, so no cap.

## 8. Decisions

- **D-261102-100 (state)** A draw-only `nudge` in eighths, valid only on an unsqueezed token on its snapped spot on squares, never read by a rule. Rejected: a `free` flag (D-430), an off-grid stored x and y (routes and D-261101-270 read a Large creature's true box off its grid), a float offset (no lattice for bounds or replay).
- **D-261102-101 (moving)** A named token keeps its placement only when its move lands where aimed. Rejected: a last hop, arrows clearing it, a nudge judged from wherever a cut lands (a half-square cut could keep one drawn 7/8 square from its box).
- **D-261102-102 (who)** The DM and players on tokens they may drag now. No link check. Rejected: DM only, refusing carriers and riders (it read hidden links).
- **D-261102-103 (hexes)** Squares only. Rejected: hex nudges (a radius bound and hex anchor drawing for little use), refusing the move (a move refused for a drawing field).
- **D-261102-104 (inputs)** Alt while dragging, the bar toggle for one drag, 1/8 rounding, a 3/8 bound (1/8 at a half-square snap step). Rejected: Shift (adds to the selection), Ctrl (zoom and selection), a long press, a setting (the line says for a drag), a two-finger drag (the pinch), the Select options row (only in Multi-select), a 1/2 bound (the nearest box would tie).
- **D-261102-430 (shape)** Draw-only placement with the rules on the grid, confirmed by D-261102-428. Rejected: an unsnapped rules box (section 12's sites, eighth-square route lattices, new cost units, fractional distance, and a clash with D-261102-032 and D-261101-270), and D-261102-008's objection, answered by the invariant of 5.1 and the outline of section 4.
- **D-261102-431 (absolute drop point)** `drawnAt` is absolute, so a rewritten landing clears it by the bound. Rejected: a relative nudge in the op (every rewrite site would drop it by hand).
- **D-261102-432 (in place)** A `token.update` of only `drawnAt`, for owners who pass `moveCheck` and the DM, handled before the companion and resize branches. Rejected: a zero-length `token.move` (a move in place means something to paths), adding the field to the owner field sets (a mixed patch could skip the lock), a new op kind.
- **D-261102-433 (drawing and drag)** Two helpers, a sorted list of reads, one drag boundary, and the outline on selected, dragged and measured tokens. Rejected: an image offset inside a node at the stored spot (labels, shadow, picks and the bar would disagree), the outline on every nudged token always (clutter), more outline on the TV than shared rulers give (accepted for 3/8 square).
- **D-261102-434 (frames)** Frames carry the drawn spot, ephemeral.ts unchanged. Rejected: rules-spot ends (a jump on remote screens for no privacy gain).
- **D-261102-435 (versions)** The next free op and snapshot versions, identity migration. Rejected: no step, an op step alone.
- **D-261102-436 (grids)** The pass drops nudges on a scene that becomes hexes and on tokens carried onto one. A restore onto squares keeps valid ones. Rejected: holding the switch, clearing in map.ts on every shape change (it ran on undo and lost restored nudges).
- **D-261102-437 (groups and carrying)** The client sends each moved member's `drawnAt`, so groups keep their placements, the one-survivor case included, and the pass keeps carried ones where valid. Rejected: keeping by op type (a one-survivor group drag is a `token.move`), clearing them (a spread swarm collapses).
- **D-261102-438 (proof)** A shared property test proves the rules blind to the field, focused rendering tests cover the drawing branches, and drag-boundary tests cover the client's mixed reads. Rejected: per-site tests over 300 sites, claiming the property test covers client code.
- **D-261102-439 (size and order)** A medium build with versions, after the dungeon generator in the Later list's order (D-261102-428).


## 9. UI checklist

- Light theme: the outline takes the selection's accent color, never a fixed color. Both buttons use the bar's existing tokens.
- Loading: a free drop is a move and Snap to grid a token update, on the existing busy and refusal paths.
- Keys and focus: Place freely is a toggle in the bar's Tab order with `aria-pressed`, Enter and Space toggle it. Snap to grid is a plain button. Alt is a pointer modifier only.
- Screen readers: the words of section 4, "Placed between squares." through the existing polite announcer.
- Large interface sizes: both buttons wrap at 130% with no truncation.
- Contrast: the outline meets the light theme's ring check over the board and over white map art.
- Reduced motion: nothing animates.
- Assets: none.
- Alignment: add sweep roots for the bar with Place freely pressed and with Snap to grid (e2e/alignmentRoom.ts), at 1440x900, 390x844 and 320x568, 100% and 130%.

## 10. Cases and tests

| Case | Expected | Test |
| --- | --- | --- |
| Alt-drop a Medium token released at (3.43, 2.6) | Lands (3, 3), nudge (3, -3) | `shared/rules/nudge.test.ts`, `e2e/snapoff.e2e.ts` |
| Released at (3.49, 2) | Nudge (3, 0), clamped | nudge unit |
| Custom 1.75 wide, nudge +3 | Snaps back to its own box from the drawn spot | nudge unit (invariant) |
| Tiny token | Nudge within -1 to 1 | nudge unit |
| Release Alt before the drop | No `drawnAt` | `client/features/movement/free.test.ts` |
| Toggle on, drag, drag again | First placed, second snapped, toggle off | e2e at 390x844 |
| Free drop held at a wall, or cut to a half-off hold | Nudge cleared | reducer `shared/reducer/nudge.test.ts` via `touchLanding` |
| Trap stop short of the aim, and on the aim | Cleared, and kept | reducer nudge test via `planTrapMove` |
| Group drag, one member blocked, the survivor sent as `token.move` | Survivor keeps its nudge | free unit, reducer nudge test |
| Group arrow step | Each keeps its nudge | press unit |
| Nudged rider seated at a half seat, or carried by a holder held off grid | Cleared by the pass | reducer nudge test |
| Rider carried to a hex scene | Cleared | reducer nudge test |
| Grid switch to hexes, undo, redo | Cleared, back, cleared | `shared/reducer/gridShape.test.ts`, `server/rooms/undo.test.ts` |
| Resize, scene change, place edit | Cleared | reducer nudge test |
| In-place free drop, owner, companion owner, DM | `token.update` accepted, Undo move takes it back | `shared/permissions.nudge.test.ts`, free unit |
| Mixed patch with `drawnAt`, non-owner mover, locked token | Refused, nothing sent, refused | permissions test, free unit |
| Player undo on a locked token that changes a nudge | Refused | permissions test |
| Undo and redo of a free move from an unnudged start | No nudge, then the nudge | `server/rooms/undo.test.ts` |
| DM undo | Nudge back | new `server/rooms/undoDm.test.ts` |
| Undo labels | "placing Bree between squares", "snapping Bree to the grid" | `server/rooms/undoLabels.test.ts` |
| Ordinary drop on its own box, jitter under 1/8 | Nothing sent | free unit |
| Nudged lead, 0.2-square group drag | Nothing moves | stageHooks drag test (dragTesting.ts) |
| 1/8 jitter on a 3/8-nudged token | Nothing moves | stageHooks drag test |
| Drag a forward rider of a controlled mount | Mount moves by the pointer delta | stageHooks drag test |
| Alt-drag a +3/8-nudged token at x=3 by +0.25 | Ghost shows box 4 throughout, lands at 4 with nudge -3/8 | stageHooks drag test |
| Held preview and cancel, pressed token and lead with different nudges | Each node at its own drawn spot while held and after the cancel | stageHooks drag test, Stage cancel test |
| Ordinary lone drag of a nudged token to another box | No `drawnAt`, nudge cleared | free unit |
| Iso grip on a nudged token | No jump at grab | isoDrag unit |
| Tap a mount's middle under a forward rider | Picks the mount | groups unit |
| Marquee over a nudged token's drawn box | Selects it | group unit |
| Iso standee at a fog edge, player and TV, an object rotated 90 | Upright only where body and rules box are both revealed | `client/canvas/relief/stand.test.ts` |
| Standee whose drawn box overhangs a ledge | Base height from the rules box | stand unit |
| Teleport here after a held free drop | Lands placed | teleport unit |
| `drawnAt` off the 1/8 lattice | Refused by the schema | protocol unit |
| Export and import, an out-of-bound nudge | Equal, refused | stateSchema import test |
| Replay of ops stored at 41 | Same state | migrate test, differential suite |
| Player's copy | Nudge only on tokens it receives | project test |
| Frames of a nudged hidden token | Withheld as its rules spot | `server/rooms/ephemeral.test.ts` |
| Outline during drag, ruler, area preview, shared ruler | Shown, and on the TV for the shared ruler | e2e |
| Shortcut sheet and FEATURES.md | Agree | existing sheet test |
| Random op sequences with `drawnAt` | Rules blind (below) | `shared/nudge.random.test.ts` |

The property test reuses the generators of shared/reducer/memory.random.test.ts and ride.fileLoop.random.test.ts. The stripped run removes every `drawnAt` and drops ops left as an empty patch. Invariants: the two runs' states are equal ignoring `rev` and `nudge`, so are their projections, and every stored nudge passes `nudgeValid`. It covers the shared reducer, permissions and projection only. Client reads are covered by the rendering and drag-boundary tests above.

Mutation checks, each must fail a test: keep the nudge on an ordinary move, drop the bound, skip `keepNudges`, read `nudge` in `footprintRect`, leave `nudge` out of `POSE_FIELDS`, keep `nudge` in `putBack`, skip `rulesSpot` in `aimAt`, compute stand.ts's rules box at the drawn spot, forget the renderCache key.

E2E: new `e2e/snapoff.e2e.ts` (Alt, phone toggle, Snap to grid, player undo, outlines), steps in `e2e/iso.e2e.ts`, `e2e/keyboard.e2e.ts` and `e2e/shortcuts.e2e.ts`, the alignment files, and `reach`.

## 11. Files

- **Shared and server:** shared/model.ts, shared/protocol.ts, new shared/rules/nudge.ts, shared/reducer.ts, shared/reducer/tokens.ts, shared/permissions.ts, shared/project.ts, shared/undoCorrection.ts, shared/migrate.ts and its version fixture, server/rooms/undo.ts, undoDm.ts, undoLabels.ts, stateSchema.ts, their tests, and the property test.
- **Client drawing:** client/lib/scene.ts, client/lib/group.ts, client/canvas/TokenNode.tsx, boardPick.ts, tokenShadow.ts, TokenShadow.tsx, textBoxes.ts, useBoardText.ts, RemoteDrags.tsx, relief/stand.ts, relief/IsoBoard.tsx, relief/isoText.ts, relief/renderCache.ts, client/features/attach/groups.ts, client/features/find/findToken.ts, client/features/areas/labelSpot.ts, client/features/builder/lightTap.ts, and their tests.
- **Client input:** client/canvas/Stage.tsx, client/features/movement/stageHooks.ts, client/canvas/isoDrag.ts, new client/features/movement/free.ts, client/features/movement/drop.ts (`Landed` and `moveOpsOf` only), press.ts, teleport.ts, client/canvas/barButtons.ts, TokenActionBar.tsx, client/features/areas/AreaPreviewLayer.tsx (the export only), client/state/store.ts, client/state/shortcuts.ts, and their tests.
- **End to end and docs:** e2e/snapoff.e2e.ts, steps in the iso, keyboard and shortcuts files, the alignment room's roots, FEATURES.md (beside "Tokens snap to the grid"), the DM guide, mvp.md's line and this note.

## 12. Sites at this base, with counting rules

All counts on 796ce059, `grep -rnE` over shared, server and client with `--include='*.ts' --include='*.tsx'`, dropping lines whose path matches `\.test\.tsx?:` or `/test/`. Rule B counts calls. Rules A, C, D and E count matching lines (textual matches, not calls). The design edits none of A to D for the rules, and the property test covers their shared and server part.

- **A. `footprintRect(` matching lines, 52 in 24 files (51 calls):** pattern `footprintRect\(`, dropping `function footprintRect`. One line is a documentation example (shared/rules/movement.ts:1180), so 51 are executable calls. shared/rules/aoe.ts 9, shared/rules/attach.ts 6, client/features/areas/placement.ts 5, shared/rules/movement.ts 4, shared/rules/traps.ts 3, shared/project.ts 3, shared/rules/route.ts 2, client/features/measure/ruler.ts 2, client/features/doors/doors.ts 2, client/canvas/DragMarks.tsx 2, and 1 each in shared/rules/walkWorld.ts, moveLeg.ts, footprint.ts, shared/reducer/duplicate.ts, areaTriggers.ts, shared/permissions.ts, client/features/traps/rules.ts, measure/movement.ts, measure/TurnStartLayer.tsx, areas/draw.tsx, areas/caster.ts, areas/AreaTool.tsx, areas/AreaPreviewLayer.tsx, client/canvas/relief/stand.ts.
- **B. Other footprint helper calls, 71 in 24 files:** pattern `\b(occupiedRange|rangeAt|rangeAtInto|occupiedCells|storedCenter|squeezedRect|stopFootprint|snapStep)\(`, dropping every `function <name>(` line (8 in footprint.ts, 1 local in client/features/tokens/factory.ts:261) and factory.ts's 2 calls of its own local `snapStep`. shared/rules/movement.ts 14, route.ts 9, traps.ts 6, footprint.ts 5, vision.ts 4, attach.ts 4, shared/reducer/tokens.ts 4, aoe.ts 3, shared/project.ts 3, resize.ts 2, dismount.ts 2, shared/permissions.ts 2, client/features/movement/drop.ts 2, and 1 each in walk.ts, path.ts, heights.ts, fog.ts, distance.ts, shared/reducer/map.ts, areaTriggers.ts, shared/perPlayerTestutil.ts, client/lib/groundCells.ts, client/features/measure/movement.ts, client/canvas/TokenActionBar.tsx.
- **C. Pose literals carrying `squeeze` by hand, 109 lines in 30 files:** pattern `(\bsqueeze: |[{,] *squeeze *[,}]|\.\.\.\(.*squeeze)`, then kept only lines that also match `\bx\b|size|\.\.\.`, dropping shared/rules/footprint.ts and `testutil` paths. drop.ts 22, movement.ts 17, traps.ts 9, permissions.ts 9, route.ts 6, attach.ts 5, moveLeg.ts 3, server/rooms/actor.ts 3, movement/preview.ts 3, measure/walkRuler.ts 3, then 2 each in path.ts, areaTriggers.ts, protocol.ts, project.ts, server/rooms/ephemeral.ts, traps/rules.ts, relief/IsoBoard.tsx, canvas/dragNotes.ts, canvas/Stage.tsx, and 1 each in walk.ts, reducer/tokens.ts, differential.ts, server/rooms/undo.ts, traps/Crossing.tsx, movement/teleport.ts, movement/StopNote.tsx, measure/movement.ts, attach/walk.ts, canvas/tokenShadow.ts, canvas/isoDrag.ts.
- **D. Every `squeeze` field line, 264 in 47 files:** pattern `\.squeeze\b|\bsqueeze\s*[:?]|\{ *squeeze *\}|squeeze,|"squeeze"`, dropping shared/rules/footprint.ts. The build adds `nudge` beside `squeeze` only in the pose lists of the shared and server files: shared/model.ts, stateSchema.ts, undoCorrection.ts, undoDm.ts, undo.ts, permissions.ts, project.ts.
- **E. Client token position reads, 99 lines in 36 files:** pattern `\b(token|t|tok|lead|f\.token|holder|rider)\.(x|y)\b` over client/features, client/lib and client/canvas, also dropping `Testing\.ts:`. Sorted by file in 6.2.

## 13. As built

Shared and server:

- OP_VERSION is 44 and SNAPSHOT_VERSION is 34, with identity migration steps, as 5.7 says.
- `tx.finish()` is at shared/reducer.ts:196 in the tree it was built on. `keepNudges` lives in shared/reducer/tokens.ts and runs after the trap, notice and area reminder steps, just before the DM's correction block, so a correction line reads each token as the op leaves it (D-261102-580). Permission sites moved too: token.update at :921, `moveCheck` at :1518, `POSE_FIELDS` at :1764.
- shared/rules/nudge.ts also exports `nudgeable`, `freeDrawnAt` (the release rounded to 1/8 and held within the bound, which the client uses too), `drawnSpot`, `withNudge`, `nudgesToJudge` and `NUDGE_STEPS`.
- A `token.update` of `drawnAt` on the token's own spot, or past the bound, leaves no nudge and is not refused, as a move's does. The client clamps and rounds before it sends (D-261102-581).
- Import refuses a nudge that no op would leave (a hex scene, off its snapped spot, squeezed, past its size's bound), naming `tokens.<id>.nudge`, as it refuses square data on a hex scene (D-261102-582).
- A group resize clears the nudges of its tokens, as each member runs `token.update` with a size (D-261102-583).
- The lock rule on undo holds on the in-place owner path of `restoreMoveCheck` only, as 5.4 says. An owner's undo of their own link on a locked token, a path the lock does not hold for the place either, may bring back a nudge the attach's pass dropped (D-261102-584).
- The grid switch, undo and redo case is tested in shared/reducer/nudge.test.ts and server/rooms/undoDm.test.ts and undo.test.ts, not in gridShape.test.ts. The touch rule case runs through `touchLanding` in the reducer test and in the property test.

Client drawing:

- scene.ts's `drawnAt(g, token)` shares a name with boardPick.ts's `drawnAt`, the drawn ground height, so Stage.tsx imports the new one under another name.
- tokenShadow.ts and RemoteDrags.tsx did not change. `tokenLift` compares rules spots, local drag spots are rules spots, and a ghost draws at its frame, which is already a drawn spot.
- `coversHolder`, `dragLead` and `drawsInset` stay on rules boxes, since they decide who a drag moves (D-261102-586). Only the press holes and the tethers read drawn boxes. A drag link's tether ends at each token's drawn middle (D-261102-589).
- The outline is a dashed Rect in the selection ring's accent color, as wide and dashed as the ring, drawn inside the token's node at minus the nudge. In Isometric it is lifted to the drawn ground under the token, never the standee's raised base (D-261102-587). Heights while moving read the rules cells (D-261102-588).
- The count of Rule E at the tree it was built on is the same as the design's: 99 lines in 36 files.

Client input:

- AreaPreviewLayer.tsx exports `useAimedCatches`, a hook with no effect, because the controllers test refuses any effect in a layer. A small component in Stage.tsx calls it outside both drawing trees (D-261102-592).
- The drag label's line is drawn by RulerLayer.tsx from a store slot Stage.tsx writes, for a lone and a group drag, and the group label now snaps from `rulesSpot` (D-261102-593).
- A drag pressed on a rider that moves its mount is never free, with Alt held or Place freely on. The mount keeps its own placement (D-261102-591). Place freely shows by `canDragToken` (client/canvas/dragRights.ts), not Stage's wider `canDrag` (D-261102-590).
- The bar's anchor still reads the stored spot, at most 3/8 square from the drawn one, as a camera target.
- free.ts rounds and holds a free drop through the shared `freeDrawnAt`, so the client and the server share one rounding and bound, with a test that they agree on random releases. The first build kept its own copy of the math (D-261102-594).
- "Placed between squares." goes through the polite toast announcer.

Screen readers and checks:

- The board is a picture with no element per token, so a token's accessible name is its bar's: "Bree actions, placed between squares" for a nudged token, "Bree actions" otherwise.
- The alignment room measures the bar's play row of a placed goblin with Snap to grid and with Place freely pressed. The outline is canvas, which no DOM check reads, so e2e/snapoff.e2e.ts and the Isometric step read its place from the board instead.
- The keyboard e2e file's step is a hardware arrow key on a placed token, since that file's other steps are about the on-screen keyboard.
