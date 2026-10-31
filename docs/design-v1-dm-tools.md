# raccoon-vtt design addendum: v1 wave 5, DM tools and the rest

This addendum designs every feature still marked v1 in [features.md](features.md) once waves 1 to 4 are counted: the DM tools of section 13, the notes and safety tools of sections 12 and 16, the image sources of section 6, the device settings of sections 2 and 17, full stat blocks (section 15), and the operations work of section 18. It extends [design.md](design.md) and [design-v1-maps-vision.md](design-v1-maps-vision.md) (called "the wave 3 and 4 addendum" below) and follows their rules: server-authoritative state, one pure reducer, per-viewer projection as the security boundary, commit before publish, bounded everything.

It was written against the deployed wave 3 and against wave 4 while wave 4 was being built (the `w4int` workspace): snapshot version 7, op version 3, party vision with sight tiles and the explored layer, movement blocking as a permission rule, and `Token.light` and `Token.partyVision`. Wave 5 was built after wave 4's core merged. Where this file names a design.md section, it means that section as deployed.

Status: built and deployed, as are waves 1 to 4. The design was revised after design review rounds 1 to 5 (section 11 lists every finding and what became of it) and after live play (the notes marked LP5). Where it says "today", it means the app before wave 5. The root [FEATURES.md](../FEATURES.md) lists what the app does now. Section 9 lists the questions for the project owner, who decided every one on 2026-10-14 as recommended: "All defaults good with me".

2026-10-17: wave 7 ends this design's rule of no dice roller. Dice roll on the server (docs/design-v1-dice.md), a requested roll is rolled there or typed (docs/design-v1-roll-request.md), and auto initiative draws on the server too (docs/design-v1-roll-options.md section 7). "No dice roller except auto initiative" under Scope and "No dice" in section 8 describe wave 5 as built.

## Scope

Every v1 item in features.md, read whole on 2026-10-14, and where each one stands:

| Features section | The request | Where |
| --- | --- | --- |
| 2 | "Keyboard shortcuts on desktop, beyond undo and redo (section 13)." | 3.14 |
| 2 | "Low-power mode that renders at a lower resolution." | 3.15 |
| 3 | stamps, phases, duplicate, folders, thumbnails, Universal VTT import | built in wave 3 |
| 6 | "Instant generic tokens from about 4,000 game-icons.net fantasy icons (CC BY 3.0). Works offline." | 3.12 |
| 6 | "Openverse as a free second search source when the monthly SerpApi limit is used up." | 3.13 |
| 8 | "A depth cue: the token's shadow drifts down and away as it rises." | built in wave 4 (addendum 4.4) |
| 11 | walls and doors block movement, dynamic lighting and vision | built in wave 4 |
| 12 | "Map pins linked to notes." | 3.8 |
| 12 | "A per-player drawing permission." | 3.9 |
| 13 | "Table display mode for a TV at in-person sessions: no UI, fog applied, follows the DM view or fits the map." | 3.1 |
| 13 | "Scene outliner: a searchable list of everything on the scene, with tap to focus." | 3.2 |
| 13 | "Request a roll from players ("Dex save, DC 15")." | 3.3 |
| 13 | "Party bar: AC, passive Perception and HP at a glance." | 3.4 |
| 13 | "Edit several selected tokens at once." | 3.5 |
| 15 | "Full stat blocks." | 3.6 |
| 16 | "Journal pages in Markdown: DM-only, shared with all, or private to one player. Secret blocks the DM can reveal." | 3.7 |
| 16 | "Session log export." | 3.10 |
| 16 | "Anonymous safety card (X-card)." | 3.11 |
| 17 | "UI scale setting." | 3.16 |
| 18 | "Scheduled automatic database backups." | 3.17 |
| 18 | "Admin page behind the admin password: list rooms, delete rooms, see storage use." | 3.18 |
| 18 | "Cleanup of unused images." | 3.19 |

The table holds every item still marked v1. Those of sections 3, 8 and 11 belong to waves 3 and 4. The rest are this wave's, and wave 5 built them all. Items marked "first in v1" in features.md (the encounter builder in section 10, the custom monster editor in section 15) are built (design.md 14.6 and 14.8), and so is what sections 4, 5, 7 and 9 once marked v1 (wave 2), which features.md now lists as built. Two v1 promises in design.md are the same items: 16.3's asset garbage collection is features 18's cleanup, and 16.4's nightly `pg_dump` is features 18's backups.

The project owner's recorded decisions that bear on this wave:

- No dice roller except auto initiative (features 14, design.md 17 decisions 1 and 14), so a requested roll is typed in by the player.
- The stat card rule: "Other players see only the name, conditions and whatever HP the DM allows" (features 15).
- No AI-generated art (design.md 20).

"Admin password" did not exist before this wave: only the admin CLI (`scripts/admin.ts`) administered the server, and grants knew only the roles `dm` and `player`. Section 3.18 adds it.

## 1. Summary of the decisions

- **A table display is a viewer, not a member.** A TV gets a display grant of its own through a one-time code, in a display session that no ordinary route accepts. Its connection keeps the player role, with a display flag read only where a display differs, so it receives exactly what a player who owns nothing receives, images included through its own route, sends no ops, and never appears on the roster. It follows a DM's camera on request or fits what players can see.
- **Roll requests are room state with a strict projection.** The DM asks for a saving throw or an ability check, with one or two choices of ability and skill, with or without a DC, and chooses separately whether players see the DC and whether they see pass or fail. Each player answers for their own creature with the total they rolled. Only the DM and that creature's player see an answer, and when the DC is hidden a result is final, so changing totals cannot find the DC.
- **Journal pages are blocks, and secrecy is structural.** A page is a list of Markdown blocks, and a secret block is a block, never a fenced region parsed out of text. Projection drops unrevealed secret blocks for players, so no parser can leak one.
- **Map pins follow labels and pages.** A pin reaches a player only when its scene, the fog and the page it links to all allow it. Deleting a page never widens who sees its pins, and the pin pane never widens a pin linked to a restricted page unless the DM turns DM only off in the same save.
- **The X-card never touches the room state.** A tap goes over its own unlogged HTTP route, authenticated without touching the session, and reaches every device as a message without a sender. Ops are stored with their sender, so the X-card cannot be one.
- **Game icons are shipped art referenced by key.** A token image becomes either an uploaded asset or a shipped icon on a colored disk, as stamps already are. Picking an icon needs no upload, no search, no quota and no outside service.
- **Openverse takes over when SerpApi cannot search**, through the strict egress port, and every image it brings keeps its credit, with what was changed, on the asset row.
- **Multi-token edits are single ops.** `token.updateMany`, `token.deleteMany` and `actor.effects` apply whole or not at all and undo as one step.
- **Device settings get a page of their own.** UI scale, low power and map detail live under Menu, This device, stored on the device only.
- **Limits that the whole table shares an address for are keyed by member.** A group that plays in person shares one home connection, so new limits count per member and room, with loose per-address flood caps.
- **Backups are a compose service.** A container on the database network runs `pg_dump` nightly under a size limit, reads the whole dump back, lists the images it names, copies them, and writes a completion record on the backups volume only when every step passed. Retention trusts those records, never the database. One run at a time holds a lock. Deleted image files wait 48 hours in a trash folder, so a running backup always finds them.
- **The admin page is opt-in.** It exists only when `ADMIN_PASSWORD_HASH` is set, uses its own session cookie, never shows room contents, and deletes rooms through the same path a DM's delete takes.
- **Cleanup deletes only what nobody can pick again** (replaced thumbnails, files no row names) on its own, through a deletion barrier on the room's queue. Library images that nothing uses are marked for the DM, who deletes them (question 2). Undo can no longer bring back a reference to a deleted image.

## 2. Shared ground

### 2.1 What each viewer receives

The projection stays an allowlist (design.md 7.3). The new collections and fields, per viewer:

| Data | DM | Player | Table display |
| --- | --- | --- | --- |
| Roll requests (`rolls`) | all | only requests naming a creature the player owns, with only those targets, the DC only when shown (else `dcHidden` when there is one, never its number), pass or fail only when shown, never an answer's earlier `previous`, `rev` sent as 0, none during a blackout | none |
| Roll log lines (`roll` events) | all | only lines about a creature the player owns now, under the same two switches. With pass or fail hidden, a line that is only the DM's Pass or Fail mark is left out (`isMarkLine` in `shared/project.ts`), since its result is all it says (LP5-ROLLS-4) | none |
| Journal pages (`journal`) | all | pages shared with all or with this player, unrevealed secret blocks dropped, `rev` sent as 0, none during a blackout | pages shared with all, never drawn |
| Map pins (`pins`) | all on the viewed scene | on the player scene, not DM only, not fully under the fog, and linked page readable | as a player, so pins linked to pages shared with all draw on the TV |
| A token's derived `party` flag (a player-kind member owns it) | not needed (the DM has owners) | on every token they receive | on every token it receives |
| `Actor.monsterId` | yes | never, owners included | never |
| `RoomSettings.playersDraw` | yes | yes (meta is shared) | yes |
| Token images that are icons | yes | as the token's image | as the token's image |
| Image files | every asset of the room | their own uploads and the projected visible set, as today | only its projected visible set, through its own route (section 3.1) |
| Log sessions and export | every line but whispers it is not party to | their projected lines only | none |
| X-card | yes | yes | yes |
| DM camera for the display (`view` event) | never | never | yes |

A table display's connection keeps the role `'player'`, so every projection and routing rule treats it as a player, and its viewer is `{ memberId: <display id>, role: 'player' }` (section 3.1). The display id is in no `ownerIds`, no whisper's `to`, no handout's list and no page's access, so it receives what a player who owns nothing receives, by the existing code. The one exception is the log: a display shows none, so it gets no line of it, live or from the archive, and a line only members read, such as a dice line, never changes what a display holds (follow-up batch 23). A separate `display` flag on the connection is read only where a display differs.

### 2.2 New collections and fields

```ts
type RoomState = { ...,
  journal: Record<JournalPageId, JournalPage>   // wave 5, section 3.7
  pins: Record<PinId, Pin>                      // wave 5, section 3.8
  rolls: Record<RollId, RollRequest>            // wave 5, section 3.3
}
RoomSettings.playersDraw?: 'none' | 'all' | MemberId[]   // absent reads as 'all' (section 3.9)
Actor.monsterId?: MonsterId                              // DM only (section 3.6)
type ImageRef = { assetId, crop } | { icon: IconKey, color: string }   // section 3.12
ProjectedToken.party?: true          // player-class projections only, derived: a player-kind member owns it or its character (section 3.1)
```

The shapes are in each feature's section. Each new collection gets everything a collection needs (the wave 3 build listed it): a key in `shared/keys.ts`, a case in `projectEntityCtx`, `allKeys` and `dependents`, rules in `shared/reads.ts`, the stored-state schema (`server/rooms/stateSchema.ts`), the snapshot migration, the import remap, member removal in `shared/reducer/room.ts`, and undo phrases in `server/rooms/undoLabels.ts`.

### 2.3 Versions and migrations

| Wave | Snapshot | Op | Why |
| --- | --- | --- | --- |
| 5 | 8 | 3 (unchanged) | Adds the `journal`, `pins` and `rolls` collections, empty in older snapshots and backups. Every other addition is an optional field (`playersDraw`, `Actor.monsterId`) or a new variant (`ImageRef`'s icon) or a new op. The drawing permission is a permission rule, and replay does not run permissions (persistence.ts replays through the reducer only), so stored drawings replay as they were made. No protocol rule tightens. |

A room without the new fields reads as before: everyone may draw, no token links a room monster, no image is an icon. So no migration step changes an existing room's behavior. A value guard hashes the stored value, and older values lack the new fields, so stored restores still match on replay (design.md 7.7).

The snapshot's `you.role` and the `presence` message gain values (`'display'`, and `displays` for DM sockets). Those are server-to-client messages, never stored, so they need no version.

The database gains, through `db/schema.sql` at boot, each step idempotent as wave 3's kind change was: the `display_codes`, `admin_sessions` and `backup_runs` tables, `'display'` in the `grants.role` check, `sessions.purpose` (`'room'` for every existing row), `assets.unused_since` and `assets.credit`.

### 2.4 Limits

Added to `shared/limits.ts` and design.md 10.5:

| Item | Limit |
| --- | --- |
| Journal pages | 200 per room. Title 80 characters, folder 40. At most 100 blocks a page, 4,000 characters a block, 32 KiB serialized a page, 1 MiB for every page together |
| Map pins | 200 per scene, label 80 characters |
| Roll requests | 20 open in a room at once, 50 targets each, 2 choices each, note 80 characters, DC 1 to 50, a total -50 to 100 |
| Multi-token ops | 100 tokens per `token.updateMany` or `token.deleteMany`, 100 adds and 100 removals per `actor.effects` |
| Table displays | 4 per room. 3 live display codes per room, each valid 10 minutes, one use. Wrong codes: their own bucket per address, 20 per 10 minutes with growing delays. A display session ends at Leave, or 30 days after its last socket closed |
| X-card | in memory only: taps within 10 s in one room merge into one card, and one session sends at most 6 an hour |
| Openverse | server-wide, under Openverse's own: anonymous 150 searches a day and 15 a minute with 20 results each, registered 5,000 a day and 80 a minute with 40. Per member per room 20 a day, per room 60 a day. Per address 150 a day, a flood cap only |
| Log export | every session listing and every export request counts against one limit of 10 an hour per member per room, cached or not, one export at a time per room, and 60 an hour per address as a flood cap |
| Admin login | 5 failures per 15 minutes per IP, then growing delays to 1 hour, and 50 failures an hour across the site closes the login for an hour |
| Backups | one run at a time, 7 daily and 4 weekly good dumps, the current and last good one always kept, 2 GiB kept free on the backups volume |
| Image cleanup | replaced thumbnails 1 day after they stop being used, files no row names 1 day after they were written, the trash after 48 hours, 500 images per library delete |

**Why per member.** A group that plays in person shares one home connection, so every phone at the table reaches the server from one address. A per-address limit there is a limit on the whole table: four log exports an hour per address would be four for everyone together. So the new limits that people at the table spend count per member (the grant) and room, and per-address limits stay only as loose caps against a flood, sized for about 8 devices behind one address. The admin login is the exception, since only the server owner uses it.

**Room-level data and the projected scene size.** Journal pages and roll requests are room-level data, so they ride in every DM snapshot, as custom monsters do, and count toward the 3 MiB a DM's projected scene may hold. The size guard measures each page once per version, as it measures monsters. But today the guard checks only the scenes an op touched (`SizeGuard.check` adds growth to the scenes it is given), and a room-level op touches none, so a journal edit could push a scene nobody is viewing past 3 MiB unchecked. So the guard splits a DM's projected size into the room-level part and each scene's own part. The room-level part is measured as the most any DM can receive: the room-level data every DM projection shares, plus the in-memory log's shared lines. Since follow-up batch 23 the log's whispers, DM lines and party lines' copies ride outside the measure under bounds of their own (docs/design.md 7.3, Log), so a line a player cannot read never decides whether their op passes, and two DMs' projections differ by at most their own whispers. Each scene's own part is measured once when the room loads, from one pass over the stored entities grouped by `sceneId` (plus wave 4's sight reserve on a vision scene), the same pass that measures the room's size, never a projection per scene, and kept with its growth bound, and an op that touches a scene updates its part as the guard does today. A room-level op, a restore of room-level entities included, is checked against the room-level part plus its growth plus the largest scene part. That is the check of every scene and every DM at once, at the cost of one comparison per op. A room with 1 MiB of monsters and 1 MiB of journal has 1 MiB left for its largest scene. The guard refuses the op that would cross, with its usual message. Section 7 lists the trade-off. Tests: two scenes, the one not viewed near 3 MiB, and a journal edit that would carry it past is refused while a smaller one passes. Two DMs with different whisper histories near the limit get the same answer, since whispers ride outside the measure (follow-up batch 23).

### 2.5 Export and import

`room.json` carries the journal, pins and roll requests as they are stored, plus `playersDraw`, `monsterId` and icon images. The import (design.md 16.4) gives pages, pins and requests new IDs, remaps a page's member access, a pin's page and scene, and a token's `monsterId` (dropped when its monster did not come through). It drops every open roll request, since a request belongs to a moment of play and its targets' players have new member IDs anyway. The export still carries them, because an export is the stored state with nothing taken out but whispers the DM may not read, so it stays a faithful backup, and what a new room keeps is the import's choice. An icon image keeps its key, which means the same in every room. An asset's credit (section 3.13) travels in `assets.json` and is checked as text on import.

Display grants and codes, admin sessions and backup records are server data, never part of a room, and are never exported.

### 2.6 Undo

New DM ops go on the DM's stack as every DM op does, with whole-value restores under value guards (design.md 7.7). The new player ops (`roll.answer`) go on no stack: a player answers again to change an answer. The rule for players' stacks is unchanged (drawings and moves only).

One rule is new for every restore. **A restore never brings back an image that was deleted.** Until now no asset row was ever deleted inside a live room, so a restore could not name a missing one. Cleanup and the DM's library delete (section 3.19) make that possible: undoing a token's deletion after its image was deleted would put back a token that draws a broken picture for everyone. So the actor loads asset facts for the asset IDs a `sys.restore` would add (the same walk `assetIdsOf` does for client ops), and permissions refuse a restore that adds a reference to an asset that is not this room's, of the kind that place takes: "could not undo deleting Goblin 2: its image was deleted since". Thumbnails are bookkeeping and a restore keeps the current one (design.md 7.7), so they never come back this way. Replay does not run permissions, so stored restores replay as they were.

One more for players: a player's undo or redo that would put a drawing back (any kind but a kept ruler) needs the drawing permission now, as making one does (section 3.9). Taking a drawing away stays allowed.

### 2.7 This device

There is no page for device settings today. The map variant switch (`rvtt.mapVariant`) is read and never written, and the turn and ping sounds live in their own panels. Wave 5 adds "This device" to the Menu panel, beside Members, Room settings and About, for settings that belong to one device and are stored in its local storage (read and written inside try and catch, as every `rvtt.*` key is):

- UI scale (section 3.16).
- Low power (section 3.15).
- Map detail: "Phone size" or "Full size", writing `rvtt.mapVariant`, which finally gets the control design.md 11.2 promised.
- Shortcuts, a link to the shortcut sheet (section 3.14).
- Turn sound and ping sound, mirrored from where they live now, so one page has them all.

Each setting follows the store pattern the sounds use (a module variable, a listener set and `useSyncExternalStore`).

## 3. The features

### 3.1 Table display mode

The request: "Table display mode for a TV at in-person sessions: no UI, fog applied, follows the DM view or fits the map."

**Why a grant of its own.** The TV shows the players' view to the whole table, so it must receive the players' data and nothing more. "View as a player" computes that view from the DM's own data in the DM's page (`client/features/dm/preview.ts`), which is fine on the DM's screen and wrong on a TV: the device would hold the DM's data, and a DM socket also receives the DM's own drag previews of hidden monsters, which the server filters only for players. A TV joined as a player would show on the roster, could be continued as, and could drag tokens when the DM lets players move any token. So a display holds a third kind of grant, `display`, whose socket the server treats as a player who owns nothing and may send nothing.

**DM behavior.** The DM panel, beside Player link and DM devices, gains a "Table display" section:

- "Open on this device" is for a laptop wired to the TV. It mints a code and opens `/display#code=<code>` in a new window, which redeems it. The page in that window draws only from the display session (below): its socket and its image reads use the display cookie, so what it draws is what players get, and a hidden monster dragged on the DM's screen never shows on the TV. This is still the DM's own browser, which holds the DM's cookie too, so anyone using that laptop can reach the DM's data from it. The guarantee is about what the display page draws, not about the person at the laptop.
- "Add a TV" is for a TV's own browser or a spare device, and is the way to a display that holds nothing of the DM's. It shows the code large, grouped for typing with a remote ("K7QH 2MXA 4F"), a link and a QR code of the link, "valid for 10 minutes, once". On the TV, Home's "Set up a table display" opens `/display`, a page with one large field for the code.
- The section lists connected displays ("1 display connected", from the `presence` count below) and has "Show my view on the table display", a switch for this DM device (below). Displays also appear in the DM devices list as "Table display" with the device's label, online status and Sign out.

**The display.** Full screen, the player scene as players see it: the map, the build and stamps, fog opaque, party vision as players get it (wave 4), tokens, shared areas, drawings, pins (those linked to pages shared with all included), and other members' pings, laser, rulers and drag previews as a player who owns nothing receives them. No bars, toolbar, panels, chips, toasts, log, roll requests or initiative strip. It does show:

- the pause screen during a blackout, as players do,
- handouts shown to everyone, which close when the DM closes them, or with a tap on the display,
- the X-card (section 3.11),
- the scene loading notice and the connection banner after 3 s offline,
- "Waiting for the DM to choose a scene" when there is no player scene.

A tap, a click or any key shows a small menu for 5 s: Follow the DM, Fit the map, Show whose turn it is (off by default, question 8), Full screen, and Leave. While a handout or the X-card is open, a tap closes it and nothing else, and the next tap opens the menu. The choices are remembered on the device. Leave signs the display out for good (below), and Home then offers "Set up a table display" again.

**Camera.**

- **Fit the map** fits what players can see: `fitTarget` for a player under fog (the revealed area, which on a vision scene is the explored layer merged with the DM's fog), widened to the party's tokens on the scene instead of the viewer's own, since a display owns none. A display's projection carries no owners, so every player-class projection of a token gains a derived `party` flag, true exactly when a member of kind player owns the token or its character (`anyPlayer`, as `playerPlays` reads owners). Not `playerOwned`, which counts a DM owner too, not `partyVision`, and not `kind: 'pc'` or `aboveFog`, which are each wrong for some token. Wave 4's fog rule keeps its own reading of owners (`playerOwned`) as it is. Who plays which character is no secret at the table, and players already see each other's tokens. With fog off it fits the whole scene. It fits again when that area changes, at most once every 2 s, so a reveal brings the new room into view.
- **Follow the DM** shows the area a DM device sees. A DM device with "Show my view on the table display" on sends its camera as a new ephemeral event, `{k: 'view', x, y, w, h}`: the center and the width and height of its visible map area, in cells. It sends at most every 120 ms while the camera moves, as Follow me does (`CameraLayer.tsx`), once more when the display count rises, and nothing at rest. The display fits that rectangle to its own screen, so a TV shows the same area as a phone, not the same pixels per cell. It also obeys the DM's `focus` events (Follow me, Bring everyone here, Look here), since those are the DM's camera too. A DM device sends `view` only while it views the player scene, so the TV never moves to a scene players cannot see. When the DM leaves for another scene, the display keeps its last view.

**Codes.**

- `POST /api/rooms/:id/display/code` (DM grant) mints a code: 10 Crockford base32 characters (50 bits), stored as `sha256` in a `display_codes` table with the room, the minting session, the room's `player_epoch` and an expiry 10 minutes away. At most 3 live codes per room.
- `POST /api/display/redeem {code}` (anyone, CSRF rule) first looks the code up by its hash to find its room, refuses a room with 4 displays with `409 displays_full` ("This room has 4 table displays. Sign one out first.") before anything is spent, then redeems with one statement, as DM invites do: `update display_codes set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() and player_epoch = (select player_epoch from rooms where id = room_id) returning room_id`. On success it writes a display grant for the caller's display session (made if there is none) and answers `{roomId}`.
- Wrong codes count in a failure bucket of their own per address, 20 per 10 minutes with the joins' growing delays, so a TV's typos never use up the players' join budget at the same home address (section 2.4). 50 bits that live 10 minutes cannot be guessed under it.

**Display sessions are not room sessions.**

- A display session is a `sessions` row whose new `purpose` column is `'display'` (every other row is `'room'`). Its token travels in a second cookie, `__Host-rvtt-display` (`rvtt-display` in development), with the same attributes as the room cookie, so a DM's laptop can hold the DM's session and a display session at once.
- The server decides by the session's purpose, never by the cookie's name. Each display route names the session it takes:
  - `POST /api/rooms/:id/display/code` (minting) takes the ordinary DM rule: a `'room'` session from the room cookie, with a DM grant for the room.
  - `POST /api/display/redeem` takes any caller, with any cookie or none. It makes the display session (or keeps the display cookie's session when it is a live `'display'` one) and sets the display cookie.
  - `GET /api/rooms/:id/display/me`, the display image route, `DELETE /api/display/session` (Leave) and the socket opened with `/ws?room=<id>&as=display` take only a `'display'` session, from the display cookie.
- Every other route and socket reads only the room cookie and treats a `'display'` session there as no session at all: `401 no_session`, before any grant is looked at. So a display token copied into the room cookie cannot upload, import, search, join, claim DM, export, tap the X-card or send anything, and a room session presented as a display cookie opens no display.
- **The grant** is a `grants` row with role `display` (the role check gains it), a member id `display:<12 random characters>` that no member can have (members get UUIDv7s, and "continue as" lists only the roster), and epoch `player_epoch`. Changing the player password signs every display out, as it signs out every player. The DM devices list's Sign out deletes its grant like any DM device's. Kicks and member removal never name it, since it is no member.
- **Lifetime.** Leave sends `DELETE /api/display/session`, which deletes the grant and the session row and clears the cookie. A display session otherwise ends 30 days after its last socket closed, instead of the 180 days of a room session (question 13). While a display socket is open, the 60 s grant recheck renews the session's expiry to 30 days ahead whenever it is under 29 days away, about one write a day, so a connected display never expires. When the display's last socket closes, the session's expiry is set to 30 days from that moment, so it ends exactly 30 days after its last socket closed. Both renewals apply only to a session still live, enforced in the update's own condition (`and expires_at > now()`), and a close with code `4001` (the recheck finding the session gone or expired, a sign out, a password change) renews nothing, so a socket closing after its session expired never revives it. The same recheck closes a display socket with `4001` when its session is gone or expired, as it closes a socket whose grant is gone.

**The socket.** The connection keeps role `'player'`, the role every rule in `server/rooms/ephemeral.ts` and projection reads, so a display gets exactly the fog checks, the path stripping and the `focus` delivery a player gets. A separate `display: true` flag marks it, read only where a display differs:

- it may send `hello` and `ping` only, and an `op`, an `eph` or a `scene` closes it with `4003`, since only a hostile client sends one,
- its id never appears in `online`, and DM sockets get `displays: n`, the number of display sockets open,
- `view` events reach only display sockets on their scene, and only from a DM sender,
- its snapshot's `you.role` reads `'display'`,
- the X-card reaches it (section 3.11).

Its `hello` covers the player scene like a player's, and it counts toward the per-room socket cap.

**Images.** The canvas reads images from `/api/assets/:assetId/:variant`, which authenticates with the room cookie, so a TV holding only a display cookie would get 404 for every map and token. The display reads them from `GET /api/rooms/:id/display/assets/:assetId/:variant` instead, through the display cookie, allowed exactly for the assets in its own projected visible set (`visibleAssetIds` for its viewer): the map showing, images of tokens it can see, stamps' library images, and handouts shown to everyone. The uploader rule is never applied to a display, since a display uploads nothing. The library listing (`GET /api/rooms/:id/assets`) refuses a display session like any other ordinary route. The response headers are the asset route's.

**Client.** The router gains `/display` (enter a code) and `/display/:roomId`, which renders the stage alone through a `DisplayRoom` that mounts the existing canvas layers without the chrome and builds image URLs from the display route. The installed app's `start_url` stays `/`.

**Model and ops.** No room state but the derived `party` flag. Server: the `display_codes` table, `sessions.purpose`, and the `grants.role` check.

**Projection.** Unchanged code beyond the `party` flag: the display's viewer is a player who owns nothing (section 2.1). Its projection may carry chat and pages shared with everyone, which the display client never draws.

**Undo.** None. A display sends no ops.

**Limits.** 4 displays per room, 3 live codes per room, its own failure bucket (section 2.4).

**Performance.** One more socket per TV, receiving what a player receives. `view` events only while a driving DM's camera moves.

**Security.** A display in a shared place, such as a smart TV in a living room, holds a session that can read the player scene until it leaves, is signed out, the password changes, or 30 days pass without it connecting. Its data is exactly a player's with no ownership, so nothing is on it that any player could not see.

**Tests.** Integration:

- Minting works with only the DM's room cookie, and redeeming works with no cookie at all, making the display session. A code redeems once, and an expired, used or other-room code is refused. The fifth display is refused before the code is spent. Wrong codes use their own bucket and leave joins at the same address untouched.
- A display socket's snapshot equals a fresh projection for a player with no ownership, the `party` flag included. An op, an eph or a `scene` from a display closes it with `4003`.
- A DM's drag of a token under fog reaches no display, and a display's drag frames on a fog or vision scene carry no path, as a player's do. `view` reaches displays and no player or DM. `focus` reaches displays.
- A password change closes displays with `4001`. An open display socket keeps its session past 30 days, the expiry is 30 days after the last socket closed, a socket whose session was deleted or expired closes with `4001` at the next recheck, and an expired session stays unusable after its last socket finishes closing. The devices list shows a display and Sign out closes it. Leave deletes the grant and the session and clears the cookie. `online` never lists a display while DM sockets get the count.
- With only a display cookie, the display image route serves the showing map and a visible token's image, and answers 404 for a hidden token's image, a scene thumbnail and a handout not shown to everyone. The library listing refuses a display.
- Cookie substitution: a display token sent under the room cookie's name is refused by uploads, URL imports, image search, joins, DM claims, the log export, the X-card and an ordinary socket, and a room token under the display cookie's name opens no display. A browser holding both cookies opens a DM socket and a display socket that each get their own projection.

Client: the Follow the DM fit for TV and phone aspect ratios, Fit the map over revealed ground and party tokens, and a tap on an open handout closing it without opening the menu.

### 3.2 Scene outliner

The request: "Scene outliner: a searchable list of everything on the scene, with tap to focus."

**Behavior.** A DM-only panel, Outliner, in the panels registry: a bottom sheet on a phone and a side panel tab from 900 px up. Players do not get it: features 13 lists it among the DM's tools.

- It lists what the DM's view holds for the scene in view, in groups that fold, each with a count: Creatures and objects (tokens), Map (stamps, labels, pins, lights), Areas, Drawings (texts and kept rulers by kind and owner), and Doors (every door and window, secret ones first, from the build chunks, free ones included).
- Each row says what players get: "Hidden", "Under fog", "Out of the party's sight" (wave 4) or "DM only", read through the shared projection helpers (`withheldWhereItStands` and the label and stamp fog rules), so the outliner and projection never disagree. A secret door reads "Secret door, hidden" or "found".
- A search field filters every group by name or text as you type. Chips narrow it to one group.
- A tap on a row frames the item with `findCamera` (the Find my token framing, which takes any rectangle) and selects it where a selection exists. On a phone the tap first closes the panel's sheet (`PanelProps.close()`, as the placing tools do), so the item is not under it. A token opens its action bar, a label its pane, an area becomes the area tool's pick, and a stamp or a light opens the builder in its mode with it selected. Drawings and doors have no selection, so their outline flashes for 1.5 s.

**Model, ops, permissions.** None. It reads the DM's view.

**Performance.** A scene at its limits holds about 5,000 rows (500 tokens, 500 labels, 500 stamps, 2,000 drawings, 1,000 doors, and the rest). The list is windowed at a fixed 44 px row height, and the search index is a lowercase string per row, rebuilt when the view's collections change identity.

**Tests.** Rows and their marks per kind, search, the rectangle each kind frames, and the windowing math.

### 3.3 Request a roll

The request: "Request a roll from players ("Dex save, DC 15")."

**The rules it follows** (SRD 5.2.1). A saving throw and an ability check are D20 Tests named for an ability, and a check may name a skill: "a Strength (Acrobatics or Athletics) check" (page 6, skills table page 9). "If the total of the d20 and its modifiers equals or exceeds the target number, the D20 Test succeeds", and the target number of a check or a save is its DC (page 6). The SRD often lets the creature choose: a grappled creature makes "a Strength (Athletics) or Dexterity (Acrobatics) check against the grapple's escape DC" (page 182), the target of a grapple makes "a Strength or Dexterity saving throw (it chooses which)" (page 190), and a rule may allow "a Charisma (Deception or Persuasion) check" (page 8). The Typical Difficulty Classes (Very easy 5, Easy 10, Medium 15, Hard 20, Very hard 25, Nearly impossible 30) are for ability checks, while "The Difficulty Class for a saving throw is determined by the effect that causes it or by the GM" (pages 6 and 7). "If you don't want to resist the effect, you can choose to fail the save without rolling" (page 7). Since wave 7 the player's card rolls on the server too, with the creature's bonus or one the player types, and a player may still roll physical dice or use D&D Beyond and type the total (docs/design-v1-roll-request.md 5).

**The party, once for every entry point.** The party is every character a member of kind player owns (`anyPlayer`). "Ask the party" offers all of them: those with a token on the player scene start ticked, and those without one there are listed unticked, "on another scene". When the DM is viewing a scene other than the player scene, every party character starts ticked and none is called "on another scene", since the DM is not looking at the player scene to judge who stands there (LP5-ROLLS-2). From a token's action bar, the selected creatures start ticked instead, which may include a creature a player owns that is not a character (a familiar). Only creatures a player plays can be asked, since the request goes to players.

**Since wave 7** (docs/design-v1-roll-request.md): the sheet's controls are that design's section 4, the player's card its section 5 and the live card its section 6. They replace the sheet's bullets below, the card's number field and Send bullet, and the live card's paragraph. The model and ops gain its sections 1.1 and 7.5: answer provenance (`tag`, `mark`, `dice`), the request's `spell`, `cause` and `ends`, a player's ask (`roll.change`), and `roll.close` with `settle` and `ifSettled`. What follows is the wave 5 design, kept for the rules it states.

**DM behavior.** "Request a roll" is in the party bar ("Ask the party", section 3.4) and in the action bar of one or several selected creatures a player plays. A sheet asks:

- Save or Check, then the ability as six chips. A check may also name one of the SRD's 18 skills, listed under their abilities. A skill fills in its usual ability from the table on page 9 (Athletics, Strength), and the DM can change it.
- "Or" adds a second choice, so the request reads "Strength (Athletics) or Dexterity (Acrobatics)" or "Strength or Dexterity saving throw". Two choices at most, each an ability with an optional skill. The creature picks which one it rolls.
- DC, a number field, or none ("Roll Perception" with no DC). For a check, the six typical DCs are chips labeled with their SRD names. A save's DC is the effect's, so a save offers the number field without the typical-DC chips.
- "Players see the DC" and "Players see pass or fail", two switches, both on by default, since the request's example names the DC ("Dex save, DC 15"). The DM may hide either, since "The Game Master determines target numbers and tells players whether their rolls are successful" (page 6). Question 12 asks the project owner about the defaults.
- A note, such as "against the poison".
- The targets, as above.

Send opens a live card for the DM in the fight alerts column (`FightAlerts` in `client/features/encounter/InitiativeStrip.tsx`, where the concentration card lives today, always mounted): each target with "waiting" or its choice, total and pass or fail, Pass and Fail buttons to mark a roll with no DC or to overrule, Reopen on an answer (below), and Close. An answer that replaced an earlier one is marked with it: "17, changed from 12 (Fail)". Several open requests stack, newest on top, and "Close all answered" closes every request whose targets have all answered.

**Player behavior.** A card comes up on the device of each target's player (a bottom sheet on a phone, a card from 600 px up), with a vibration on Android and the turn chime when sound is on: "The DM asks for a Strength (Athletics) or Dexterity (Acrobatics) check: to break free of the grapple." For each of their creatures it asked about:

- With two choices, which one they rolled, the first picked to start.
- Reminders from the creature's conditions and statuses, from their SRD text in `shared/srd/rules-text.json` (a table in `shared/rules/rollReminders.ts`). Each shows only when it bears on what was asked:
  - Paralyzed, Petrified, Stunned and Unconscious "automatically fail Strength and Dexterity saving throws".
  - Restrained has "Disadvantage on Dexterity saving throws".
  - Blinded and Deafened "automatically fail any ability check that requires sight" or hearing.
  - Poisoned has Disadvantage on ability checks, and Frightened too "while the source of fear is within line of sight".
  - Exhaustion as its number: "Exhaustion 2: the roll is reduced by 4", from the effect's level ("reduced by 2 times your Exhaustion level").
  - Dodging makes Dexterity saves with Advantage, lost "if you have the Incapacitated condition or if your Speed is 0".
  - Hasted makes Dexterity saves with Advantage.
  - Raging has "Advantage on Strength checks and Strength saving throws", ended early by Heavy armor or the Incapacitated condition.
  - Blessed adds 1d4 to a save and Baned subtracts 1d4.
  - Hexed: "Disadvantage on ability checks made with the ability the hex chose", worded generally, since the effect does not store which ability.
  - Heroic Inspiration: it can be spent "to reroll any die immediately after rolling it".

  They remind and decide nothing. A condition the DM hid is not in the player's data, so it never shows.
- A number field (16 px) and Send. A save also offers "Fail without rolling".
- After Send the card folds into a chip in the fight alerts column, "Dex save: sent 17. Pass." (or "sent 17" when pass or fail is hidden), and the map is clear again. A tap on the chip opens the card to change the answer while the request is open. Several requests stack as chips, newest on top. On a phone only the newest two show, followed by a "Rolls" button that shows the rest and folds them again, and while a sheet covers the map in portrait every chip folds into that one button, whose tap closes the sheet. The chip goes when the DM closes the request.
- **When the request has a DC, the DC is hidden and pass or fail is shown,** an answer is final once it has a result, the reducer's from the DC or a DM's mark. Otherwise a player could change their total from 12 to 15 to 14 and read the DC from the passes and fails, as six tries would find any DC from 1 to 50. So the chip then reads, as plain text, "Final. Ask the DM to change it." and offers no change. The player cannot tell this case from a request with no DC by the DC, which they never receive, so a request with a hidden DC carries `dcHidden: true` in their projection, with no number, and the card reads "Dexterity saving throw, DC hidden". The chip shows "Final" when `dcHidden`, `resultShown` and the answer's result are all there. The reducer enforces finality whatever the client shows, and the DM can reopen that answer from the live card, which clears it for one more answer. With the DC shown there is nothing to find, and with pass or fail hidden there is no answer to read, so a player may change freely until the request closes.
- **On a request with no DC,** the result is only ever the DM's mark or the player's own "Fail without rolling", so an answer that replaces another moves the old answer, its mark included, into `previous` and clears the obsolete mark, and the DM's card shows it as waiting for a mark again rather than keeping a pass that belonged to the old total. A result the new answer supplies itself is kept: a player's "Fail without rolling", or the DM's replacement mark. Finality is defined only for a request that has a DC.

During a blackout no card or chip shows, since a player's whole room is the pause screen (decision 13).

**Model.**

```ts
type RollId = string
type SkillKey = 'acrobatics' | 'animal-handling' | 'arcana' | 'athletics' | 'deception' | 'history' | 'insight'
  | 'intimidation' | 'investigation' | 'medicine' | 'nature' | 'perception' | 'performance' | 'persuasion'
  | 'religion' | 'sleight-of-hand' | 'stealth' | 'survival'
type RollChoice = { ability: AbilityKey, skill?: SkillKey }   // skill only in a check
type RollTest = { kind: 'save' | 'check', choices: RollChoice[] }   // 1 or 2
type RollRequest = { id, rev, test: RollTest,
  dc?: number,              // 1 to 50
  dcShown: boolean,         // players see the DC
  dcHidden?: true,          // player projections only, derived: there is a DC and it is hidden
  resultShown: boolean,     // players see pass or fail
  note?: string,            // single-line text, at most 80
  at: string,               // the envelope time it was asked
  targets: RollTarget[] }   // 1 to 50, one per creature
type RollTarget = { tokenId?: TokenId, characterId?: CharacterId,   // exactly one
  choice?: 0 | 1, total?: number, result?: 'pass' | 'fail', by?: MemberId,
  previous?: { choice?: 0 | 1, total?: number, result?: 'pass' | 'fail' } }   // DM only: the answer it replaced
// LogEvent gains: { type: 'roll', test, choice?, dc?, dcShown?: true, resultShown?: true,
//   tokenId? | characterId?, total?, result? }
```

Choices are pairs, never separate lists of abilities and skills, which would lose which skill goes with which ability. A skill's ability may differ from the table's (the SRD allows it), so the table only fills in a default. A token target is on the player scene when asked.

**Ops.**

- `roll.ask { request }`, DM only. Refused when a target is not played by a player, or at 20 open requests.
- `roll.answer { rollId, target, choice?, total?, result? }`. A player answers for a target they own: a `total` with the choice they rolled, or `result: 'fail'` with no total on a save. The DM answers or marks any target with either. The reducer sets `by` to the actor, and with a DC and a total it sets `result` itself (`total >= dc`). An answer that replaces another keeps the replaced one as `previous`. On a request with no DC, the replaced answer's `result` is cleared unless the new answer supplies its own (`result: 'fail'` without rolling, or the DM's mark), which is kept. On a request with a DC that is hidden while pass or fail is shown, a player's answer to a target that already has a result is refused with `forbidden`, "Ask the DM to change it." It writes a `roll` log line.
- `roll.reopen { rollId, target }`, DM only, clears a target's answer (keeping it as `previous`), so its player may answer once more.
- `roll.close { rollIds }`, DM only, removes one request or several ("Close all answered"). The log keeps the answers.

**Permissions.** `roll.ask`, `roll.reopen` and `roll.close` are the DM's. A player's `roll.answer` needs a target they own now and a request that exists, and gets `gone` for anything else, the same answer as a missing request, so a refusal never says whom else the DM asked.

**Projection.** Section 2.1. A player gets a request only when one of its targets is theirs, with only their targets, `dc` only when `dcShown`, `dcHidden: true` instead when the request has a DC that is hidden (its number never), every `result` only when `resultShown`, `by` and `previous` dropped and `rev` sent as 0, so another player's answer sends them nothing. A `roll` line reaches the DM and the players who own its creature now, under the same two switches. A display gets neither (question 14). A request's projection depends on ownership, and ownership changes already set `global` (`isGlobalChange`).

**Undo.** `roll.ask` undoes as removal while nobody has answered ("could not undo asking for a Dexterity saving throw: it was changed since" once someone has). `roll.close` undoes by bringing the requests back. A player's answer is on no stack, so they send again. A DM's mark undoes like any DM op.

**Optimistic replay.** A player's view of a request lacks the hidden DC and the other targets, so `roll.answer` reads the whole request and waits for the server. Send reads "Sending…" until the answer, which is quick.

**Export and import.** Section 2.5: open requests are dropped, and the log lines travel with the log.

**Tests.** Each skill's default ability against the table on page 9, one or two choices and nothing else, a skill refused in a save, the answer's choice index, pass at exactly the DC, fail without rolling only on a save, the DM's marks, closing several, an answer final once it has a result only on a request with a hidden DC and pass or fail shown, its refusal and the chip's plain "Final" text, a request with DC 15 hidden and one with no DC told apart through the player projection (`dcHidden`) and the chip, with no number in either, a replacing answer on a request with no DC clearing the old mark while keeping a result it supplies itself ("Fail without rolling" and a DM's replacement mark), the DM's reopen allowing one more answer, `previous` kept and shown only to the DM, the projection under each switch (a player never holds another player's target, a hidden DC or a hidden result, and another player's answer sends them nothing), the log line's projection, `gone` for a request the player has no target in, undo refused once answered, ownership changes re-projecting, each reminder against the SRD text it quotes (Exhaustion's number from the effect's level, the Dodge and Rage caveats, Hex worded generally), the default targets for each entry point, the card folding into a chip, and import dropping requests.

### 3.4 Party bar

Changed by docs/design-v1-side-headers.md: folded in the side panel, the bar is one 45 px line, its names and HP in a strip that scrolls sideways, and Ask.

The request: "Party bar: AC, passive Perception and HP at a glance."

**Behavior.** DM only. A player already sees each party member's name, conditions and whatever HP the DM allows (an exact number or only a label) in the Characters panel, and that rule, "Other players see only the name, conditions and whatever HP the DM allows" (features 15), keeps other characters' AC and Passive Perception out of a player's data, so a player's bar would show nothing new.

- The party is every character a member of kind player owns, in roster order, the same party a roll request asks (section 3.3).
- Each entry: portrait, name, HP as current over maximum with temporary HP as "+5", a thin bar colored by the HP label, AC on a shield, Passive Perception on an eye, up to three condition chips and "+N", and Dying, Stable or Dead in place of the bar.
- From 900 px up it sits at the top of the side panel, above the tabs, and folds to one line of names and HP. On a phone it is a panel, Party, in the panels list, since the DM's phone top bar is full.
- A tap on an entry frames that character's token on the scene in view, if it has one there, and opens its action bar. On a phone the tap first closes the Party sheet (`PanelProps.close()`). "Ask the party" opens Request a roll (section 3.3) with the party's default targets.

**Model, ops, permissions.** None. It reads the DM's view, which holds every character.

**Tests.** Who is in the party, the entry's numbers and states, and the tap's framing.

### 3.5 Edit several tokens at once

The request: "Edit several selected tokens at once."

**Today.** Selecting several tokens is built (Shift or Cmd and a click, "Select several", a box drag), and a group can move together and take one HP entry. The group action bar offers nothing else, and there is no op that changes several tokens except `token.moveMany`.

**Behavior.** With two or more tokens selected, the group action bar gains:

- Conditions: the quick grid of the single bar. A tap adds the condition to every selected creature that lacks it, and a tap on a lit condition removes it from every one that has it. A condition is lit when all have it and half lit when some do.
- Elevation +5 and -5, as one move of the group.
- For the DM: Hidden, Locked, Add to the fight, and Delete ("Delete 6 tokens?" on the second tap, red as every destructive button), plus More, a sheet with disposition, HP shown to players, size, layer, "Hide name from players", "Always visible to players", image (the same image for all), and owners.

An action shows only when the viewer may apply it to every selected token (`tokenAccess` per token), so a player who selected their own creatures gets conditions and elevation, and nothing they would be refused. Objects are left out of conditions.

**Ops.**

- `token.updateMany { tokenIds, patch }`: 1 to 100 tokens and one patch for all. The patch takes only the fields that make sense for a group: `visibility`, `locked`, `disposition`, `hpVisibility`, `size` with `w` and `h`, `layer`, `kind`, `nameHidden`, `fogExempt`, `image`, `ownerIds`, and wave 4's `light` and `partyVision`. Names, notes, numbers, other images, range rings, positions, scenes and stats stay per creature. The DM may send any of these. A player may send the owner fields among them (`image`, `light`) for tokens they own.
- `token.deleteMany { tokenIds }`: 1 to 100, DM only. Each goes through `token.delete`'s reducer, initiative rows and attached areas included.
- `actor.effects { add?: {target, effect}[], remove?: {target, effectId}[] }`: up to 100 of each. Each item is checked as its single op would be (`actor.effect.add` or `remove`), the hidden effect rules included.

Each applies whole or not at all, as `actor.damageMany` does, and its inverse is one undo step ("Undid changing 6 tokens.", "Undid adding Frightened to 4 creatures.", which `undoLabels.ts`'s tally names). A selection over 100 sends batches under one undo group, as group moves do.

**Optimistic replay.** A DM's many-op on tokens in view replays at once, since its reads are the tokens. A player's waits when any target is redacted, by the existing rule.

**Adjacent fix.** The group HP entry (`HpSection.tsx`) sends one `actor.hp` per creature with no undo group, so one entry for six creatures takes six undos. It moves to `dispatchGesture`, so it is one step.

**Tests.** Each many-op whole or refused whole, a player's owner fields only on owned tokens, effects with hidden ones refused as `gone` for owners, the inverses, the tally phrases, the bar's offers by access, and the HP entry's one undo group.

### 3.6 Full stat blocks

The request: "Full stat blocks."

**Reading.** Features 15 says each token has "a light stat card", "not a full character sheet", and that "The DM can read the full stat block" in the monster compendium. Today that block is reachable only from the Monsters panel: a monster's token keeps its SRD id but nothing opens the block from it, and a token placed from one of the room's own monsters keeps no link at all. So wave 5 puts the full 2024 stat block on the token: abilities with saves, skills, senses, languages, CR, traits, actions, bonus actions, reactions and legendary actions, read where the token is. Player characters keep their D&D Beyond link (features 19 skips a character sheet builder). Question 1 asks the project owner to confirm this reading.

**Behavior.**

- The token panel of a monster or NPC gains "Stat block" for the DM, folded on a phone. It renders the block as the Monsters panel does: an SRD monster's Markdown from `loadMonsters()` by `actor.srdId`, or a room monster's through `monsterView` and `statBlockMarkdown` by `actor.monsterId`. The token's own HP, AC, speeds and conditions stay in the sections above it, since the token is an independent copy that may have changed since it was placed.
- Under the block: Edit (a room monster, which opens the editor) or "Copy to this room's monsters and edit" (an SRD one), and Detach.
- A token with neither link offers "Attach a stat block", which opens the monster browser to pick one, and suggests the room monster or SRD monster of exactly its name. Attaching sets only the link, never the token's numbers.
- A tracker row's options gain "Stat block", which opens the token panel there.
- A token's owner who plays a monster from the SRD, such as a druid's Wild Shape, sees its block too: the SRD is openly licensed and the owner already receives `srdId`. The SRD chunk loads on that device only then. A room monster's block never reaches a player, since it may be text from a book the group owns.
- The block is read only on the token, and nothing in it rolls.

**Model.** `Actor.monsterId?: MonsterId`, set by `monsterToken` when a token is placed from a room monster (the monster browser, the Add token tool and the encounter builder, which today carry the id in the pending placement and drop it). A link to a monster deleted since reads "This token's stat block was deleted from this room."

**Ops and permissions.** `actorPatch` gains `monsterId` (nullable), which is not an owner field, so only the DM sets it.

**Projection.** `monsterId` is DM only in every projection, owners included, like `dmNotes`.

**Export and import.** The import remaps `monsterId` and drops it when its monster did not come through.

**Tests.** The link set on placing from each path, the projection dropping `monsterId` for owners, attach and detach as DM-only patches, the import remap, and an owner reading the SRD block of their own token.

### 3.7 Journal pages

The request: "Journal pages in Markdown: DM-only, shared with all, or private to one player. Secret blocks the DM can reveal."

**Why blocks.** A secret written into one Markdown text, such as a `:::secret` fence, would leave the projection to parse Markdown to cut it out, and any disagreement between that parser and the renderer (a fence inside a code span, one never closed) leaks the secret to players. So a page is a list of blocks, and a secret is a block with a flag. The projection drops whole blocks and never reads their text.

**DM behavior.** A Journal panel (all roles, a bottom sheet on a phone, a side panel tab from 900 px up):

- Pages sit in folders, as scenes do, sorted by title. New page, and a page's Edit, open the editor: full screen on a phone, a dialog from 600 px up.
- The editor has the title, the folder, "Who can read it" (DM only, Everyone, or one player picked from the roster), and the blocks. Each block is a text area with a Secret switch, move up and down, and delete. "Add text" and "Add a secret" add blocks. The whole page is one draft, and Save sends one op, as the monster editor and the encounter builder do. Leaving with unsaved changes asks once.
- Reading a page renders its blocks. A secret block shows a dashed edge and "Players don't see this" with Reveal, or "Revealed" with Hide. Reveal and Hide are their own op, and a saved edit never changes what is revealed (below), so a draft opened before a reveal cannot hide the block again when it is saved.
- "Pin to the map" (section 3.8) closes the panel's sheet on a phone (`PanelProps.close()`), shows "Tap the map to place the pin" with Cancel, and places a pin linked to the page at the next tap. The pin starts with DM only off, and the page decides who sees it (section 3.8): a pin from a page private to Thorn shows to Thorn, and one from a DM-only page shows to nobody until the page is shared.
- A page private to a player tells the DM so in its header ("Thorn and the DM").

**Player behavior.** The Journal panel lists the pages they may read, and a page renders its blocks with revealed secrets among them, unmarked, as ordinary text. When a page they can read changes (a new page shared, a secret revealed), the panel's button shows a dot, as unread chat does, tracked per device from a hash of the projected page (`rvtt.journalSeen.<room>.<member>`). Players do not write pages: "DM-only, shared with all, or private to one player" are the DM's choices of reader. Question 3 asks whether players should keep pages of their own.

**Markdown.** The renderer in `client/components/markdown.ts` reads the SRD's subset (headings, paragraphs, lists, tables, bold, italic) and returns a tree, never HTML. The journal adds, behind an option the stat blocks do not set: single line breaks kept as breaks, numbered lists, quotes (`> `), a `#` heading, and links `[text](https://…)`, https only, opened with `rel="noopener noreferrer"`. Anything else stays text. No images: handouts already show pictures.

**Model.**

```ts
type JournalPageId = string
type JournalPage = { id, rev, title: string, folder?: string,
  access: 'dm' | 'all' | { member: MemberId },
  blocks: JournalBlock[] }                       // at most 100
type JournalBlock = { id: string,                 // 12 random characters, unique in the page
  text: string,                                   // Markdown, at most 4,000 characters
  secret?: { revealed: boolean } }
```

**Ops.** All DM only.

- `journal.create { page }`.
- `journal.update { pageId, patch: { title?, folder?, access?, blocks? } }`. `blocks` is the whole list when any block changed, checked under 32 KiB serialized with the rest of the op (a protocol refine, as `build.walls` bounds its bytes). In the op a block says only whether it is secret (`secret: true`), never whether it is revealed: the reducer keeps each block's revealed state from the stored block of the same id, and a new secret block starts hidden. So only `journal.reveal` reveals or hides.
- `journal.reveal { pageId, blockId, revealed }`.
- `journal.delete { pageId }`, which in the same op makes every pin linked to the page DM only and unlinks it. A pin can be public and still withheld because players could not read its page (section 3.8), so merely unlinking it would publish its place and label. So a page's deletion never widens who sees its pins, and a pin never names a deleted page. One undo puts the page and its pins back as they were.

**Projection.** The DM gets every page. A player, outside a blackout, gets a page whose access is `'all'` or names them, with every secret block that is not revealed dropped, the `secret` flag of revealed ones dropped too, and `rev` sent as 0. So an edit inside a block they cannot see sends them nothing, and the order of what remains shows no gap. Changing a page's access re-projects it and its pins (`dependents`). Member removal turns a page private to that member into a DM-only one.

**Undo.** Every journal op restores the whole page under its value guard, so a reveal undoes as hiding the block again while the page is as the reveal left it, and is refused once the page was edited since, as any step is.

**Limits.** 200 pages, 100 blocks a page, 4,000 characters a block, 32 KiB a page and 1 MiB in all (section 2.4). Names follow the name rules, block text the notes rules (line breaks and tabs kept, other control characters refused).

**Export and import.** Pages travel with new IDs, a player's access follows their new member ID (section 2.5).

**Performance.** Pages are room-level, so they ride in DM snapshots and in the snapshots of players who may read them. The 1 MiB cap and the size guard bound that. A page renders only when opened.

**Tests.** The projection never holds a DM-only page, a page private to another player, an unrevealed secret block or a revealed block's flag, and a hidden block's edit sends players nothing (the fan-out invariant with pages in the random states). Reveal and hide, page deletion making its pins DM only and its undo restoring both, member removal, the byte refine at the frame limit, the renderer's additions (an `http:` link stays text), and the unread dot.

### 3.8 Map pins

The request: "Map pins linked to notes."

**Behavior.**

- The DM places pins with a new tool, Pin (DM only, between Ping and Fog), or with a journal page's "Pin to the map" (section 3.7). A tap places one and opens its pane, the label pane's pattern (a bottom sheet on a phone): label, linked page (or none), color, "DM only", and Delete on a second tap, with a line that says who will see the pin ("Players who can read Old Map: Thorn", "Every player", "Only the DM"). A drag moves a pin.
- An edit in the pane that drops the link to a page, or changes it to another page, when the old page is DM only or private to a player, turns DM only on in the same save, so the pin never reaches more people than before without the DM's say. The DM can turn DM only off again before saving, and the line says who will see it then.
- Every pin draws as a marker of fixed screen size (28 px tall, a 44 px tap target) in its color, with its label under it once the map is zoomed in enough to read it. It draws in the decoration pass above the fog, since a pin that reaches a player is not under the fog.
- With the Select tool, a tap on a pin opens its linked page in the Journal panel, or shows its label in a small popover when it links none. That works for everyone, and on the display it does nothing.

**Model.**

```ts
type PinId = string
type Pin = { id, rev, sceneId, x, y,   // cells
  label?: string,                       // single line, at most 80
  pageId?: JournalPageId,
  color: string,
  visibility: 'all' | 'dm' }
```

**Ops.** `pin.put { pin }` (create, or replace a pin of the same id on the same scene, as `build.stamps` puts) and `pin.remove { pinId }`, DM only. A scene's deletion takes its pins, and a duplicate copies them with derived IDs, as it copies labels (design.md 14.10).

**Projection.** The labels' rule plus two: a player gets a pin on the player scene that is not DM only, is not on a fully fogged cell (the merged fog on a vision scene, as for labels), and whose linked page, if any, they may read. A pin linked to a DM-only page is DM only, so players never learn that a note exists there. A pin depends on the fog as a label does. The DM's fog changes are global. On a vision scene, exploration re-projects only what stands on the tiles it changed (`tileDependents` in `shared/project.ts`, which lists the tokens, labels and stamps there), so pins join that list beside labels and stamps. On the TV, pins linked to pages shared with all draw as they do for any player.

**Undo, limits, export.** DM stack with value guards. 200 pins a scene. The import remaps the page and the scene.

**Tests.** The projection under fog, DM only, an unreadable page, a page made readable later, a page deleted (its pins become DM only, and an undo puts both back), a pin from "Pin to the map" starting visible and gated by its page, the pane turning DM only on when a restricted page's link is dropped or changed and leaving it off when the DM turns it off in the same save, a pin reaching players through exploration with no global change and no reconnect, duplicate, and the tap opening the page.

### 3.9 A per-player drawing permission

The request: "A per-player drawing permission."

**Behavior.** Room settings, Players, gain "Who can draw", with the same control as "Who can move any token": No one, Every player (the default), or the players picked. A player who may not draw has no Draw tool. One who loses it while drawing sees the tool close with "The DM turned off drawing for you." Their drawings stay, and they may still erase or clear their own.

Kept rulers are drawings in the model (kind `ruler`), but they are measurements made with the ruler tool, so they stay allowed (question 6). Pings and the laser are not drawings and stay.

**Model.** `RoomSettings.playersDraw?: 'none' | 'all' | MemberId[]`, absent reading as `'all'`, so every existing room keeps letting everyone draw.

**Permissions.** A player's `drawing.create` of any kind but `ruler` needs `playersDraw` to allow them, or answers `forbidden` with "The DM has not let you draw." `drawing.delete` and `drawing.clear` of their own drawings are unchanged. A player's undo or redo that would put a drawing back needs the permission too (section 2.6), so a player who lost it cannot redo a drawing onto the map. Member removal drops the member from the list, and the import remaps it, as for `playersMoveAny`.

**Undo and replay.** The setting is a `room.update`. It is a permission rule, so stored drawings replay as they were made (section 2.3).

**Tests.** Every answer of the setting for each drawing kind, rulers allowed, erasing own drawings allowed without the permission, an undo of a player's erase refused once the permission is gone, the tool shown by the client's mirror of the rule, and the stored-state schema's default.

### 3.10 Session log export

The request: "Session log export."

**What a session is.** The log keeps no sessions, and a group usually plays one evening at a time, so a session is a run of log lines with no gap over 4 hours between two of them. No new data is needed.

**Behavior.** The Log panel has controls but no menu today, so it gains an "Export" button, for everyone. A sheet lists the sessions the viewer's log holds, newest first ("Tuesday, October 14, 7:02 PM to 10:48 PM, 412 lines"), and "Everything". Export saves a Markdown file named like `crypt-crawlers-log-2026-10-14.md`, through the share sheet on an iPhone and a download elsewhere (the map export's `save.ts`). It shows "Preparing the log…" while the server works. Each line reads as the Log panel reads it, with the device's local time:

```
# Crypt Crawlers: log of October 14, 2026

- 7:42 PM **Thorn**: Is the door locked?
- 7:43 PM Goblin 2 takes 7 damage (3/7 left).
```

**Why on the server.** The room keeps every line it archives (docs/design-v1-log-history.md 3.1), and the client reads older pages 50 at a time and holds at most 500 rows, so a client-built export would take a page request for every 50 lines. Its names would also be thin: the DM's view holds the tokens of one scene only, so lines about creatures on other scenes would read "A creature". So the server renders the export.

**Project first, then count.** Sessions found from the raw `room_log` would tell a player when hidden things happened: a session made only of whispers between others or a hidden monster's HP lines, a line count that includes them, or two evenings joined by hidden lines between them. The live-play fix to older log pages (`openvtt-lp3int/server/http/log.ts`) closed the same channel for paging. So the server first projects every stored row for the caller, in bounded batches against one captured state, then finds sessions, times and counts among what remains (docs/design-v1-log-history.md 2 and 4):

- A player's rows are projected as `GET /log` projects them (`projectArchivedLog` against one captured committed state), so a player's listing and file hold only what their Log panel shows: never a whisper to someone else, never a line about a creature they could not see.
- A DM's rows keep every line but whispers the DM is not party to. Live entries and pages remain all-scenes, but the client holds tokens from one scene, so names for creatures on other scenes can be missing. The server renders the file with names from the whole captured room state, every scene's tokens included. A DM's file marks the lines the Log panel marks as hidden from players.
- The session list is folded once per room state, member and role and kept as summaries only, never the lines, and the file streams in a second pass. The role is part of the key because one member can hold a DM grant on one device and a player grant on another (`server/http/dm.ts` keeps the player grants), and a DM's rows must never reach that member's player device.

**Routes.**

- `GET /api/rooms/:id/log/sessions?before=&limit=` (any grant) answers the caller's sessions, newest first, 25 a page by default, each with its first and last line ids, with `lines`, the whole readable log's count, and `nextSessionsBefore`, the oldest session's first id when there are more.
- `GET /api/rooms/:id/log/export?fromId=&toId=&tz=` (any grant) streams the file for one session, by its first and last ids, both inclusive, or for all with neither. The older `from` and `to` times still filter for older clients, never with ids. A file that fails after its first chunk ends without its last, so it never saves cut short. The sheet reads at most 8 MiB of it, and past that offers Download, the browser's own download of the same export. It renders with the text functions of the Log panel, which move from `client/features/log/format.ts` to `shared/logText.ts` so both use one wording. `tz` is the device's IANA time zone, at most 64 characters, accepted when `new Intl.DateTimeFormat('en-US', { timeZone: tz })` constructs without a `RangeError`, so `UTC`, which `Intl.supportedValuesOf('timeZone')` does not list, works.
- Limits (section 2.4): every listing and every export request counts against one limit of 10 an hour per member per room, cached or not, with one export at a time per room and a loose per-address cap. A cache hit costs the same as a miss, since the cache key moves with the room seq, which hidden ops move too: if only misses were charged, a player could count hidden activity by when they ran out.

**Model, ops.** None.

**Tests.** Sessions split at 4 hours. Adding hidden rows (whispers between others, a hidden creature's lines, rows between two of a player's sessions) changes neither a player's listing nor their file. A player's file equals their projected pages' text. The DM's names across scenes, one member holding a DM grant and a player grant asking in either order and each getting only their own rows, the same answers and the same remaining limit with and without hidden ops between requests, every event kind's text the same in the panel and the file, `UTC` and a named zone accepted and a bad one refused, the cache, and the shared limit.

### 3.11 Anonymous safety card (X-card)

The request: "Anonymous safety card (X-card)."

**What it is.** The X-Card is John Stavropoulos's safety tool: "a card with an X on it that participants in a Simulation or Role-Playing Game can use to edit out anything that makes them uncomfortable with no explanations needed." Its text is CC BY-SA 3.0 and asks to "credit John Stavropoulos and link here: http://tinyurl.com/x-card-rpg". The app writes its own words and credits the card on the About page and in `CREDITS.md`.

**Behavior.**

- Everyone in the room, DM or player, has "X-card" at the top of the Menu panel. One tap opens a small card: "Tap the X to ask the table to edit out what just happened. Nobody will know who tapped it." A tap on the large X sends it. The step stops a stray tap from sending one.
- Every device in the room then shows the same card, the sender's included, so nobody can tell from a screen: a calm full-width card, "Someone tapped the X-card. Edit out what just happened, with no questions asked." with Dismiss. The DM's card adds "Pause the game", which turns on the blackout. It shows on players behind a blackout too, and on table displays.
- Nothing covers the card. On a member's device a handout the DM shows while the card is up, or one that comes back when a pause ends, waits until the card is dismissed, and a handout already open stays under the card (`popupShows` in `client/features/handouts/handouts.ts`). A table display draws the handout under the card, which stays on top, and its first tap closes the card.
- Taps within 10 s of one in the same room show the card once.
- The sender's device alone shows "Sending…" on the X while the request is out, so the tap never looks lost. On failure it says so there: "Not sent: no connection. Try again." when the request did not get through, or "Not sent. Try again in a moment." for a 429. A merged tap is a success, since the card is showing. The card itself, which everyone sees, carries no sign of who sent it.

**Why not an op or an ephemeral event.** Ops are stored in `room_ops` with the member who sent them, and the reducer and the log see the sender. An ephemeral event carries `from` and reaches only one scene. So the X-card has its own route and its own message.

- `POST /api/rooms/:id/xcard` (any grant, CSRF rule, no body). A display session is refused there, as on every ordinary route (section 3.1). The route authenticates with `SessionStore.lookup` and the grant check alone. The usual `session()` path writes the session's `last_seen_at` at most every ten minutes and slides its cookie's expiry, which would leave a timestamp tied to the sender, so this route never touches the session row and sends no cookie. It sets Fastify's per-route `logLevel: 'silent'`, so the server writes no request line for it. The limits are in memory and never written (not `rate_events`): one card per room per 10 s and 6 taps an hour per session. Over the session's limit it answers 429 with nothing else.
- The actor sends `{t: 'xcard', at}` to every socket of the room: DMs on any scene, players and displays. The message names no one.
- Nothing is stored: no op, no log line, no rate row, no session timestamp.

**What it does not hide.** The app keeps the tap anonymous from everyone at the table, the DM included. A tunnel or proxy in front of the server, such as Cloudflare's, may log every request with its address, in the server owner's account. The server's memory also sees the session while it handles the tap. Section 7 says so too.

**Tests.** The route needs a grant and the CSRF rule, refuses a display, reaches every socket on every scene and behind a blackout, the message holds no member, session or address, nothing is written to `room_ops`, `room_log`, `rate_events` or `sessions` (no `last_seen_at` or expiry change even for a session last seen long ago), no `Set-Cookie` is sent, no request log line is written (a captured logger), the merge and the per-session limit, the sender's "Sending…" and both failure messages, and the About page credit.

### 3.12 Instant generic tokens from game-icons.net

The request: "Instant generic tokens from about 4,000 game-icons.net fantasy icons (CC BY 3.0). Works offline."

**The source.** The `game-icons/icons` repository at commit `82d948812bfe3f269ef8f731dcdb07b08160edc4` (2026-04-23), which `shared/credits.ts` already pins for the condition and status icons and which is the newest. It holds 4,180 icons by 36 authors in `<author>/<name>.svg`. 4,055 of them, by 33 authors, are CC BY 3.0. 125 are CC0: Viscious Speed's 121 abstract shapes, 2 by Zeromancer and 2 by "Various artists" (section 10). The site asks for "a mention like "Icons made by {author;}. Available on https://game-icons.net"". The set is general game art, not only fantasy (it has science fiction and modern icons). The app ships all 4,180 and lets the search find what a table wants (question 11).

**What "instant" and "works offline" mean here.** "Works offline" is read as: the icons need no outside service. Picking one is one op, with no upload, no image processing, no search quota, and nothing fetched from anywhere but the app's own server. So it works when SerpApi's month is spent, when the egress is down, and at the start of a session when every phone uploads at once and the image queue is full. A device that has lost its connection can still pick one. The icon index loads with the panels the room preloads in the background once connected (design.md 14.1), so the Icons tab searches offline, a pick queues its op like any offline edit, and the token draws its initials on the disk until the icon's file arrives. While offline, tiles of icons the device has never fetched show their names instead of their art. Every icon's art offline would take a service worker, which design.md 14.5 keeps out, or a download of every glyph on every phone: 2.8 MB compressed (all 4,180 paths in one JSON file, 6.6 MB uncompressed, 2.8 MB with gzip at level 9, measured by a research agent at the pinned commit). Question 15 asks the project owner whether this is what "works offline" means.

**The build script.** `node scripts/game-icons.ts`, like `scripts/icons.ts` and `scripts/stamps.ts`, never hand-made images:

- It fetches the repository at the pinned commit with git into a scratch folder and checks the commit's tree hash against the one pinned in the script, so every file is exactly the one reviewed. (GitHub's archive downloads have no stable checksum.)
- It checks each file against the upstream shape the existing script already checks (`GAME_ICON_SHAPE`), drops the black background square, and writes `public/game-icons/<commit8>/<author>/<name>.svg` as one path with an explicit size, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="…"/></svg>`. The first 8 characters of the commit are in the path, so a later pin changes every URL and a cached old file is never served under a new one. The folder is served with `Cache-Control: public, max-age=31536000, immutable`.
- It writes `public/game-icons/<commit8>/index.json`: the commit, each author's name, link and license, and each icon as its author and name. A title comes from the name ("wolf-head" reads "Wolf head").
- The license of each author comes from the repository's `license.txt`, which marks Viscious Speed and Zeromancer CC0, and the script's own table adds "Various artists", whose two icon pages say CC0. The script fails when an author folder appears that neither names.

The files are committed, as the stamps are: about 6.6 MB of SVG text, so the repository and the Docker image grow by about 7 MB. A device fetches only what it shows: about 1.4 KB per icon at the median.

**Search.** The repository has no tags or titles. The site's tags come from an undocumented search service with no license stated, so the app does not copy them. The picker searches the words of the names and the author ("goblin", "dragon head", "skull lorc"), over the index, which is about 130 KB before compression and loads with the room's background panel loads (above).

**Keys.** `IconKey` is `<author>/<name>`, checked by `/^[a-z0-9-]{1,40}\/[a-z0-9-]{1,60}$/`. The author is part of the key because 47 names exist under two authors (`bat`, `castle`). A key the client does not know draws as initials on the disk, as a stamp key it does not know draws as a dashed box, so a renamed icon never breaks a token.

**Model.** `ImageRef` becomes `{ assetId, crop } | { icon: IconKey, color: string }`. The icon variant is valid wherever a token image is: a token's image and its other images, a character's portrait, a room monster's and an SRD monster's default image. `color` is the disk's, one of 14 swatches (the 10 member colors and four neutrals). The glyph is white or near-black, whichever contrasts more with the disk, computed and never stored.

**Picker.** The image picker gains an Icons tab, first and always available: the search field, a windowed grid of 56 px tiles that load lazily, the 14 colors, a preview on a token disk, and under it the icon's title, author and license ("Wolf head by Lorc, CC BY 3.0"). Use applies it, as the other tabs do.

**Drawing.** On the canvas, the client fetches each icon's file once, reads its one path, and draws a Konva `Path` scaled from 512 to the token: a disk in the color and the glyph on it, clipped as images are (a circle, or a square for an object). It is vector, so it stays sharp at any zoom, where the condition chips' 64 px rasters would blur on a large token. In HTML (picker tiles, the tracker, the initiative strip, the token panel), the glyph is a CSS mask over a box of its color on the disk, as `EffectIcon.tsx` draws condition icons. The CSP needs no change: the files are same-origin.

**Permissions and projection.** An icon image passes no asset check, since it names no asset, only a valid key. A player making their own character, which today needs "a portrait they uploaded", may also pick an icon, which is shipped art. `visibleAssetIds` skips icons. The projection carries a token's image as it is.

**Every reader of `ImageRef`.** The union touches every place that reads `assetId` from a token, character or monster image (about 30 client files, the reducer, permissions, projection, the stored-state schema and the import remap). TypeScript names each one. Comparisons such as `sameImage` (other images, monster images) compare an icon by key and color.

**Credits.** design.md 20 lists every file in `CREDITS.md`, and 4,180 rows would bury it. So for this set `CREDITS.md` names the source, the commit, the change made ("Black background square removed."), and every author with their license, icon count and link, and points to the generated index as the list of every file with its author and license. The About page gains a "Token icons" group: "Icons made by Lorc, Delapouite and 34 others. Available on https://game-icons.net.", the license links, and the authors with their counts. The picker credits each icon where it is chosen. The credits tests check that every shipped icon has an index entry with an author and a license, that every author in the index appears in `CREDITS.md` and `shared/credits.ts`, and that exactly the three CC0 authors are marked CC0. The existing test that `public/icons/` holds only condition and status icons is untouched, since the new set lives in `public/game-icons/`.

**Tests.** The key regex and duplicate names, the union through the protocol, permissions (no asset check, a bad key refused), projection and import, the index built from a small fixture tree, the contrast choice, the search, an offline pick queued and drawn as initials until its file arrives, and every `ImageRef` reader drawing both variants (a token, a portrait, a row).

### 3.13 Openverse as a second image search

The request: "Openverse as a free second search source when the monthly SerpApi limit is used up."

**The service** (section 10). `GET https://api.openverse.org/v1/images/` searches openly licensed images. Anonymous use is allowed, with 20 requests a minute and 200 a day per client address, and at most 20 results a page. A registered client whose email is verified gets 100 a minute, 10,000 a day and 50 a page. Results carry a ready-made `attribution`, the license, the creator, the source page, the original's URL (Flickr, Wikimedia and others) and a thumbnail served by Openverse itself (`/v1/images/<id>/thumb/`). Its terms ask for attribution, say Openverse does not verify licenses and the user must, and require an app to "prominently indicate that it was made using Openverse but is not endorsed or certified by Openverse".

**When it is used.** The search route tries SerpApi first, as today. It turns to Openverse when SerpApi cannot answer: no `SERPAPI_KEY`, the account's monthly searches under the floor of 10, this hour's 45 reached, or this room's or this address's SerpApi quota spent. So search now works on a server without a SerpApi key. The picker can also search Openverse on purpose ("Search Openverse instead" under Google's results), since a DM may want openly licensed art.

**Server** (`server/assets/openverse.ts`, beside `serpapi.ts`):

- It calls `…/v1/images/?q=<q>&page_size=<20 or 40>&license_type=modification&mature=false&extension=jpg,png,webp,gif` through the strict egress port. `license_type=modification` leaves out no-derivatives licenses, since cropping an image into a token adapts it (question 5). `mature=false` is Openverse's default, kept explicit. The extensions leave out SVG originals, which the import refuses anyway.
- Anonymous by default. With `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET` set (a registration the server owner makes once, its email verified), it gets a token from `/v1/auth_tokens/token/` through the strict port, keeps it until 5 minutes before it expires, and asks for 40 results.
- Quotas (section 2.4): a server-wide daily and per-minute budget under Openverse's own, kept in `search_usage` (`ov:site:<day>`) and in memory, plus 20 a day per member per room and 60 a day per room, with a loose per-address flood cap, since the table shares one address (section 2.4). A 429 from Openverse answers `quota_global`: "Openverse is busy. Try again in a minute." A search reserves its counts before calling, as SerpApi's does.
- Results are cached for 7 days under `openverse:<q>`, apart from SerpApi's, and searches in flight are shared by the same key. Each keeps `thumbnail`, which must be exactly `https://api.openverse.org/v1/images/<uuid>/thumb/`, `original` (https only), `title`, `source`, and `credit`: `{ creator?, license, licenseVersion?, landingUrl, attribution }`, the attribution at most 400 characters.
- Squid's strict port gains `api.openverse.org` (`docker/squid.conf`, the README and the comment in `server/assets/egress.ts`).

**Thumbnails.** As decision 6 loads Google's thumbnails from their host, the browser loads Openverse's from `api.openverse.org`. The CSP's `img-src` gains `https://api.openverse.org/v1/images/`, a path. A browser checks a source's path only on the request the page makes: after a redirect it checks the scheme, host and port alone (CSP3's "Paths and Redirects"), so the path narrows what the page may ask for and not where a redirect may lead on that host. Openverse served its thumbnails with no redirect when checked. The server's rule is the real check: `shared/searchThumbnails.ts` becomes a host and path rule per source, since a host alone would admit any path, and a result whose thumbnail fails it is dropped. A thumbnail that fails to load shows a plain tile reading "Openverse could not show this preview", never a broken image. Thumbnails count against each viewer's own address at Openverse (1,000 a day), never the server's.

**Import and credit.** Picking a result calls the existing import with the original and the thumbnail as the fallback. The fallback rule is unchanged: it must be a thumbnail URL from a cached result, fetched through the public port. The server then looks up the cached Openverse result whose original or thumbnail it fetched, and stores that result's credit on the new asset row, never a credit the client sends, with the image's original width and height as fetched. `assets` gains `credit jsonb` (null for every other image), and the stored size is the row's own. The library and the token panel's image section show it, linked to its page with `rel="noopener noreferrer"`, to everyone who may see the image, followed by what was changed, as Creative Commons licenses ask of an adaptation (CC BY 4.0 section 3, and the credit for adaptations in the 2.0 and 3.0 licenses): "Goblins and a Troll by Dunechaser, CC BY-NC-SA 2.0. Resized and converted to WebP." Every import is re-encoded, so "Converted to WebP" is always said. "Resized" is said only when the stored size differs from the original's, since the pipeline never enlarges (`withoutEnlargement`) and a small image keeps its size. The token panel adds "Cropped." only where the token's crop shows less than the whole image, so the credit names only changes actually made. The export carries it in `assets.json`, and the import keeps it after checking it as bounded text.

**The picker.** Openverse results say so: "From Openverse: openly licensed photos and artwork. RaccoonVTT is not endorsed by Openverse." Each tile's title names its license. The search tab now shows whenever either source can search.

**Adjacent fix.** The client's `SearchResult` type requires `original_width` and `original_height`, which the server sends only when present. They become optional.

**Tests.** The order of fallback (no key, account under the floor, hour cap, room and address quotas), the separate cache keys, the budgets, a 429, the token's refresh, the thumbnail rule by host and path, the CSP string, a credit stored from the cache and never from the request body, the changes line (resized only when the stored size differs from the original's, cropped only when the crop is not the whole image), the credit in the listing, the export and the import, and the strict port's host list.

### 3.14 Keyboard shortcuts

The request: "Keyboard shortcuts on desktop, beyond undo and redo (section 13)."

**Today.** Ctrl or Cmd with Z and Shift with Z, Escape, and Space to pan are the only keys, each handled on its own, with three different tests for "typing in a field".

**Behavior.** On any device with a keyboard. A shortcut never fires while focus is in a field (one shared test, `isTextField`, which now counts a select box too), while a modal dialog is open (Escape excepted, as now), while "View as a player" is open, or with Ctrl, Cmd or Alt held, so the browser's own shortcuts stay. Letters match as undo already does (`client/state/shortcuts.ts`): by `key` when it is a Latin letter, and by `code` only otherwise, so a French or German layout's letters work where they are printed and a Cyrillic or Greek layout still reaches them. Symbols (`/`, `?`, `+`, `-`, `0`) match by `key` alone, with Shift allowed, since their physical keys differ between layouts and `?` takes Shift on most of them. A held key does not repeat.

| Key | Does | Who |
| --- | --- | --- |
| V, R, A, D, P | Select, Ruler, Area, Draw, Ping | everyone (Draw only for players who may draw) |
| T, M, F, B, G | Add token, Pin, Fog, Builder, Grid | DM |
| Arrow keys | move the selected tokens one square, one move op per press | anyone, on tokens they may move |
| Page Up, Page Down | raise or lower the selected tokens 5 ft | as the action bar's buttons |
| H, L | hide or show, lock or unlock the selected tokens | DM |
| Delete, Backspace | delete the selected tokens, with a toast "Deleted 3 tokens. Ctrl+Z brings them back." | DM |
| N | next turn for the DM, End turn for a player on their own turn | as the tracker's buttons |
| + and -, 0 | zoom in and out around the center, Fit map | everyone |
| / | open the outliner with its search focused | DM |
| ? | the shortcut sheet | everyone |

An arrow press is a drop, so on a creature's turn each press adds a leg to its path, and walls stop it as they stop a drag (wave 4). The shortcut sheet lists the keys for the viewer's role and is also under Menu, This device.

**Code.** One registry, in `client/state/shortcuts.ts`, which already holds the undo keys (a second file of the same name elsewhere would only confuse): a table of key, roles, condition and action, and one window listener mounted by the room. Undo and redo move into it. While "View as a player" is open the registry ignores every key but Escape, Ctrl+Z included: today the preview mounts a second room and Ctrl+Z there undoes the DM's real last change, which this fixes.

**Tests.** The key table as pure functions, as `undoShortcut` is tested: fields, dialogs, the preview, modifiers, repeats and roles, with AZERTY and Cyrillic layouts for the letters and `?` and `+` typed with Shift for the symbols.

**Keys and key combinations (2026-10-16).** At the project owner's request the sheet, now "Shortcuts" (Menu, This device: "Show the shortcuts"), lists keys and key-plus-pointer combinations only, never a plain click, tap, drag or pinch, which FEATURES.md describes with each feature. Its sections: Keys (the table above, then Escape), "Mouse with keys" where `(any-pointer: fine)` matches (Shift or Ctrl with a click or a drag, Cmd on a Mac, a right-click, a right or middle button drag, Space and a drag, Ctrl and the wheel), Android where Back is the phone's own button, then the keys that work inside one surface, such as Side panel tabs, Handout viewer, Initiative and Dialogs. Each row gives what you do, what it does and any condition beyond the role ("with the Select tool"), from `BEHAVIORS`, a second registry beside the keys that also holds each row's roles and device. The sections are headings, not landmarks. FEATURES.md mirrors both registries, and a unit test fails when they drift. The sweep found that Ctrl and a click did not add to a selection on Windows and Linux. It now does, and Ctrl with a drag on empty map draws the box as Shift does. On a Mac Ctrl with a click is a right click, so Cmd stays the key there.

### 3.15 Low-power mode

The request: "Low-power mode that renders at a lower resolution."

**Behavior.** Menu, This device, "Low power", off by default, with the hint "Draws the map at a lower resolution and skips small animations, to save battery on long sessions." It:

- draws the canvas at 1 device pixel per CSS pixel instead of up to 2 (`Konva.pixelRatio`), a quarter of the pixels on most phones,
- loads the phone size map on every device,
- shows a remote drag at each frame it receives, without easing between them,
- draws a ping as a single ring for its 3 s without the pulse, and the laser without its fade,
- sends its own drag and ruler frames at most 15 a second instead of 30.

Konva reads its pixel ratio when a layer's canvas is made, so switching remounts the stage under the scene loading notice. Text on the map looks softer, and the setting says so.

**Model, ops, server.** None.

**Tests.** The setting's store, the pixel ratio and map size it picks, and the stage remounting on a change.

### 3.16 UI scale

The request: "UI scale setting."

**Behavior.** Menu, This device, "Interface size": 85%, 100% (the default), 115% or 130%. It scales the bars, the toolbar, panels, sheets, dialogs, toasts, the token action bar and the label pane, and the text and marks drawn on the board (names, chips, badges and pills, though not a token's ring), on top of the size they take from the map's zoom (docs/design.md 14.2, which replaced the fixed size on screen they kept when this was written). The map does not scale: pinch and the wheel do that.

**How.** Every size in the client is an inline pixel number (about 580 spacing calls and 330 font sizes), so a rem-based scale would mean rewriting every style. Instead each piece of chrome gets the CSS `zoom` property, never the stage, so pointer math on the canvas (a client position minus the canvas's rectangle) stays in unscaled pixels. Four things follow, and the build handles each:

- Layout decisions read the window's width divided by the scale, so a 1,000 px window at 130% lays out as 769 px wide, the phone layout. The 900 px and 600 px checks move into one hook that does this.
- The insets the stage keeps clear of the bars are measured with `getBoundingClientRect`, which reports the scaled size, rather than a ResizeObserver's unscaled one.
- The action bar and the label pane sit at a token's screen position, so their position is divided by the scale.
- Inputs keep a drawn size of at least 16 px at 85%, since iOS zooms the page into a smaller field.

`zoom` is in every major browser (Safari and Chrome for years, Firefox since version 126). Section 10 lists what was not checked on devices.

**Tests.** The width hook, the inset measurement and the action bar position at each scale, and Playwright screenshots at 85% and 130% in Chromium and WebKit, saved under the screenshots folder.

### 3.17 Scheduled database backups

The request: "Scheduled automatic database backups."

**Today.** README's Backups section gives two manual commands, a custom-format `pg_dump` and a tar of the image volume, to run and copy off the server by hand, database first ("an image saved without its database row is harmless, but a row whose image is missing shows a broken picture"). Nothing runs them. design.md 16.4 planned "A nightly `pg_dump` plus asset volume copy" as a compose service.

**The service.** `docker-compose.server.yml` gains `backup`:

- The image is the postgres service's own, `postgres:17-alpine` pinned by the same digest, so `pg_dump` matches the server's version exactly (17.11 in the pinned image, checked on 2026-10-14).
- It runs `sh /backup/backup.sh`, a script bind-mounted read-only from `docker/backup.sh`, as `egress` mounts `squid.conf`.
- Network `raccoon-data` only: it reaches Postgres and nothing else, and has no route out.
- Volumes: a new `raccoon-backups` at `/backups`, and `raccoon-assets` at `/assets`, read-only.
- Environment: `PGHOST=postgres`, `PGUSER=raccoon`, `PGDATABASE=raccoon`, `PGPASSWORD=${POSTGRES_PASSWORD:?}`, `BACKUP_AT=${BACKUP_AT:-04:00}` and `TZ=${TZ:-UTC}`. Never `ROOM_SECRET_KEY`.
- Like every container: `read_only`, a small `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`, `restart: unless-stopped`, 0.5 CPU, 256 MB and 64 pids, the `local` log driver, and `depends_on` Postgres healthy.

**Its user.** The pinned image's `postgres` user is UID and GID 70 (checked on the pinned digest, not assumed). Docker creates a new named volume mounted where the image has no folder as root's, with mode 0755, and giving it to UID 70 would need `CAP_CHOWN`, which every container here drops. So the service runs as root on purpose (`user: "0:0"`), with no capabilities: it can write only what root owns (the backups volume), it reads the image volume through its read-only mount, and it cannot override a file's permissions anywhere. The image files must be readable by others for that, which they are when the app writes them under Node's default umask (files 0644, folders 0755). The backup check (below) asserts it, so a later change to the app's file modes fails there rather than in a silent backup. At its first start the nightly service creates `/backups/.lock` readable by everyone (0644), so the restore below can take the same lock.

**Restore runs as the app's user.** Root with no capabilities cannot write into the image volume, whose folders belong to the app's user (the `node` user, UID 1000, which the Dockerfile gives `/data/assets`), and a folder it did create would be root's, so every later upload into it would fail. So the compose file also has a `restore` service behind a profile (`profiles: ["restore"]`), which never starts with the others: the same pinned image, `user: "1000:1000"`, `cap_drop: ALL`, `no-new-privileges`, `read_only`, network `raccoon-data` only, `raccoon-assets` mounted writable at the app's own path `/data/assets`, and the backups volume mounted read-only at `/backups`. All of `backup.sh restore` runs there. It reads `/backups`, whose folders are 0755 and files 0644, restores the database over the network (where its own user does not matter), and copies the images, so every folder and file it creates belongs to UID 1000 as the app's own do. BusyBox's `flock` takes the lock on a read-only open, so the restore shares the backups' lock through its read-only mount (checked in the pinned image as UID 1000). The image volume must already be the app's: a brand new named volume first mounted by the `restore` service, whose image has no `/data/assets`, would come up owned by root, while one first mounted by the app's image takes that folder's owner, `node`. So the restore checks that the root of `/data/assets` belongs to UID 1000 before anything else, and otherwise refuses with "The image volume is not the app's yet. Start the stack once with docker compose up -d, then stop raccoon and restore.", writing nothing.

**Deleted image files wait in a trash folder.** The dump and the image copy happen minutes apart, and an image that a room's deletion or cleanup removes between them would be named by the dump and gone before the copy. The app's file locks are per process and cannot hold off a deletion for another container. So the app never unlinks an image file at once: every deletion (a room's, cleanup's, the library's, a lost upload race's) moves the file into `trash/<date>/` on the same volume, a rename, and a daily job deletes trash folders older than 48 hours. A backup runs in well under 48 hours, so every file the dump can name is either in place or in the trash while it copies. The orphan sweep (section 3.19) and the backup both leave `tmp`, `import` and `trash` alone as sources of new images.

**One run at a time.** The scheduled loop, `backup.sh once` and `backup.sh restore` (README below) share one lock, `flock` on `/backups/.lock` (BusyBox's `flock`, in the pinned image), taken before anything else and held through the log step (step 10). A manual run that finds it held prints "A backup is running" and exits. A scheduled run that finds it held waits for its next scheduled time. Every file a run writes is named by its start time to the second and a run id of random characters, `raccoon-<YYYY-MM-DD-HHMMSS>-<run id>`, so two runs never share a name.

**Each night at `BACKUP_AT`,** in the server's `TZ` (the script sleeps in steps of at most an hour, so a clock change never skips a night), holding the lock:

1. **Start the log, then clean up.** It first checks that `backup_runs` exists. `db/schema.sql` is the only place the table is defined, so the script holds no second copy of its definition to drift. When the table is missing (a database just restored onto a fresh volume, before the app has started), the run stops at once with "The database has no backup log yet. Start raccoon first, then run backup.sh once.", writes nothing and releases the lock. Otherwise it inserts this run's `backup_runs` row as "running", and marks any row an earlier run left "running" as failed, since with the lock held no other run is alive, so the admin page shows "last run failed" at once. Then it removes what an interrupted run left: every `.part` file in `/backups` and `/backups/assets`, every list whose dump is missing, and every dump that has no completion record (step 8), since only a completion record says a dump is good. With the lock held, no other run can own them.
2. **Space for the dump.** The estimate is the last good dump's size plus a quarter. When there is no last good dump, or the database (`pg_database_size(current_database())`) is larger than that estimate, the estimate is the database's size, which a compressed custom-format dump stays under. The budget is the free space on `/backups` less a 2 GiB floor. An estimate over the budget stops the run before anything is written.
3. **The dump, held to its budget.** `pg_dump --format=custom --exclude-table=backup_runs --file=<name>.dump.part` runs in a subshell under `ulimit -f <budget in 512-byte blocks>`, writing straight to the file, so a write past the budget fails (the shell's file size limit kills it with `SIGXFSZ`, or the write returns `EFBIG`), pg_dump's own exit status is the subshell's, and the archive stays seekable, with its data offsets written. The run requires exit 0. Then `pg_restore --file=/dev/null <name>.dump.part` reads the whole archive back, every table's data and not only the catalog, which `pg_restore --list` alone would read, and the run requires exit 0 again. A dump killed midway, a dump that failed below its budget, and a dump past its budget all end here: the `.part` is removed, the run fails, and the last good backup stays. The dump leaves out `backup_runs` (below), whose schema `db/schema.sql` keeps.
4. **What the dump names, before the rename.** `pg_restore --data-only --table=assets` of the `.part` gives every asset row the dump holds, and the script writes the list beside it as `<name>.files`: one line per variant file, the file's path inside the image volume exactly as `variantPath` builds it, `<first two hex of the hash>/<sha256 hex>-<kind>-<variant>-v<pipeline>.webp` (`variantFileName`). Only then is the dump renamed from `.part`. `scripts/backup-check.ts` checks every line of a list against `variantFileName` and `variantPath` for the dump's rows, so the script's own parsing is tested against the app's naming rather than prescribed here.
5. **Space for the images.** It sums the sizes of the listed files the copy lacks, or holds at a different length than their source, and checks that `/backups` keeps the 2 GiB floor after them. If not, it copies none and ends as a partial run.
6. **The copy.** Each such file is copied, from the volume's own place or, if gone there, from its trash, to `<file>.part` in `/backups/assets`. Its length is compared with the source's, and only a match is renamed into place, so a file under its final name is always whole. It checks the floor again every 100 files and stops as a partial run if the disk filled meanwhile.
7. **The check.** Every file the dump lists must be in `/backups/assets` at the same length as its source on the volume or in the trash. A listed file whose source is gone (purged from the trash after 48 hours) counts when it is there under its final name, since only a verified copy is ever renamed into place. Otherwise the run is partial.
8. **The completion record, last of all.** Only a run that passed every step above writes `<name>.good` beside its dump (through a `.part` and a rename): the run id, the dump's name and bytes, the list's name and its file count, and when it finished. That file on the backups volume, and nothing else, says the dump is good. A partial or failed run writes none, so its dump is removed by the next run's cleanup.
9. **Retention, only after a good run.** It reads the completion records, never the database, and keeps the current run's, the 6 other newest, and the newest of each of the last 4 weeks. It deletes the other dumps, lists and records, then each file in `/backups/assets` that no kept dump's list names. So `/backups/assets` holds exactly the images every kept dump needs, an older dump's images included after the app deleted them, and a run always survives its own retention. A partial or failed run deletes nothing but its own leftovers, so the last good backup always remains.
10. **The log.** It reconciles `backup_runs` with the completion records (every record has a row marked good, and a row marked good without a record is marked gone), finishes this run's row with its outcome, bytes, images copied and any error, and deletes rows older than 90 days. Then it releases the lock. The rows are only a log: the completion records stay the only truth for retention.

`docker compose -f docker-compose.server.yml exec backup sh /backup/backup.sh once` runs one backup now, for before an update, or says a backup is running.

**Where the results show.** `db/schema.sql` creates `backup_runs`, which the app applies at boot. It is a log for the admin page (section 3.18), which shows the last run and the last good one, and warns when the last run was not good or no good backup has run for 36 hours. Retention never reads it, and the dumps leave it out: a database restored from an older dump would otherwise bring back an older `backup_runs` that does not know the later backups, and if retention trusted it the next run could delete them. The completion records live on the backups volume, which a database restore does not touch, and they stay the only source of truth. Each run rebuilds the table's rows from them. After a restore onto a new database the table starts empty (the app creates it at boot), so the admin page warns that no good backup exists until the next run rebuilds the rows. README's restore steps say so and suggest running `backup.sh once` after a restore. Each run also writes one line to the container's log.

**What the dumps hold.** Everything the database does but the backup log: every room's state, argon2 hashes, the sealed player passwords (useless without `ROOM_SECRET_KEY`, which the backup never sees), and session token hashes. They are as private as the database volume, on the same disk. A copy on the same disk does not survive the disk, so README says to copy `raccoon-backups` off the server and gives the command (question 7). A restore on a new server needs the same `ROOM_SECRET_KEY` for DMs to see their player links, as design.md 10.2 says of any key change.

**README.**

- **Sizing.** The backups volume needs about the image volume's size (`docker system df -v`, or `du -sh` on the volume) plus 11 dumps, and the free-space floor keeps 2 GiB for the app and Postgres. It shows how to read both sizes before the first backup.
- **Restore**, in this order. On a new server, first run `docker compose -f docker-compose.server.yml up -d` once and wait until `raccoon` is healthy: the app's image creates `raccoon-assets` owned by `node`, and the app applies `db/schema.sql`. Then:
  1. Stop `raccoon`.
  2. `docker compose -f docker-compose.server.yml --profile restore run --rm restore sh /backup/backup.sh restore <dump name>`. It takes the backup lock, checks that the dump has a completion record, restores it with `pg_restore --clean --if-exists --no-owner`, and copies `/backups/assets` into the image volume without overwriting, all under the lock, so a backup cannot run retention and delete the chosen dump's images partway through. Then it releases the lock and returns.
  3. Start `raccoon` and wait until it is healthy (`docker compose -f docker-compose.server.yml ps` shows it healthy), which means it has applied `db/schema.sql`, so `backup_runs` exists again on a fresh database.
  4. `docker compose -f docker-compose.server.yml exec backup sh /backup/backup.sh once`, which rebuilds the log's rows from the completion records.

  A backup before step 3 on a fresh database stops at once with "The database has no backup log yet. Start raccoon first, then run backup.sh once." and changes nothing, since the dump holds no `backup_runs` and the app creates it at boot. The folder holds every kept dump's images, so it holds the chosen one's, and files the restored rows do not name are removed later by the orphan sweep (section 3.19). The dump holds no `backup_runs`, so a restore never brings back an older list of backups. On a new database the admin page warns "no good backup" until the next run, which rebuilds the rows from the completion records, so the steps end with `backup.sh once` once the app is healthy.
- **The drill**, run once: back up A, delete a room, back up B, restore A and see its images, upload an image and delete one so cleanup moves a restored file to the trash, back up again, and check that B is still restorable. Then once more on a fresh server, following the new-server steps above from `docker compose up -d`.

The manual commands stay for a one-off copy.

**Tests.** `pnpm test:backup` runs the script in the pinned image against the development database (the development compose file gains the service behind a `backup` profile):

- a good run, restored into a scratch database with every table's row count compared and every listed file present,
- a room deleted between the dump and the copy, whose images are still copied from the trash,
- backup A, a room's deletion, backup B, then a restore of A that finds every image A lists,
- a too-small volume (a tmpfs of a few MB) giving a partial run that keeps the older backup,
- a copy interrupted midway, whose `.part` is removed and copied again by the next run, which only then counts as good,
- a run stopped between the list and the dump's rename, which leaves nothing that counts,
- pg_dump killed mid-dump, a producer that exits nonzero below the budget, and a dump past the budget, each leaving no `.part` and a failed run,
- the first backup surviving its own retention, and a run with new images keeping them,
- backup A, backup B, a restore of A into the database, then a new backup, after which B is still restorable while within retention and `backup_runs` lists both again,
- a dump holding no `backup_runs` data or definition,
- a manual run started while the scheduled one copies images, which reports "A backup is running" and touches nothing,
- a restore overlapping a backup whose retention would prune the selected dump, where the backup waits for the lock and the restore finds every image it needs,
- the restore onto an existing image volume and onto a fresh one prepared by `docker compose up -d` as README says, after which an upload into a restored prefix folder succeeds, a cleanup moves a restored file to the trash, and every folder under the image volume belongs to UID 1000,
- the documented restore sequence against a fresh database: restore, start the app, wait until healthy, then `backup.sh once`, which succeeds and rebuilds `backup_runs`,
- a restore refused, with its message and nothing written, when the image volume's root is not UID 1000's (a new volume first mounted by the `restore` service),
- a run on a fresh database before the app starts, which stops with "The database has no backup log yet. Start raccoon first, then run backup.sh once." and leaves the backups volume unchanged,
- a run killed in its middle, whose row the next run marks failed at its start,
- every list line checked against `variantFileName` and `variantPath`,
- retention over a list of dated files,
- the files readable by the backup's user.

It needs Docker, so it is a check before release, like the server-box benchmark.

### 3.18 Admin page

The request: "Admin page behind the admin password: list rooms, delete rooms, see storage use."

**Today.** No admin password, route, role or page exists. The CLI (`scripts/admin.ts`) lists rooms with their last activity and size, pins and unpins, imports, creates rooms and replaces DM links.

**Turning it on.** The page exists only when the server has `ADMIN_PASSWORD_HASH`, an argon2id hash. Without it `/admin` is the not-found page and every `/api/admin/*` route answers 404. `docker compose -f docker-compose.server.yml run --rm --no-deps raccoon node scripts/admin.ts hash-password` asks for the password twice without echoing it, refuses one under 16 characters or on the common-password list, can generate one, and prints the line to paste into `.env`, single-quoted so Compose leaves its `$` signs alone. The compose file passes the variable to `raccoon` only. Changing it signs every admin out (below).

**Login.**

- `/admin` shows one password field (and the Turnstile check when Turnstile is configured, always, not only after failures). `POST /api/admin/login {password, turnstileToken?}` verifies through the shared argon2 queue.
- Limits in `rate_events`: 5 failures per 15 minutes per address, then growing delays up to an hour, and 50 failures in an hour across the site close the login for that hour. A stranger can therefore keep the server owner off the page for an hour, never out of the CLI.
- Success makes an admin session: 32 random bytes in a cookie of its own, `__Host-rvtt-admin` (`rvtt-admin` in development), `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and only its `sha256` in a new `admin_sessions` table with its expiry (12 hours, fixed) and a fingerprint of the password hash it was made under. A changed `ADMIN_PASSWORD_HASH` no longer matches, so every admin session ends. Sign out deletes the row. Admin sessions are not room sessions and hold no grants.
- Every admin route checks the cookie, the CSRF rule and the per-request limit, and answers with `Cache-Control: no-store`.

**The page** (a lazy chunk, at the `/admin` route, never loaded by a room):

- **Storage.** The image volume's used and free space (`statfs`, as the free-disk guard reads it), the database's size (`pg_database_size`), the images on disk counted once per file (rooms share files), the images waiting for cleanup and their size (section 3.19), and the last backup run (section 3.17).
- **Rooms.** One row per room: name, ID, created, last active, size (the quota's own sum, which counts a shared file in each room that has it, as the hint says), images, whether it is loaded, open sockets, pinned, read-only. Sorted by last activity or size.
- **Actions.** Pin or unpin, and Delete, which asks for the room ID typed to confirm, red as every destructive button. That is all: the admin page never shows a room's contents, its DM link, its player password or its members, and cannot enter a room.

**Routes.**

- `GET /api/admin/storage` and `GET /api/admin/rooms`.
- `POST /api/admin/rooms/:id/pin {pinned}` updates the row and the loaded room, through a new `RoomManager.setPinned`. The CLI's pin runs in a process of its own, so it still reaches a loaded room only when the room next loads, as today.
- `DELETE /api/admin/rooms/:id {confirm}` runs the DM's own delete path: the actor gateway unloads the room and closes its sockets with `4009`, the row's cascade removes its data, and its files go when no other room names them.
- `POST /api/admin/login` and `DELETE /api/admin/session`.

**Logging.** Admin logins, failures and deletions are logged with the address, which is the server owner's own information about their own server.

**Tests.** 404 without the variable, the hash command's checks, login with the limits and Turnstile, a session ending when the hash changes or after 12 hours, CSRF, every route refusing without the cookie and refusing a room session's cookie, the listing's numbers against the CLI's, pin reaching a loaded room, delete closing sockets with `4009` and removing files no other room uses, and the page holding no room content (the listing's fields are an allowlist).

### 3.19 Cleanup of unused images

The request: "Cleanup of unused images."

**What builds up.** An asset row belongs to its room until the room is deleted, and every picker lists the room's rows as its library: a DM re-shows closed handouts from it, starts new scenes from its maps, and reuses token art. So "unused" by the room's state is not unused by the DM. What does build up unseen:

- Scene thumbnails: a DM device makes a new one each time the DM leaves a scene it changed, and the old one stays (about 15 to 30 KB each), forever, since no picker shows them.
- Files on disk that no row names: a crash between placing a file and writing its row, or a room deletion whose file removal failed (only logged today).

design.md 16.3 planned to delete every row the state has not named for 30 days. This design does that automatically only where no picker can reach the image, and gives the DM the rest to decide (question 2).

**Automatic, daily, in the server process** (beside the hourly and daily jobs that exist):

- **Thumbnails.** `assets` gains `unused_since timestamptz`. Per room, the job reads which `thumb` assets the state names and marks the others unused since now, clearing the mark on any named again. A thumbnail unused for 1 day is deleted, row and then file. Nothing restores an old thumbnail (a restore keeps the current one, design.md 7.7), so nothing can need it back.
- **Files no row names.** Once a week the job walks the image folders and deletes a file named like an asset variant (`<sha256>-<kind>-<variant>-v<pipeline>.webp`) whose (hash, kind, pipeline) no row names and which is more than a day old, so an upload between its file and its row is never caught. It never touches `tmp`, `import` or `trash`.
- **Trash.** Every file deletion moves the file into `trash/<date>/` on the same volume instead of unlinking it, and the job deletes trash folders older than 48 hours, so a backup running meanwhile can still copy it (section 3.17).

**For the DM.** The DM's image library marks each image the room's state does not use as "Not in use", and offers Delete on it and "Delete N not in use (12 MB)", on a second tap. `GET /api/rooms/:id/assets` gains `inUse` for a DM, from the committed state. `POST /api/rooms/:id/assets/delete {ids}` (DM grant, at most 500) refuses with `409 asset_in_use` any image the state names when it runs.

**The deletion barrier.** An op can name an asset at any moment, and two things in the actor make a plain queued check unsafe: ops ahead of the check may be staged and not yet committed (a staged `token.delete` may have removed an image's last reference and still fail to commit, or be dropped by shutdown's `#abandon`), and `RoomActor.op()` loads an op's asset facts (`loadAssetFacts`) before the op enters the queue, so a lookup can be in flight outside the queue. So a row is deleted only by one step on the room's actor queue. The step first flushes the batch being staged and awaits its commit (`#commitNow`), so the staged state equals the committed state and nothing it relies on can still be abandoned. It then computes the used set from the committed state with `referencedAssetIds`, deletes the rows of the requested images that are unused in one statement awaited inside the step (so no op is applied meanwhile), and records the deleted ids under a new value of the room's deletion generation, a counter of deletions kept apart from the room seq, since a deletion is no room op and does not move the seq. `op()` reads the deletion generation and registers the lookup with the asset ids it will read in one synchronous step, before the lookup's first `await`, so no deletion can run between the two and find the lookup missing. When the op reaches the front of the queue, the step compares: if a deletion ran since, the op's facts are checked against the ids deleted since its generation, and a fact for a deleted id is dropped, so permissions answer `gone`, as for an asset that never existed, and no reference to a missing row is ever stored. Each outstanding lookup registers the generation it started at and the asset ids it reads, from the start of the lookup until its op is processed or refused. A deletion keeps only those of its deleted ids that some older outstanding lookup asked for, and drops each when the last such lookup finishes. So the record holds at most the ids that outstanding lookups read, however long one stalls and however many unrelated deletions run meanwhile, with no lifetime set and no pruning a slow lookup could outlast. For a room that is not loaded, the step runs under a per-room lock that the room manager gains and that a load waits for, so the room cannot load halfway through, and there is no queue and no lookup to race. Files go after their rows, under the file lock, into the trash, only when no row in any room names them, as room deletion does today.

`referencedAssetIds(state)` walks every reference: scene maps, phases and thumbnails, token images and other images, character portraits, monsters' and SRD monsters' images, stamps, handouts. For a room that is not loaded, the automatic job does not load it: it reads the snapshot and every op stored after it as text, and any appearance of the asset's ID counts as a use, which can only keep too much. A room that failed to replay is skipped. Undo cannot bring a deleted image back (section 2.6).

**Quota.** Deleting rows frees quota, and a room that went read-only at its quota checks its size again at once, so it takes edits again without waiting for an op and a snapshot that may never come.

**Adjacent fix.** `scripts/admin.ts import`, run inside the live container, calls the asset service's startup, which deletes every temporary upload file in the shared volume, so it can break an upload in progress on the running server. The CLI gets a temporary folder of its own and never clears the server's.

**Tests.**

- `referencedAssetIds` against every reference (a test adds a field to the model and fails until the walk knows it).
- Thumbnails marked, cleared, and deleted after a day.
- The text scan for a room that is not loaded, and a file younger than a day kept.
- **A staged removal whose commit fails:** a staged `token.delete` removes an image's last reference and its commit fails. The deletion step waits while the commit is retried, and when the actor shuts down and abandons the batch instead, the step deletes nothing and the image is kept.
- **A stalled lookup with no room op between:** an op's asset lookup is stalled, a deletion of that image runs with no other op in the room, then the op reaches the queue and is answered `gone`, with no reference stored.
- **A lookup stalled past a naive prune:** the same, with further deletions and the queue emptied while the lookup is still stalled, and the record of the first deletion is still there when the op arrives.
- **A bounded record:** one lookup stalled while unrelated images are deleted again and again, and the record never holds more than the ids that lookup read.
- The library listing's `inUse`, and the delete route's refusals.
- A restore refused after its image was deleted.
- Files moved to the trash and purged after 48 hours.
- The quota re-check.
- The CLI import leaving the server's temporary files.

## 4. Build split

One part lands first, because the others build against it, and it lands after wave 4's core merges, since both change `shared/model.ts`, `protocol.ts`, `permissions.ts` and `project.ts`. The rest run in parallel jj workspaces with the ownership shown. Shared registry files (tools, layers, panels, the Menu's pages, the router) get one-line additions only.

| Part | Owns | Depends on |
| --- | --- | --- |
| **5A Contract and core** | `shared/model.ts`, `shared/protocol.ts` (the `roll.*`, `journal.*` and `pin.*` ops, roll choices and both switches, `token.updateMany`, `token.deleteMany`, `actor.effects`, `playersDraw`, `monsterId`, the `ImageRef` union and `IconKey`, the `view` event, the `xcard` and `presence` messages, `you.role` with `'display'`, the shared `SearchResult` with its credit), `shared/keys.ts`, `shared/limits.ts`, `shared/migrate.ts` (snapshot 8), `shared/reducer/*` (journal, pins, rolls, the many-ops, member removal, the duplicate copying pins, a page's deletion making its pins DM only), `shared/reducer/tx.ts`, `shared/permissions.ts` (the drawing permission on creates and on a player's restores), `shared/project.ts` (journal, pins with `tileDependents`, rolls, roll lines, `monsterId`, the derived `party` flag, icons in `visibleAssetIds`, dependents), `shared/reads.ts`, `shared/rules/skills.ts`, `shared/rules/rollReminders.ts`, `shared/referencedAssets.ts`, `shared/logText.ts` (moved from `client/features/log/format.ts`, which then re-exports it), `server/rooms/sizeGuard.ts` (every scene's own part measured at load from one pass over the stored entities grouped by scene and kept with its growth bound, the room-level part with every in-memory whisper counted, and a room-level op checked against the largest scene part), `server/rooms/stateSchema.ts`, `remap.ts`, `importRoom.ts`, `exportRoom.ts`, `undoLabels.ts`, `db/schema.sql` (every wave 5 table and column, `sessions.purpose` included), `server/config.ts` and `docker/server.env.example` (the new variables). It also updates every reader of `ImageRef` mechanically, an icon drawing as initials until 5E, so the tree typechecks when 5A merges. Tests for each. | wave 4's core |
| **5B Rooms server** | Display codes, sessions and grants (`server/http/display.ts` with minting under the DM rule, anonymous redeem, `display/me`, Leave and the display image route, the session purpose rule in `server/auth/*` so every ordinary route treats a display session as none, the display session's lifetime with its renewal and the recheck's `4001`, the codes' own failure bucket, `server/rooms/ws.ts` for `as=display`, the connection's `display` flag, presence counts in `actor.ts`, `server/rooms/ephemeral.ts` for `view`), the X-card route with lookup-only authentication and its broadcast, the log sessions and export routes with projection first, their cache keyed by seq, member and role, and every request charged (`server/http/log.ts`), in `actor.ts` the asset facts for restores and the deletion barrier's parts (the flush before a deletion step, the deletion generation read before `loadAssetFacts`, the outstanding lookups with the ids each reads, and only those deleted ids kept while they wait), `RoomManager.setPinned` and the per-room lock. Integration tests. | 5A |
| **5C Operations** | `server/http/admin.ts`, `server/auth/adminSessions.ts`, `scripts/admin.ts` (`hash-password`, the import's own temporary folder), `server/assets/cleanup.ts` (the deletion step, thumbnails, files no row names, the library delete, `inUse` in the listing, the quota re-check), the trash in `server/assets/store.ts` (moving files instead of unlinking them) and its purge, the admin page (`client/pages/Admin.tsx`, `client/features/admin/*`, one router line), `docker-compose.server.yml`, `docker-compose.yml` (the backup profile), `docker/backup.sh` (the run lock created readable by all, `restore` under the same lock in the `restore` service as UID 1000, the "running" row, the dump under `ulimit -f` read back whole, lists written before the rename, copies through `.part` files checked by length, completion records written last, retention by completion records, the log reconciled from them), `scripts/backup-check.ts`, README (backups with sizing and the drill, admin, the new variables). | 5A, 5B (the barrier, the manager's lock and `setPinned`) |
| **5D Openverse server** | `server/assets/openverse.ts`, `server/http/search.ts`, `shared/searchThumbnails.ts`, the CSP in `server/http/security.ts`, `docker/squid.conf`, the egress comment, and two listed lines elsewhere: `insertRow` taking a credit (`server/assets/store.ts`) and the import route storing it (`server/http/assets.ts`). | 5A |
| **5E Images client and icons** | `scripts/game-icons.ts`, `public/game-icons/**`, `shared/gameIcons.ts` (the generated path constant), `CREDITS.md`, `shared/credits.ts`, `client/features/about/*`, `client/features/images/*` (the Icons tab and its offline names, Openverse results, notice and failed-preview tile, credit lines with their changes, the library's "Not in use" and delete), the icon index in the background preload, the static cache header for `/game-icons/`, the icon drawing in `client/canvas/TokenNode.tsx` and in HTML portraits. | 5A, 5D's result shape (in 5A) |
| **5F View and device client** | `client/features/display/*` (the display room with its image URLs, the code page, both camera modes, the tap rules, Leave), the DM panel's Table display section and the `view` sending in `client/features/dm/*`, `client/features/outliner/*`, `client/state/shortcuts.ts` (the registry beside undo and redo), `client/features/device/*` (This device, low power, interface size), `client/canvas/konvaSetup.ts`, `Stage.tsx` (the pixel ratio remount, scaled insets), `client/pages/Room.tsx` (zoom on the chrome, the width hook), `client/components/Sheet.tsx`, `client/lib/modalDialog.ts`, and the decoration sizes in `client/lib/tokenView.ts`, which `TokenNode.tsx` already reads. | 5A, 5B |
| **5G DM tools client** | `client/features/rolls/*` (the DM's sheet and live cards, the player's card and chips), `client/features/party/*`, the group action bar in `client/canvas/TokenActionBar.tsx` and its More sheet, `client/panels/TokenPanel.tsx` and `client/features/tokens/*` (the stat block section, attach and detach, the group HP fix), `client/features/monsters/*` (the stat block view extracted from the Monsters panel, `monsterId` on placing), `client/features/encounters/drop.ts`, the tracker row's option in `client/features/encounter/Row.tsx`, one line in `FightAlerts` (`client/features/encounter/InitiativeStrip.tsx`, which no other wave 5 part owns) and one in `SidePanel` (`client/pages/Room.tsx`, 5F's). | 5A |
| **5H Notes and table client** | `client/features/journal/*` (with "Pin to the map" closing the sheet), the journal options in `client/components/markdown.ts`, `client/features/pins/*` (the Pin tool, the layer, the pane), the Draw tool's gate in `client/features/drawings/DrawTool.tsx`, "Who can draw" in `client/features/settings/form.ts` and `client/panels/SettingsPanel.tsx`, the Export button in `client/panels/LogPanel.tsx` and its sheet in `client/features/log/*`, `client/features/xcard/*`. | 5A, 5B |
| **5I Integration** | e2e with three browsers (DM, player, table display): a roll asked with two choices, answered, folded to a chip and closed, a secret revealed, a pin opening its page and a page's deletion keeping its pins from players, the display following the DM while a hidden monster's drag never reaches it and its images loading through its own route, the X-card on all three, an icon token, and the log export. `docs/design.md` and `docs/features.md` updated from this file, and design.md 15.2's development compose description corrected (it names port 5433 and a `raccoon-dev` service, where the file has 5434 and none). | all |

Two files are touched by two parts, each through a seam: `TokenNode.tsx` belongs to 5E, and 5F's interface size reaches the names and chips through the sizes in `tokenView.ts`. `client/panels/MenuPanel.tsx` gets one line from 5F (This device) and one from 5H (X-card).

## 5. Performance summary

- No new per-op cost in play beyond the new ops' own small work. The many-ops are bounded at 100 tokens.
- The table display costs what one more player costs, plus `view` events only while a driving DM's camera moves.
- Journal pages and roll requests add bounded room-level data to snapshots (1 MiB and 20 requests at most). The size guard checks room-level ops against the largest scene with one comparison.
- The outliner lists up to about 5,000 rows, windowed, with an index rebuilt on change.
- Low power cuts canvas pixels by about four on a phone and stops three animation loops.
- Icons cost a device about 1.4 KB each, fetched once and cached for good, plus the index once per device.
- The log listing folds the caller's whole projected archive once per room state, member and role, in bounded batches, and keeps the summaries, at most eight lists within 1 MiB (docs/design-v1-log-history.md 4.1).
- Cleanup runs once a day per room, as one step on the room's queue for a loaded room (a query and a delete), and a folder walk once a week.
- Backups run `pg_dump` once a night in their own container with its own CPU and memory limits, list the dump's images, and copy only the files they lack.
- The log export streams in bounded batches, one at a time per room, within 30 s (docs/design-v1-log-history.md 4.2).

## 6. Testing

Beyond each part's tests in section 3, the build includes these:

- **Projection.** The invariant of design.md 18 (applying a viewer's events to its snapshot equals a fresh projection) gains journal pages with secret blocks, reveals, access changes and deletions, pins linked to pages and pins revealed by exploration, roll requests with answers under both switches, the `party` flag, and a table display viewer, under random states and op sequences. No player projection holds a DM-only page, a page private to another player, an unrevealed secret block, a pin linked to a page the player cannot read, another player's roll target, a hidden DC or a hidden result, or a `monsterId`. A display's projection equals that of a player who owns nothing.
- **Sockets.** A display never receives a whisper, a hidden token's drag, a drag's path on a fog or vision scene, a DM-only field or any op answer, and is closed for sending anything but `hello` and `ping`. The X-card reaches every socket on every scene, a display's and a paused player's included, and leaves no row anywhere, `sessions` included.
- **Sessions.** A display token under the room cookie's name is no session to any ordinary route, and a room token under the display cookie's name opens no display. A display's image route serves only its projected visible set.
- **Undo.** Each new DM op undoes under its value guard. The many-ops undo as one step. A restore that would bring back a deleted image is refused, a player's restore of a drawing needs the drawing permission, and a stored restore from before these rules replays.
- **Sizes.** Two scenes, the one not viewed near 3 MiB: a room-level op that would carry it past is refused, and a smaller one passes. Two DMs with different whisper histories near the limit.
- **Log.** Adding hidden rows changes no player's session listing, export or remaining limit. One member with a DM grant and a player grant gets each role's own rows in either order.
- **Import.** A backup with journal pages, pins, roll requests, icon images, `monsterId` and credits imports with new IDs, open requests dropped, member access remapped, and a link to a monster that did not come through dropped.
- **Operations.** The backup check (section 3.17), with a deletion between the dump and the copy, a restore of an older dump, a partial run, a dump killed, failed or over its budget, an interrupted copy finished by the next run, a run surviving its own retention, a restored database that cannot roll back retention, an overlapping manual run, a restore overlapping a backup, a restore leaving every image folder the app's, and the documented restore order on a fresh database. Admin login limits. Cleanup's text scan, the deletion barrier's three races and its bounded record.
- **Client.** The shortcut table across layouts, the interface size's width hook and positions, Playwright screenshots of the display, the outliner, a roll card and its chip, the journal and the interface sizes, saved outside the repository.

## 7. Risks and hard parts

1. **Wave 4 and wave 5 share the core files.** `project.ts`, `permissions.ts` and `protocol.ts` change in both. 5A starts only after wave 4's core merges, so it never rebases the vision projection.
2. **CSS `zoom` on phones.** It is the only practical way to scale an interface built from inline pixels, but its effect on iOS (a field's zoom on focus, viewport units inside a zoomed box, Konva overlays positioned over the canvas) was not tried on a device. Section 3.16's screenshots and a try on an iPhone gate it, and 85% can be dropped if iOS misbehaves.
3. **The X-card's anonymity has an edge.** It is anonymous to everyone at the table, the DM included, and the app writes nothing about a tap, not even a session timestamp. But a tunnel or proxy in front of the server, such as Cloudflare's, may log every request with its address, in the server owner's account. The server process also sees the session while it handles the tap.
4. **Displays.** A display session in a living room reads the player scene until it leaves, is signed out, the password changes, or 30 days pass without it connecting. "Open on this device" runs in the DM's own browser, which also holds the DM's cookie, so it isolates what the TV draws, not the laptop from the people at it.
5. **Openverse** is a free service run by others: its anonymous limits are shared by the whole server's address, its availability is not promised, and it does not verify licenses. Many results are NC or SA. The app keeps each image's credit, says what it changed, and says where results came from.
6. **Room-level text in DM snapshots.** Up to 1 MiB of journal and 1 MiB of monsters ride in every DM snapshot and count toward a projected scene's 3 MiB, so a room at both caps has about 1 MiB left for its largest scene.
7. **Cleanup deletes data.** It deletes only replaced thumbnails, files no row names, and what the DM picks, through the deletion barrier, with a conservative text scan for rooms that are not loaded and 48 hours in the trash before a file is gone. A bug here loses images, so the tests cover every reference and both races.
8. **Backups on the same disk.** A failing disk takes the backups with it until the server owner copies them off (question 7). The copy of the image volume roughly doubles its space on that disk, so the script budgets it before copying, keeps 2 GiB free, and stops as a partial run that deletes nothing rather than fill the disk the app and Postgres need. README says how to size it.
9. **The repository grows by about 7 MB** of icon SVGs, committed like the stamps.

## 8. Not changed, with the reason

- **Log lines keep naming creatures by ID.** A player's export follows their projection as their Log panel does, so a line about a creature they can no longer see is left out of both. Naming creatures in the line when it is written would put names into lines that hidden-name rules then have to strip, for little gain.
- **No dice.** A requested roll is typed in by the player, as features 14 and decision 1 say.
- **Area damage does not read roll answers.** The DM's Damage form marks saves by hand as today. Linking it to a request is a later step.
- **No service worker.** Icons are cached by the browser, the index is preloaded, and design.md 14.5's reasons stand.
- **Search thumbnails still load from their hosts** (decision 6), Openverse's included.
- **Players do not write journal pages**, as the project owner decided on 2026-10-14 (question 3).
- **A room export carries the log lines the room holds in memory** (design.md 7.3 and 16.4), and an import writes them all to its archive. The session log export is the record of play.
- **A room export still carries open roll requests**, since it is the stored state, and the import drops them (section 2.5).
- **Library images are not deleted automatically**, as the project owner decided on 2026-10-14 (question 2).
- **The CLI's pin** still reaches a loaded room only when it reloads, since the CLI is a process of its own. The admin page's pin reaches it at once.

**Adjacent fixes this design makes,** each found while reading the code, each small and inside its part's purpose:

- Ctrl+Z inside "View as a player" undoes the DM's real last change, because the preview mounts a second room (section 3.14).
- One group HP entry takes one undo per creature (section 3.5).
- `scripts/admin.ts import` deletes the running server's temporary upload files (section 3.19).
- A room read-only at its quota stays read-only after space is freed until an op and a snapshot follow (section 3.19).
- A DM's undo can restore a reference to an image row that is gone. That was unreachable while rows were never deleted, and cleanup makes it reachable (section 2.6).
- The client's `SearchResult` type requires sizes the server sends only sometimes (section 3.13).
- design.md 15.2 describes a development compose file that no longer exists (5I).

## 9. Questions for the project owner

The project owner decided every question here on 2026-10-14. Each was listed with its recommendation, and the project owner answered: "All defaults good with me". So each recommendation below is the decision, and the build follows it.

1. **What does "Full stat blocks" mean?** Recommended: the DM reads a monster or NPC token's whole 2024 stat block from its token panel and its tracker row, linked to the SRD monster or the room's own monster it came from, and a player reads the SRD block of a monster form they play (section 3.6). The alternatives are a full block copied onto each token, which a DM could edit per creature but which costs up to 16 KiB per token, or full blocks for player characters, which D&D Beyond already keeps.
2. **Should images nothing uses be deleted automatically?** Every picker lists a room's images as its library, so an image no token wears may be one the DM keeps for later (a handout to show again, a map for a new scene). Recommended: delete automatically only replaced scene thumbnails and files no row names, and let the DM delete the rest from the library, where they are marked "Not in use" (section 3.19). The alternative is design.md 16.3's plan: delete every image the room has not used for 30 days.
3. **May players write journal pages of their own?** Recommended: not in wave 5. The DM writes pages and chooses who reads them, as the request describes, and players keep token notes. The alternative lets each player keep up to 20 private pages, which the DM can also read.
4. **Who sees a requested roll's results?** Recommended: the DM and the creature's player only. Players say their results at the table anyway. The alternative shows every answer to everyone the request asked.
5. **Which Openverse licenses?** Recommended: every Creative Commons license and public domain except no-derivatives ones, since cropping an image into a token adapts it. Non-commercial and share-alike images stay, since a group usually plays for free and a room's images stay in that room. The alternative keeps only licenses that allow commercial use, which leaves out most of what Openverse finds for "goblin".
6. **Does "Who can draw" also cover kept rulers?** Recommended: no. Kept rulers are measurements from the ruler tool and stay allowed, as do pings and the laser.
7. **Where should backups go?** Recommended: a volume on the server with 7 daily and 4 weekly dumps, and README's command for the server owner to copy it off the server. The alternative adds an off-site copy (another machine or a storage service), which needs credentials and an egress rule.
8. **Should the table display show whose turn it is?** Recommended: off by default, a choice in the display's menu, since the request asks for no UI.
9. **Where does the X-card live?** Recommended: at the top of the Menu panel, with a second tap on a large X so a stray tap sends nothing. The alternative is a button always on screen, which a phone's top bar has no room for.
10. **Is the party bar for the DM only?** Recommended: yes. Players do not receive other characters' AC and Passive Perception (features 15), and the Characters panel already shows them each party member's name, conditions and whatever HP the DM allows.
11. **All 4,180 icons, or only fantasy ones?** Recommended: all of them. The set has no tags the app may use to pick out fantasy icons, and the search finds what a table asks for. The alternative leaves out sets by hand, such as the 121 abstract shapes.
12. **What should players see of a requested roll by default?** Recommended: two switches on a request, "Players see the DC" and "Players see pass or fail", both on by default, since the request's example names the DC ("Dex save, DC 15"). The DM can hide the DC and still show pass or fail. The trade-off: then a player's answer is final once it has a result, and a change goes through the DM ("Ask the DM to change it"), since freely changed totals would reveal the DC within a few tries. The alternatives are the DC hidden by default, or one switch for both.
13. **How long should a table display stay signed in?** Recommended: until Leave, which signs it out for good, or 30 days after it last connected, instead of a room session's 180 days, since a TV sits in a shared place. The alternative keeps the 180 days.
14. **Should the TV show roll results?** Recommended: no. They belong to the DM and each creature's player (question 4), and the display receives no requests. The alternative shows a summary of each closed request on the TV.
15. **What does "works offline" mean for the icons?** Recommended: the icons need no outside service. The index is preloaded with the room's panels, so a device that lost its connection can still search and pick an icon, the edit queues like any offline edit, and the token shows its initials until the art arrives (section 3.12). The alternative makes every icon's art available offline, which needs a service worker or a 2.8 MB download on every phone.

## 10. Sources and what could not be verified

**game-icons.net.**

- About page, https://game-icons.net/about.html: CC BY 3.0, with "A mention like "Icons made by {author;}. Available on https://game-icons.net" is fine", and the author table. FAQ, https://game-icons.net/faq.html: some icons are public domain, and credit goes on a credits page or menu.
- The repository, https://github.com/game-icons/icons, at commit `82d948812bfe3f269ef8f731dcdb07b08160edc4` (2026-04-23): 4,180 icons in 36 author folders, every one in the shape `scripts/icons.ts` checks, and `license.txt`, which marks Viscious Speed and Zeromancer CC0. The icon pages of "Various artists" (for example https://game-icons.net/1x1/various-artists/infinity.html) say CC0. GitHub's note that archive checksums may change: https://github.blog/changelog/2023-01-30-git-archive-checksums-may-change/.
- CC BY 3.0, https://creativecommons.org/licenses/by/3.0/legalcode, section 4(b).
- Measured at that commit by a research agent: 6,958,615 bytes of SVG, median 1,428 bytes a file, 47 names shared by two authors.
- Not verified: the license of the site's tags and descriptions (none is stated), and how each browser draws a large Konva `Path` built from the biggest icons on a phone.

**Openverse.**

- API schema and docs: https://api.openverse.org/v1/schema/ and https://api.openverse.org/v1/. Source: https://github.com/WordPress/openverse (rate limits in `api/conf/settings/rest_framework.py`, page limits in `api/api/constants/restricted_features.py`, the registration rule in `api/api/utils/throttle.py`, the thumbnail proxy in `api/api/utils/image_proxy/`).
- Live anonymous calls on 2026-10-14 returned the headers `x-ratelimit-limit-anon_burst: 20/min`, `anon_sustained: 200/day` and `anon_thumbnail: 1000/day`, refused a page size over 20 with 401, and served thumbnails from api.openverse.org with no redirect. A reviewer's later schema fetch got 403.
- Terms of service, https://docs.openverse.org/terms_of_service.html (effective 5 May 2022), sections 2 to 4.
- Not verified: the production lifetime of a registered client's token, and the body of a live 429.

**Credit for changes.** CC BY 4.0, https://creativecommons.org/licenses/by/4.0/legalcode.en#s3, section 3(a)(1)(B): "indicate if You modified the Licensed Material". The 2.0 and 3.0 licenses ask for a credit identifying the use of the work in an adaptation.

**CSP.** CSP Level 3, https://www.w3.org/TR/CSP3/#security-paths ("Paths and Redirects") and the matching algorithm at https://www.w3.org/TR/CSP3/#match-url-to-source-expression: after a redirect, a source's path is not checked.

**The X-Card.** John Stavropoulos, "Safety Tools for Simulations and Role-Playing Games", http://tinyurl.com/x-card-rpg, published under CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/), asking for credit to its author and that link.

**SRD 5.2.1** (CC BY 4.0), from the PDF whose SHA-256 `scripts/srd-import.ts` pins, read through the same text extraction: D20 Tests, Difficulty Class and the Typical Difficulty Classes table (page 6), Saving Throws, a save's DC, and choosing to fail one (page 7), "a Charisma (Deception or Persuasion) check" (page 8), the Skills table (page 9), Passive Perception (pages 22 and 186), ending a grapple with "a Strength (Athletics) or Dexterity (Acrobatics) check" (page 182), the grapple's "Strength or Dexterity saving throw (it chooses which)" (page 190), and the condition and status texts already in `shared/srd/rules-text.json` for the roll reminders (Blinded, Deafened, Paralyzed, Petrified, Stunned, Unconscious, Restrained, Exhaustion, Poisoned, Frightened, the Dodge action, Haste, Rage, Bless, Bane, Hex, Heroic Inspiration).

**Fastify.** The per-route `logLevel` option (Fastify's `docs/Reference/Routes.md` in the installed 5.12.5), which a research agent confirmed writes no request lines with `'silent'`.

**The postgres image.** The pinned digest `sha256:b0f9560a…` run on 2026-10-14: user `postgres` is UID and GID 70, and `pg_dump` is 17.11.

**Time zones.** Node 24 accepts `UTC` in `Intl.DateTimeFormat` while `Intl.supportedValuesOf('timeZone')` does not list it (checked by two reviewers).

**CSS `zoom`.** Shipped by Chrome and Safari for years and by Firefox in version 126 (2024), from MDN's compatibility data as remembered, not checked today. Its behavior on iOS for fields and overlays is section 7's risk 2.

**The code.** Every statement about the app as it is comes from the deployed wave 3 at commit `b508323`, the wave 4 integration workspace and the live-play fixes workspace (`openvtt-lp3int`), read by the author, five research agents and four reviewers.

## 11. Review dispositions

Adopted means the doc now does what the finding asked. Changed means it is resolved another way. Declined says why.

### Round 1

- D5-F-1 adopted: a display's connection keeps role `'player'`, with a `display` flag read only where a display differs, tested with a DM's drag under fog and a drag's path (section 3.1).
- D5-F-2 adopted: the backup budgets the image copy, stops at the floor as a partial run, and README gives sizing (sections 3.17, 7).
- D5-F-3 adopted: Leave deletes the grant and the session and clears the cookie, and a display session ends 30 days after it last connected (section 3.1, question 13).
- D5-F-4 adopted: letters match as undo does, by `key` for Latin letters and `code` otherwise (section 3.14).
- D5-F-5 changed: a derived `party` flag on every player-class projection of a token, true exactly when a player owns it, instead of `kind` or `aboveFog`, which reviewers showed are each inexact (section 3.1).
- D5-F-6 adopted as D5-P-11: log export limits per member and room, with a loose per-address cap (sections 2.4, 3.10).
- D5-F-7 adopted: the Log panel gains an Export button (section 3.10).
- D5-F-8 adopted: 5G's lines in `FightAlerts` (`InitiativeStrip.tsx`) and `SidePanel` (`Room.tsx`) are named with their owners (section 4).
- D5-F-9 adopted: the Hex reminder stays general, since the effect stores no ability (section 3.3).
- D5-F-10 adopted: the pinned image's UID 70 was checked, and the service runs as root with no capabilities on purpose, with the reason and a readability check (section 3.17).
- D5-F-11 adopted: a player's undo or redo that puts a drawing back needs the drawing permission (sections 2.6, 3.9).
- D5-F-12 adopted with the reviewers' correction: after a redirect CSP checks the host alone, the server's path rule is the real check, and a failed preview names Openverse (section 3.13).
- D5-F-13 declined: the export stays the stored state and the import drops open requests, which section 2.5 now says.
- D5-F-14 adopted: a display reads images through its own route, limited to its projected visible set, never the uploader rule, the library listing refusing it, with the tests named (section 3.1).
- D5-F-15 adopted: the session listing is cached per room seq and member and shares the export's limit (section 3.10).
- D5-P-1 adopted: a request holds one or two choices, each an ability with an optional skill, a skill fills in its usual ability, and the typical DCs are offered for checks (section 3.3).
- D5-P-2 adopted: after Send the card folds into a chip, requests stack newest on top, and the DM has "Close all answered" (section 3.3).
- D5-P-3 adopted: "works offline" stated as needing no outside service, the index preloaded so an offline pick queues and draws initials, and question 15.
- D5-P-4 adopted: Blinded, Deafened and Heroic Inspiration added, Exhaustion shown as its number, the Dodge and Rage caveats added, Hex general (section 3.3).
- D5-P-5 adopted: a tap on an open handout or X-card closes it and nothing else (section 3.1).
- D5-P-6 adopted: the outliner and party bar close the phone's sheet before framing, and "Pin to the map" closes it with a hint and Cancel (sections 3.2, 3.4, 3.7).
- D5-P-7 adopted: the party and the default targets are defined once (section 3.3).
- D5-P-8 adopted: the party bar says players see names, conditions and whatever HP the DM allows (section 3.4, question 10).
- D5-P-9 adopted: symbols match by `key` with Shift allowed, tested across layouts (section 3.14).
- D5-P-10 adopted: the credit says what was changed, cropped only when the crop is not the whole image (section 3.13).
- D5-P-11 adopted: limits the table spends are keyed per member and room, with loose per-address flood caps, and section 2.4 says why.
- D5-P-12 adopted: the TV draws pins linked to pages shared with all (sections 2.1, 3.1, 3.8).
- W5-ASTRA-01 adopted as D5-F-14 (section 3.1).
- W5-ASTRA-02 adopted: sessions and counts come from rows projected for the caller, tested with hidden rows (section 3.10).
- W5-ASTRA-03 adopted: the X-card authenticates with `lookup` only, and the no-write test covers `sessions` (section 3.11).
- W5-ASTRA-04 adopted: a page's deletion makes its pins DM only in the same op, and a pin from a restricted page starts DM only (sections 3.7, 3.8).
- W5-ASTRA-05 adopted: the deletion barrier reads the staged state and drops asset facts read before a deletion, tested in both races (section 3.19).
- W5-ASTRA-06 adopted: every file deletion goes through a trash folder purged after 48 hours, so a backup in progress always finds the file (sections 3.17, 3.19).
- W5-ASTRA-07 changed: each dump's list of images keeps every kept dump's images in one folder, so a restore copies one folder, with the drill restoring an older dump (section 3.17).
- W5-ASTRA-08 adopted: pins join `tileDependents` beside labels and stamps, tested through exploration (section 3.8).
- W5-ASTRA-09 adopted: a time zone is accepted when a formatter constructs with it, `UTC` included (section 3.10).
- W5-ASTRA-10 adopted: the claim that `setPinned` fixes the CLI is dropped, and the CLI's delayed pin is listed as unchanged (sections 3.18, 8).
- W5-ASTRA-11 adopted: a session's purpose decides, never its cookie's name, so every ordinary route treats a display session as none, tested by cookie substitution (section 3.1).
- W5DATA-01 adopted in its second form: "Open on this device" is described as running in the DM's trusted browser, its guarantee being what the display page draws, and "Add a TV" is the way to a display that holds nothing of the DM's (sections 3.1, 7).
- W5DATA-02 adopted as D5-F-14 (section 3.1).
- W5DATA-03 adopted as W5-ASTRA-02 (section 3.10).
- W5DATA-04 adopted as W5-ASTRA-04 (sections 3.7, 3.8).
- W5DATA-05 adopted as W5-ASTRA-05 (section 3.19).
- W5DATA-06 adopted: the trash covers the race, and a run is good only when every image its dump lists was copied (section 3.17).
- W5DATA-07 adopted as W5-ASTRA-07 (section 3.17).
- W5DATA-08 adopted as D5-F-2: free space is checked before the dump and before the copy, the image bytes budgeted, and a partial run keeps the last good backup (section 3.17).
- W5DATA-09 adopted: the size guard checks a room-level op against the room-level part plus the largest scene's own part, tested with two scenes (section 2.4).
- W5DATA-10 adopted as W5-ASTRA-03 (section 3.11).

### Round 2

Findings reopened from round 1:

- D5-F-5 reopened and adopted: the `party` flag reads owners of kind player (`anyPlayer`), since `playerOwned` counts a DM owner too, and wave 4's fog rule keeps its own reading (section 3.1).
- D5-F-15 reopened and adopted with W5DATA-14 and W5DATA-18: the cache key gains the role, and every request is charged (section 3.10).
- D5-P-10 reopened and adopted with W5DATA-17: "Converted to WebP" always, "Resized" only when the stored size differs (section 3.13).
- W5-ASTRA-05 reopened and adopted: the deletion step flushes and awaits the commit, then checks committed references, with a deletion generation read before the fact lookup (section 3.19).
- W5-ASTRA-11 reopened by W5DATA-11 and adopted there: every display route names the session it takes (section 3.1).
- W5DATA-05 reopened and adopted as W5-ASTRA-05 (section 3.19).
- W5DATA-06 reopened by W5DATA-13 and adopted there: copies go through `.part` files checked by length (section 3.17).
- W5DATA-08 reopened by W5DATA-16 and adopted there: the dump has a hard write limit (section 3.17).
- W5DATA-09 reopened by W5DATA-15 and D5-F-17 and adopted there: every whisper counts in the room-level part, and every scene's own part is measured at load (section 2.4).

New findings:

- D5-F-16 adopted as W5DATA-12: deleted ids are kept exactly while a lookup older than them is outstanding, a bounded record instead of a set for the room's lifetime, tested with a lookup stalled past a naive prune (section 3.19).
- D5-F-17 adopted: every scene's own part is measured once at load and kept with its growth bound, named in 5A's `sizeGuard.ts` line (sections 2.4, 4).
- D5-F-18 adopted: the pin pane turns DM only on when a restricted page's link is dropped or changed, unless the DM turns it off in the same save, and shows who will see the pin, and the summary is narrowed to match (sections 1, 3.8).
- D5-F-19 adopted: both switches default on, and question 12 keeps asking the project owner with the trade-off (section 3.3).
- D5-F-20 adopted: an open display socket renews its session, and the 60 s recheck closes one whose session is gone or expired with `4001` (section 3.1).
- D5-F-21 adopted as D5-F-5 (section 3.1).
- D5-F-22 changed: the list's format is stated and `scripts/backup-check.ts` checks it against `variantFileName` and `variantPath`, without prescribing the script's parsing (section 3.17).
- D5-F-23 adopted: the list is written from the `.part` dump before the rename, and only the `backup_runs` row says good (section 3.17).
- D5-P-13 adopted with W5-ASTRA-14: the DM's card marks a changed answer, and question 12 states the trade-off (section 3.3).
- D5-P-14 adopted: pins from "Pin to the map" start visible and are gated by their page, and the deletion rule stays (sections 3.7, 3.8).
- D5-P-15 adopted as D5-F-5 (section 3.1).
- D5-P-16 adopted: a save offers the DC field without the typical-DC chips (section 3.3).
- D5-P-17 adopted with the confer's correction: the sender's device shows "Sending…", then "Not sent: no connection. Try again." or, for a 429, "Not sent. Try again in a moment." (section 3.11).
- D5-P-18 adopted: the 2.8 MB is all glyph paths in one JSON file with gzip at level 9, 6.6 MB uncompressed, as measured (section 3.12).
- D5-P-19 adopted as W5DATA-17 (section 3.13).
- W5-ASTRA-12 adopted as W5DATA-11 (section 3.1).
- W5-ASTRA-13 adopted as W5DATA-13 (section 3.17).
- W5-ASTRA-14 adopted: with the DC hidden and pass or fail shown, an answer is final once it has a result, a change goes through the DM, who can reopen it, and the DM's card marks changed answers (section 3.3).
- W5DATA-11 adopted: minting takes the ordinary DM rule, redeem takes any caller and makes the display session, and `display/me`, the image route, Leave and the `as=display` socket take only a display session, tested with only the DM cookie and with no cookie (section 3.1).
- W5DATA-12 adopted: a per-room deletion generation, separate from the room seq, is read before `loadAssetFacts` and compared in the queue step, with outstanding lookups tracked, tested with a stalled lookup and no room op between (section 3.19).
- W5DATA-13 adopted: each image copy goes to `<name>.part`, is compared by length with its source and renamed, completeness compares lengths, and `.part` files are removed at a run's start, tested with an interrupted copy and another run (section 3.17).
- W5DATA-14 adopted: the log cache is keyed by room seq, member and role, tested in both request orders with one member holding both grants (section 3.10).
- W5DATA-15 adopted: every whisper in the in-memory log counts in the room-level part, tested with two DMs whose whisper histories differ (section 2.4).
- W5DATA-16 adopted: the estimate falls back to `pg_database_size`, and `pg_dump` writes through `head -c <budget + 1>`, so a dump over its budget fails, is removed, and leaves the last good backup (section 3.17).
- W5DATA-17 adopted: the original and stored sizes are recorded, and "Resized" is said only when they differ (section 3.13).
- W5DATA-18 adopted: every listing and export request is charged the same, cached or not, tested with and without hidden ops between (sections 2.4, 3.10).

### Round 3

Findings reopened from round 2:

- D5-F-16 and W5DATA-12 refined by W5DATA-22: the deletion barrier keeps only deleted ids an older outstanding lookup asked for (section 3.19).
- D5-F-23 replaced by W5-ASTRA-16, W5DATA-19 and W5-ASTRA-18: a completion record on the backups volume, written last, says a dump is good, and `backup_runs` is only a log (section 3.17).
- W5DATA-16 refined by D5-F-24: the `head` pipe is gone, and the budget is a file size limit on pg_dump itself (section 3.17).

New findings:

- D5-F-24 adopted: `pg_dump` runs under `ulimit -f` writing straight to its `.part`, its own exit status is required, and `pg_restore --file=/dev/null` reads the whole archive back, tested with a killed dump, a failure below the budget and a dump past it (section 3.17).
- D5-F-25 adopted: every scene's own part is measured at load from one pass over the stored entities grouped by scene, in the same pass as the room's size (sections 2.4, 4).
- D5-F-26 adopted, with the Codex confer's addition: a display session is renewed while open only when its expiry is under 29 days away, about one write a day, and its expiry is set to 30 days ahead when its last socket closes, so it ends exactly 30 days after that (section 3.1).
- D5-F-27 adopted as D5-F-24: writing straight to a file keeps the archive seekable, so reading the asset rows needs no full scan (section 3.17).
- D5-F-28 adopted: after a restore onto a new database the admin page warns until the next run rebuilds `backup_runs` from the completion records, and README's restore steps say so and end with `backup.sh once` (section 3.17).
- D5-P-20 adopted: the folded chip reads, as plain text, "Final. Ask the DM to change it." (section 3.3).
- D5-P-21 adopted, with the Codex confer's addition: finality is defined only for a request with a DC that is hidden while pass or fail is shown, and on a request with no DC a replacing answer clears the obsolete mark into `previous` while keeping a result it supplies itself ("Fail without rolling" or a DM's replacement mark), all tested (section 3.3).
- W5-ASTRA-15 adopted as D5-F-24 (section 3.17).
- W5-ASTRA-16 adopted: retention reads the completion records, which a run writes last of all, and always keeps the current run, tested with the first backup and a run with new images (section 3.17).
- W5-ASTRA-17 adopted: one `flock` lock on the backups volume, shared by the scheduled loop and `backup.sh once`, taken before cleanup and held through retention, with names to the second plus a run id, tested with a manual run during a copy (section 3.17).
- W5-ASTRA-18 adopted with the confer's refinement: the dumps exclude `backup_runs`, retention trusts only the completion records, and each run rebuilds the table from them, tested with backup A, backup B, a restore of A and a new backup that keeps B restorable (section 3.17).
- W5DATA-19 adopted as W5-ASTRA-16 (section 3.17).
- W5DATA-20 adopted as W5-ASTRA-17 (section 3.17).
- W5DATA-21 adopted as D5-F-24 (section 3.17).
- W5DATA-22 adopted: each outstanding lookup registers the ids it reads, and a deletion keeps only those of its ids that an older outstanding lookup asked for, tested with one stalled lookup while unrelated images are deleted again and again (section 3.19).

### Round 4

Findings reopened from round 3:

- D5-F-26 refined by W5-ASTRA-20: renewal applies only to a live session (section 3.1).
- D5-P-21 refined by W5DATA-23: the player's projection carries `dcHidden`, so the chip can tell a hidden DC from none (section 3.3).

New findings:

- D5-F-29 adopted: reading the deletion generation and registering the lookup's ids are one synchronous step before the lookup's first `await` (section 3.19).
- D5-F-30 adopted: the `backup_runs` row is inserted as "running" at a run's start and finished at the log step, and a row an earlier run left "running" is marked failed at once, while the completion records stay the only truth for retention (section 3.17).
- D5-F-31 adopted: the lock is held through the log step (section 3.17).
- W5-ASTRA-19 adopted: `backup.sh restore <dump name>` holds the backup lock from checking the dump's completion record through the database restore and the image copy, and releases it before the final `backup.sh once`. README's restore steps use it, and a scheduled run that finds the lock held waits for its next scheduled time, tested with a restore overlapping a backup that would prune the chosen dump (section 3.17).
- W5-ASTRA-20 adopted, with the confer's addition: renewal is conditioned on `expires_at > now()` in the update itself, and a close with code `4001` renews nothing, tested with an expired session that stays unusable after its last socket closes (section 3.1).
- W5DATA-23 changed, by Opus's confer: instead of a per-target `final`, a request with a hidden DC carries `dcHidden: true` in a player's projection, never the number, the card reads "DC hidden", the chip derives "Final" from `dcHidden`, `resultShown` and a result, and the reducer still enforces finality, tested with DC 15 hidden and no DC through the projection and the chip (sections 2.1, 3.3).

### Round 5

- D5-F-32 adopted: `backup.sh restore` runs in a `restore` compose service behind a profile as UID 1000 with no capabilities, the image volume writable at the app's path and the backups volume read-only, so every restored folder and file is the app's, and the nightly service creates the lock file readable by all so the restore can take it. Tested on an existing and a fresh image volume with an upload into a restored folder, a cleanup to the trash, and every folder owned by UID 1000. With the Codex confer's addition: on a new server README's restore starts with `docker compose up -d` once, so the app's image creates the image volume owned by `node` and the app applies the schema, and the restore refuses, writing nothing, when the volume's root is not UID 1000's, with the drill covering a fresh server (section 3.17).
- W5-ASTRA-21 adopted as D5-F-32 (section 3.17).
- W5DATA-25 adopted as D5-F-32 (section 3.17).
- W5-ASTRA-22 adopted: the restore releases the lock and returns, and README's order is then start `raccoon`, wait until it is healthy (schema applied, `backup_runs` exists), then `backup.sh once`, tested against a fresh database (section 3.17).
- W5DATA-24 adopted as W5-ASTRA-22, with Fable's confer refinement: `db/schema.sql` stays the only definition of `backup_runs`, and a run that finds the table missing stops at once with "The database has no backup log yet. Start raccoon first, then run backup.sh once.", writes nothing and releases the lock, tested beside the documented order (section 3.17).
