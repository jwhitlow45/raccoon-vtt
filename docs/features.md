# raccoon-vtt feature set

A self-hosted virtual tabletop for D&D groups playing the 2024 rules (5.5e). One server hosts many groups, each campaign in its own room. Square grid, 5 ft per square. Mobile first, and it also works on tablets and desktops. Exposed to the internet through a Cloudflare tunnel.

It suits a group playing in person, each with a phone at the table, and players who join from elsewhere. Players roll their own dice or use the D&D Beyond app, so there is no dice roller. The one exception is the DM's auto initiative for monsters (section 10).

This list comes from research into Owlbear Rodeo 2.4, Foundry V14 with dnd5e 6.x, Roll20, AboveVTT, D&D Beyond Maps, Shard, Alchemy, EncounterPlus, Improved Initiative, Fantasy Grounds, PlanarAlly, dungeon-revealer, Mythic Table, Dungeon Scrawl and Dungeondraft, plus the SRD 5.2.1 rules text and the community's most requested features. Ideas are borrowed, never code.

Tiers:

- **MVP**: needed for the first real session.
- **v1**: high value, built right after the MVP works at the table.
- **Later**: worth doing once the core is solid.
- **Skip**: not planned. The reason is in the last section.

## 1. Rooms, access and security

**MVP**

- A room is one campaign. It holds scenes, tokens, characters, notes and the initiative tracker.
- Anyone who can reach the site can create a room. The person who creates it becomes its DM.
- Each room has a short random ID (for example `K7QH-2MXA`) and a player password that the DM sets. The password needs at least 8 characters, and the form suggests a generated three-word passphrase such as `owlbear-druid-wand`, easy to type on a phone.
- The DM gets a secret DM link when the room is created:
  - Opening the link on any device makes that device a DM device. A new device is asked who it is: the same DM on a second phone or laptop picks "This is me" and carries on as the same DM, with the same whispers and undo, and a co-DM joins as someone new with a name. A player can never be picked there.
  - From a DM device, the DM can show a one-time QR code (valid 10 minutes) to add another device, or replace the link (which invalidates the old one and signs out every other DM device).
  - More than one person can hold DM (co-DM) by opening the link.
  - The DM sees a list of DM devices and can sign any of them out, and can take DM away from a co-DM. The list shows which devices are online now, keeps itself up to date while open, and an invite's card says when the invite has been used.
  - An "Enter a DM link or invite" box works inside the installed iPhone app, which cannot open links itself.
  - If every DM device and the link are lost, the server owner can issue a new link from the command line.
  - A DM device that is signed out, cut off by a replaced link, or no longer a DM is told so in DM terms and offered the DM link box right there, as well as joining as a player.
- Because room creation is open, it is limited:
  - A few new rooms per IP address per day, and 20 a day across the whole site.
  - A storage quota per room.
  - A free Cloudflare Turnstile check on the create form, if the server owner enables it.
- Players join with room ID and password, then pick themselves from the player list (so a new phone continues as the same player) or enter a new name and color. The list is shown only after the password is right. No accounts.
  - Built in the v1 design pass. Anyone, the DM included, changes their own color later from their row in Menu, Members: the same ten colors as joining, a color someone else uses marked with their initial, and the change shows at once in their buttons, pings, laser and rulers. Drawings, pins and areas already made keep their color.
- The DM hands out a player link that carries the password, with copy, share and a QR code for phones at the table. Opening it skips the password and goes straight to picking yourself. The password stays out of server logs and is cleared from the address bar. The DM can show the link and its QR code at any time from the DM panel, and the room menu's "Copy player link" copies it (the project owner's choice: the server keeps the password encrypted for this, beside the hash it checks joins with). Changing the password stops old links. A "Show password" option is there for anyone who would rather type it. A room made before the server kept the password shows its link again after one password change.
- A device is remembered by a secure session cookie. Rejoining never asks for the password again.
- The Home page lists the rooms this device has been in, checked with the server each time it opens: whether the device is still signed in there, and as whom. The installed app and "Leave room" land there, so nobody retypes a room ID. After the DM deletes a room, Home says so.
- Hidden things never leave the server. Players never receive hidden tokens, monsters and map labels standing under the fog, DM notes, monster stats or the DM's unpublished fog, so the screen, a reload and browser devtools all keep them secret. The log never tells players what happened to a creature while they could not see it, even after it is revealed. The map image itself is sent whole (section 11).
  - Built in v1 wave 3. Stamps the DM hides or that stand fully under the fog, lights, the map's other phases and their names, and scene folders and thumbnails never reach players either.
  - Built in v1 wave 4. On a scene with party vision, creatures out of the party's sight never reach players, and neither do the lights or what the DM's own fog says apart from the explored ground. The server alone works out what the party sees, so a phone never holds anything it could look behind.
  - Built in v1 wave 5. Journal pages not shared with a player, secret blocks the DM has not revealed, map pins that are DM only, under the fog or linked to a page the player cannot read, roll requests for other players' creatures, a DC or a pass or fail the DM hides, and the room monster a token was placed from never reach players. A table display receives only what a player who owns nothing receives, and none of the roll requests.
- Brute-force protection: password and DM link attempts are throttled per IP address, with growing delays. There is no per-room cap, so a stranger who knows a room ID cannot lock its players out (the project owner's choice). Instead, once a room sees many wrong passwords in an hour, joining it needs a free Cloudflare Turnstile check, if the server owner enables Turnstile.
- The DM can kick a player, change the player password (which signs out every player), and replace the DM link.
- Player list with online status and colors.

**Later**

- Join requests that the DM approves.

## 2. Devices, sync and connection

**MVP**

- Live sync over one WebSocket per device. The server holds the real state. Local edits show instantly and are confirmed by the server.
- Robust connection:
  - A heartbeat detects a dead connection within about 30 seconds.
  - Reconnect is automatic, with backoff.
  - Reconnect also fires right away when the phone wakes or the network returns.
  - After a reconnect, the device catches up from where it left off, with no reload.
  - Edits made while offline are queued and sent on reconnect.
  - A panel that cannot load, offline or after the site was updated, says so inside the panel, and the rest of the room keeps running. Panels load in the background once the room is connected, so they usually open offline too. A reload the app offers waits until the queued edits are saved.
  - A small connection dot shows the state, and a banner appears only after a few seconds offline.
- Other players' token drags are shown live, smoothed, at about 20 to 30 updates per second.
- Touch controls:
  - One finger uses the current tool. Two fingers pan and pinch-zoom.
  - Tapping a token opens a small action bar under it.
  - Nothing depends on long-press, because iOS Safari does not report it reliably.
  - A pinch anywhere but the map never zooms the page. A "Fit map" button brings the map back into view, and zooming out stops once the map fills half the screen.
  - Back on Android closes an open sheet, handout or token action bar before it leaves the room, and Escape closes the sheet or the token action bar.
- Installable from the browser (Add to Home Screen) for a full-screen app on iPhone. The screen stays awake during a session.
- Light on resources:
  - The map redraws only when something changes.
  - Phones get a downscaled map.
  - Images are re-encoded small.
  - No polling.

**v1**

- Keyboard shortcuts on desktop, beyond undo and redo (section 13).
  - Built in v1 wave 5. On any device with a keyboard: V, R, A, D and P pick Select, Ruler, Area, Draw and Ping, and the DM's T, M, F, B and G pick Add token, Pin, Fog, Builder and Grid. Arrow keys move the selected tokens a square, Page Up and Page Down raise or lower them 5 ft, and for the DM H hides, L locks and Delete deletes them. N moves the turn on, or ends a player's own turn. Plus, minus and 0 zoom and fit the map, the DM's / searches the scene, and ? shows them all, also under Menu, This device.
  - They never fire while typing in a field, while a dialog is open, or inside "View as a player", where Ctrl+Z no longer undoes the DM's real last change. Letters work on French, German, Cyrillic and Greek keyboards too.
- Low-power mode that renders at a lower resolution.
  - Built in v1 wave 5. Menu, This device, "Low power", off by default, draws the map at a lower resolution and skips small animations to save battery on long sessions: no easing on others' drags, a plain ring for pings, no fade on the laser, and the phone-sized map on every device. Text on the map looks softer.
  - The same page has "Map detail", phone size or full size images for this device, and the turn and ping sounds.

## 3. Scenes and maps

**MVP**

- Many scenes per room. The DM moves players to a scene. The DM can prepare a scene privately while players stay on another.
- Upload a map image. The server re-encodes it and makes a phone-sized copy.
- Adding or replacing the map image of the scene the players are on asks first, since they see it at once. A blank battle mat that gets its first image starts under fog, like a scene made from a map, and the DM can decline that in the same step.
- Two ways to use an uploaded map:
  - **Map already has a grid drawn on it.** The DM sets its scale so the app's grid matches the art: drag a 3x3 box over three squares, then fine-tune. Or type "cells across by cells down". The app's grid lines stay hidden, but snapping, tokens, rulers and areas all match the drawn squares.
  - **Map has no grid.** The same scale setting, then the app draws its own grid over the image.
- Grid style: color, opacity, line width, on or off.
- Blank grid scene with a background color, for an instant battle mat.
- Basic map builder on the grid:
  - Paint floor cells.
  - Draw rectangle and polygon rooms. Adjacent rooms merge into one floor.
  - Walls on cell edges, generated automatically around rooms.
    - Built in v1 wave 3. Each scene has an "Automatic walls" setting (the project owner's choice, 2026-10-14). "Around every painted cell" is the rule from before, which every blank mat keeps. "Around floor only" is for a scene made from a map image, so water, difficult ground or stairs painted over the art are not walled in. "Off" is for a Universal VTT import, which brings its own walls. Scenes from before keep their walls.
    - Walls and doors also go on the scene's east and south edges.
  - Doors: open, closed, locked and secret. Players see a locked door as closed, and a hidden secret door as exactly the wall they would see without it.
  - Terrain: water, difficult terrain, rubble, pits, pillars, stairs.
  - Windows on walls.
  - Text labels. A tap on one, in the builder's Label mode or with the Select tool, opens a small pane beside it (a bottom sheet on a phone) to change its text and size, or to delete it with a second tap to confirm. Changes apply on Done, as one step to undo. The builder's other modes keep a tap for building. In Label mode a drag moves a label. Players never see the pane.
  - Erase with a brush or a rectangle. Erasing takes everything in the cells: floor, walls, doors, windows and labels.
    - Built in v1 wave 3. Erasing also takes the stamps, lights and walls off the grid in the cells. Walls on the scene's east and south edges stay, and Remove or Clear takes them.
  - Undo and redo in the builder's own bar. On a desktop, a right, middle or Space drag moves the map while building.
  - A few floor textures: stone, wood, grass, cave and dirt.
  - The walls and doors are real data, so they can block movement and later sight.
    - Built in v1 wave 4. They do (section 11), and so do the raised areas below.
  - Raised areas and stairs (the project owner asked for areas "accessed via stairs up to it").
    - Built in v1 wave 4. The builder's "Heights and stairs" mode paints ground from 20 ft down to 100 ft up in 5 ft steps (raised from 30 ft after v1, holding − or + to step quickly) with the brush or a dragged area, and "Ground (clears)" clears it. Heights paint over a map image as well as over built floor, so a cliff drawn in a Dungeondraft map can be raised. Each raised region shows its height while the mode is on.
    - The Stairs brush marks stairs without painting terrain, so a stair can go over a map image. A stair points up toward its one higher neighbor by itself (Auto), and arrows for north, east, south and west settle the rest. A stair the rule cannot settle shows "?".
    - Raised ground looks raised: higher cells lighter, lower ones darker, each region casting a soft shadow down and to the right with a pale upper rim, and stairs draw treads lighter toward the top with a chevron at the high end.
    - A token standing on the ground rises or sinks with a height painted under it, or lands on what is left when the builder erases or clears that ground, and a token placed, dropped or duplicated on raised ground stands on it, its elevation badge saying how high. A duplicate of a creature on a platform, put down on the floor, stands on the floor.
- A default starting view for each scene.
- Switching scenes shows "Loading <scene>…" over the map, with the old scene still in view, until the new scene and its map image are in. Players moved by the DM see the same, and so does a first load or a reconnect. A busy server adds "Still loading…", and a switch or a map image that fails says so plainly.
- Export a scene's map as a PNG: the map image and the build, without tokens, drawings or fog. The DM picks 50, 70 or 100 pixels per square and the grid on or off (off by default, since a VTT that imports it draws its own). The player view shows secret doors as walls and leaves out the DM's marks and labels under the fog. The DM view shows everything. Very large scenes get a lower scale so the image stays within what an iPhone can draw. The file name carries the grid size, such as `crypt-30x20-70px.png`, so this app and other VTTs set the scale on import. On an iPhone it saves through the share sheet.
  - Built in v1 wave 3. The export draws stamps too. The player view leaves out the stamps players do not receive, and lights are never drawn.
  - Built in v1 wave 4. It draws raised areas and stairs, and the player view reads the fog players get, so labels and stamps on ground the party explored are in it.
- Import Universal VTT files (`.dd2vtt`, `.uvtt`, `.df2vtt`) from Dungeondraft, Dungeon Alchemist and DungeonFog. One file brings the map image, grid, walls, doors and lights.
  - Built in v1 wave 3. "From a Universal VTT file" in the Scenes panel reads the file in the DM's browser and shows what it found ("412 walls (380 on the grid, 32 free), 14 doors, 3 windows, 9 lights.") before it makes the scene. Walls on the grid become builder walls, and the rest are kept as walls off the grid, which block areas too.
  - Portals that don't block light import as windows by default, or as open doors with a switch in the dialog. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - Lights are stored and shown to the DM as small suns, with their reach in the builder's Lights mode. They light nothing until dynamic lighting (section 11).
    - Built in v1 wave 4. They light scenes with party vision, and the import proposes the scene's light level from the file: Bright for a map whose image is already lit, else by the brightness of its ambient light.
  - A phone takes files up to 40 MB and images it can resize, so large maps import on a computer. One undo takes the whole import back.
- Duplicate a scene. Scene folders and thumbnails.
  - Built in v1 wave 3. A scene's menu in the Scenes panel offers Duplicate. The copy, "<name> (copy)", goes right after the original in the same folder and opens. It always has the map and its phases, the build, labels, stamps and lights. Monsters, NPCs and objects come along by default. Player characters, fog, and drawings with placed areas come only when the DM ticks them. Those are the design's recommended defaults, which the project owner approved on 2026-10-14.
  - "Move to folder…" files a scene under a folder header that folds with a tap, remembered on that device. Renaming a folder is one undo step.
  - Each scene's row shows a thumbnail of its map, build and stamps, drawn by the DM's device when the DM leaves a scene they changed, or with "Update thumbnail". Players never see folders or thumbnails.
- Map phases: alternate images (day or night, on fire) that keep tokens and fog in place.
  - Built in v1 wave 3. "Map phases" in the scene settings adds another image of the same map, from an image or a Universal VTT file, up to 8. A chip, or the Phase menu in the top bar on a wide screen, switches with one tap. Each phase must have the map's shape, so the grid lines up on every one.
  - Players get only the phase showing, never the others or their names. The old image stays up until the new one is ready, so nothing flashes.
  - Built in v1 wave 4. Each phase may bring a light level, so switching to Night can make the scene dark. A level set on the phase showing now applies at once. That is the design's recommendation, which the project owner approved on 2026-10-14.
- Stamps for the map builder: furniture, chests and trees, with rotation and tint.
  - Built in v1 wave 3. The builder's Stamp mode places pictures from a picker. It ships 46 stamps in the top-down look the project owner chose on 2026-10-14: Prime_8's trees and stones, Liosan's foliage and village elements, and Poly Haven furniture and rocks rendered from above, every author credited. There is no throne or altar.
  - The picker also offers any token image in the room's library, for anything the shipped set lacks. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - A placed stamp turns, resizes, takes one of 8 tints, flips, comes to the front, duplicates, hides from players or is deleted. Players never receive a hidden stamp, or one fully under the fog.

**Later**

- Several floors in one scene.
- Animated maps (webm).
- Dungeon generator.

## 4. Grid and measurement

**MVP**

- Square grid, 5 ft per square. Scale and unit can be changed.
- Diagonal rule set per room: every diagonal 5 ft (the 2024 rule, default), 5-10-5, or Euclidean.
- Tokens snap to the grid. Odd-size tokens snap to square centers and even-size tokens to grid intersections. Snap can be turned off for a drag (not built yet).
- Ruler:
  - Drag to measure.
  - Tap to add waypoints.
  - Shows the running total and each segment's length.
  - Players' rulers are shown to everyone in your color. The DM's ruler stays private until the DM shares it. A shared ruler that starts or ends on a creature players cannot see is not shown to them.
- Dragging a token measures automatically.
- Edge-to-edge distance between any two tokens, correct for creature size. It includes height when elevations differ (section 8).
- Speed colors while dragging: walking range green, Dash range yellow, out of reach red.
- Movement used this turn is tracked, and the remainder is shown.
  - The path walked, not a straight line (the project owner, 2026-10-13: "full path walked maybe makes more sense", since where a creature walked tells whether it could get there and helps work out opportunity attacks). Each drop of the active creature on its turn adds a leg, on a desktop and a phone alike, whoever moves it: its player or the DM. "Moved" is the total of the legs, by the room's diagonal rule and with climbing, so a creature that walks out and back has moved the whole way. Moves outside a fight, or of a creature whose turn it is not, add nothing.
  - The trail draws on the map: a dashed line through every stop, a dot at each corner, the ring where the turn began and the "Moved" pill. It shows which squares the creature crossed, for the table to judge opportunity attacks. Nothing detects them automatically.
  - The drag's green, yellow and red colors measure the path so far plus the leg being dragged.
  - "Undo move" and Ctrl+Z take back the last leg and put the token back on it, so a drag in three drops takes three undos (the project owner: "3 undos makes sense to me"). Walking back on purpose still counts as movement.
  - Forced movement doesn't count (the project owner: "yes forced movement should not count"). After a move, a "Doesn't count" button beside "Undo move", for the DM and the creature's owners, keeps the token where it is, leaves that leg out of the total and draws it faint: for a shove, Misty Step or a teleport. It stays lit while the leg doesn't count, a press on it lit counts it again, and it undoes like a move.
  - Players who do not own the creature get only the stops they could see, and read the trail and the distance from those, so neither tells them where it went out of sight.
- Permanent ruler (double-tap to keep it on the map).
- Range rings around a token, for example 30/60/120 ft.

**Later**

- Ruler counts difficult terrain from the map builder.
- True walking distance around walls.

## 5. Tokens

**MVP**

- Token kinds: player character, NPC, monster, and object or marker.
- Live-editable fields:
  - Name, with "hide name from players".
  - Image.
  - Size: Tiny (4 per square), Small, Medium, Large, Huge or Gargantuan, or a custom width and height.
  - HP, max HP and temporary HP. AC. Speeds.
  - Elevation.
  - Conditions.
- Ownership:
  - The DM edits everything.
  - Players edit and move only the tokens they own.
  - A DM setting, "Who can move any token", lets players also move every visible, unlocked token: no one (the default), every player, or the players the DM picks.
  - The server enforces all of this. A drag on a token you may not move says why, and a creature a player drags into the fog, which then vanishes for them, gets a note saying so. On a scene with party vision, one dragged out of the party's sight gets "Goblin 2 is out of the party's sight now." once the server answers the move, since a light it carries or a party member moved with it can keep it in sight.
- "Find my token" button.
  - It sits in a player's top bar beside Fit map. A press pans and zooms to their own token on the scene, and the next press goes on to the next one they own, their character first. With none on the scene, it says so.
  - The DM has none: a tracker row or following the turn already brings any creature into view.
- HP quick edit with math input: `-7`, `+5`, `=20`. Temporary HP is spent first.
- What players see of monster HP, set by the DM: nothing, a health label (Healthy, Bloodied at or below half, Dying, Dead), a bar, or the exact number.
- Disposition ring color: ally, neutral or hostile.
- Duplicated monsters are numbered automatically (Goblin 1, Goblin 2). The number shows on the map too: a token without a picture reads G1, G2, as in the tracker, and a name cut short keeps its number ("Gobl… 2"). A hidden name never sends its number to players.
- Names, condition chips and badges draw above every token and the fog, so a neighbor in the row below or the fog edge never hides a visible token's name.
- Hidden tokens are translucent for the DM and are never sent to players.
- Lock a token so it cannot be dragged. A locked token shows a padlock, and dragging it says it is locked. The action bar's Hidden and Locked buttons light up while the token is hidden or locked.
- Layers: map, objects, tokens, and DM-only.
- Rotation and facing.
- Dead or dying overlay at 0 HP. A creature that dies is no longer marked Unconscious.
- Select several tokens and move them as a group.
- Token notes: one for everyone and one for the DM only.
  - The DM and the token's owners write the one for everyone, and every player who can see the token reads it. The DM's note never reaches a player, owners included.
- Swap images in one tap, for Wild Shape or a disguise.
  - A token keeps up to 6 other images, picked and cropped like its own. One tap in the token's action bar or panel puts one on, and the image it wore takes its place in the list.
  - The DM and the token's owners swap them. Other players never receive the list, so a disguise's true face stays secret.
- Moving other players' tokens can be allowed for chosen players only: the DM's setting offers No one, Everyone, or a picked set of players, instead of only on or off.
  - A room that had the older switch on lets every player, and one that had it off lets no one.
- Name tag showing who is dragging a token.
  - Someone else's drag shows their name over the token in their color, like their pings and rulers.

**Later**

- Attached tokens (rider on a mount, torch on a character).

## 6. Token images

**MVP**

- Get an image by upload (camera roll on phones), clipboard paste, or pasting an image URL.
- Search the web from the image picker:
  - Type "goblin archer" and tap a result.
  - Uses Google Images through SerpApi's free plan (250 searches a month, 50 an hour), with safe search on.
  - The app checks SerpApi's own count of searches left and stops before the free limit. Repeated searches are cached.
- Crop to a circle with zoom and pan. The border takes the disposition color.
- Every image is fetched and processed on the server: size and type checked, resized to 512 px, re-encoded, metadata stripped.
- The image library in each room is reused across tokens.
- A monster's default image: set once, and every token of that monster placed afterwards starts with it (section 15).

**v1**

- Instant generic tokens from about 4,000 game-icons.net fantasy icons (CC BY 3.0). Works offline.
  - Built in v1 wave 5. The image picker's first tab, Icons, searches 4,180 icons by name and author ("goblin", "dragon head", "skull lorc"), and puts the one picked on a colored disk, one of 14 colors, with no upload and no search quota. The set is all of game-icons.net's, not only the fantasy ones, by 36 authors, every one credited. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - "Works offline" means it needs no outside service: the list of icons loads with the room, so a phone that lost its connection can still pick one, and the token shows its initials until the icon arrives. That reading is the design's recommendation, which the project owner approved on 2026-10-14.
  - An icon draws sharp at any zoom, and works anywhere an image does: a token and its other images, a character's portrait, a monster's default image.
- Openverse as a free second search source when the monthly SerpApi limit is used up.
  - Built in v1 wave 5. When SerpApi cannot search (no key, the month's searches used up, or a quota spent), the search goes to Openverse, and "Search Openverse instead" asks it on purpose. Results say "From Openverse: openly licensed photos and artwork. RaccoonVTT is not endorsed by Openverse." and each names its license. Images whose license forbids changes are left out, since cropping one into a token changes it.
  - A picked image keeps its credit, shown in the library and the token panel with what the app changed: "Goblins and a Troll by Dunechaser, CC BY-NC-SA 2.0. Resized and converted to WebP."

## 7. Conditions and statuses (2024 rules)

**MVP**

- The 15 conditions. Tapping one shows its 2024 rules text from SRD 5.2.1.
- Exhaustion levels 1 to 6, with a level badge: -2 per level to d20 Tests, -5 ft Speed per level, death at 6.
- Common statuses: Concentrating (with the spell name), Bloodied (set automatically), Dead, Dying with death save pips, Hidden, Flying, Dodging, Raging, Blessed, Baned, Hasted, Hunter's Mark, Hex, Heroic Inspiration, and Reaction used.
- Custom statuses: an emoji or letter, a color and a label.
- The quick Conditions grid in a token's action bar names each condition under its icon, so a touch screen needs no hover.
- At 0 HP the action bar says Dying, Stable or Dead, and a dying creature's owner fills in death save pips right there.
- HP entry goes back to Damage after setting temporary HP or a value, so the next hit is not taken as temporary HP.
- Readable on small tokens:
  - Icon chips sit along the token's top edge and grow and shrink with the map, never under 12 px. Chips with letters or a counter never draw their text under 11 px.
  - Names and HP scale with the map between 11 and 16 px, never cover another creature, and give way when crowded: HP first, then the name, with Bloodied or Dying kept longest. A Bloodied creature also gets an amber notch on its ring, and a picture token whose name gave way shows its number.
  - Overflow shows as "+3".
  - The full list is in the token's action bar and its initiative row.
- Durations:
  - "N rounds", or ending at the start or end of a chosen creature's turn.
  - They count down with the initiative tracker.
  - Everyone is notified when one expires.
- Concentration prompt when a concentrating creature takes damage. It shows the DC (the higher of 10 and half the damage, capped at 30), and the player reports pass or fail.
- A condition can be hidden from players, the creature's owner included. The log keeps it hidden too.
  - Only the DM hides one or shows it again. The DM's chips and lists show it dimmed with a dashed edge, and the DM's log marks its lines.
  - To its owner a hidden condition is not there: removing or changing it is refused as if it were missing.
- Number counters on status icons: an Exhaustion level, or a count anyone who may edit the condition sets on any condition, such as rounds or charges left. One tap counts it up or down.

## 8. Height and elevation

**MVP**

- Elevation in feet on every token. Negative values work for burrowing. Quick +5 and -5 buttons.
- A badge on the token whenever elevation is not 0 (for example "↑30"), visible to everyone.
- Rulers, token-to-token distances and areas of effect all account for elevation, using the room's diagonal rule.
- Creature height (from its size, editable), so a fireball can miss a creature flying above it.

**v1**

- A depth cue: the token's shadow drifts down and away as it rises.
  - Built in v1 wave 4. A token above the ground under it draws a soft shadow under its footprint, a thin rim showing down and to the right from 5 ft up and drifting further as it rises (0.2 square at first and at most 0.6 at 30 ft for a Medium creature, scaled up with a larger creature's width), smaller and fainter as it rises. A token on raised ground stands on it and casts none, so a platform never looks like flight, and neither does a token inside the ground.
- Painted elevation zones on the map, such as cliffs and balconies (moved up from Later for the raised areas the project owner asked for).
  - Built in v1 wave 4, as raised areas and stairs (section 3).
  - A walking token cannot cross the edge of a raised area except along a stair. A flier above the edge crosses it. Climbing and jumping stay the DM's move. That is the design's recommendation, stairs only both ways and for every rise, which the project owner approved on 2026-10-14.
  - A creature standing on raised ground stands at its height. One below the ground, after a height was painted over it, says so to its owners and the DM: "Inside the ground (10 ft below)", with "Stand on it".
  - A creature sees over a ledge no higher than its eyes and not onto a higher platform, and one in a pit cannot see out. A creature over a platform higher than the party's eyes is hidden from below, a dragon over a plateau included. The DM can mark such a creature always visible. That is the design's recommendation, which the project owner approved on 2026-10-14.

## 9. Areas of effect and targeting

**MVP**

- Shapes:
  - Sphere (radius).
  - Cylinder (radius and height).
  - Cone (53.13°, width equals length).
  - Cube (side).
  - Line (length and width, 5 ft wide by default).
  - Emanation (distance from the token's edge).
- Place an area freely, or cast it from a token:
  - The origin follows the rules: cones, lines and cubes start at the caster's edge, and emanations surround the caster.
  - Aim by dragging, or with a rotation handle on touch.
  - Rotation snaps to 15° or 45°, or is free.
  - A tap on a token casts from it, even when it stands inside a placed area. A placed area is picked by tapping its open ground or from the Areas panel.
  - A new area starts from the player's own selected creature, named in the options with a way to drop it, and never from an old selection. The DM taps the caster each time.
  - A placed area's name keeps clear of tokens, their chips and their names: above the area, else below it, else slid along either edge, and when it has nowhere clear to go it shrinks to one cut line. On a player's screen it keeps off fully fogged ground too, where the fog would cut it off.
- Live preview of who is hit:
  - Affected squares are shaded.
  - Tokens inside are highlighted.
  - A list reads "In area: Goblin 1, Goblin 2, Thorn (ally)".
  - The caster is left out of cones, cubes, lines and emanations unless you include it.
  - The preview is private until you place it, so you can test angles without cluttering everyone's screen.
- Areas stuck to a token: an emanation or aura attached to a token moves with it. Examples are Spirit Guardians, Conjure Minor Elementals and a Paladin's aura. The "who is inside" list updates live as tokens move.
- Placed areas persist. They can be moved, rotated, resized and deleted. Each one is visible to everyone or to the DM only, and records who cast it.
  - A picked cone, line or cube turns by a drag from its handle or from open map outside it (a press on another area picks that area). One cast from a creature also turns when dragged from that creature or from inside it, so it stays on its caster. A free one moves when dragged from inside or from its origin.
  - Only the DM and the area's owner change it. Anyone else who picks it sees its outline, shading, who is in it and Copy, but no grip to move or turn it and no button to change it (the project owner's choice).
- Spell presets from SRD 5.2.1: search "fireball" and get a 20 ft sphere. Others include Burning Hands, Lightning Bolt, Thunderwave, Cone of Cold, Spirit Guardians and Conjure Minor Elementals.
- Coverage rule, set per room:
  - **2024 rules (default):** a square counts when at least half of it is covered.
  - **Any overlap:** Xanathar's template method.
  - **Square center:** the Foundry method.
- When a creature counts as inside:
  - **Any of its squares (default).**
  - Its center.
  - Most of its footprint.
- Height aware: spheres, cylinders and emanations measure in 3D, so a flying creature can sit outside a fireball.
  - Built in v1 wave 4. An area put down on open map stands on the ground there, so a fireball dropped on a platform starts at the platform's height. Moved before it is placed, it keeps its height above the ground, a lift set with its Elevation included.
- Walls from the map builder block an area. Squares behind a solid wall are not hit.
  - Built in v1 wave 3. Walls off the grid from a Universal VTT import block an area too, even where they cross the builder's walls or each other.
- Damage the creatures in an area:
  - Select everyone in it.
  - Mark each save as pass or fail.
  - Apply full or half damage.
  - The DM confirms.
  - Built in v1 wave 2. The DM opens Damage on a placed area, from the area tool or the Areas panel. It lists everyone the area catches, hidden creatures included.
  - Players roll their own dice, so the DM types the damage the caster rolled, once for everyone as SRD 5.2.1 says. A creature that passes takes half, rounded down. Every creature fails until marked, and the dead are skipped.
  - Objects the area catches (a door, a cart) are listed too, after the creatures, since a fireball can burn them, but they are skipped until the DM marks one. "All fail" and "All pass" mark only the creatures.
  - Only the DM applies it, so no player ever sees a list with a hidden creature in it. A caster's player proposing it for the DM to confirm is not built.
  - It goes through the usual HP rules, so temporary HP is spent first and concentration checks follow. One undo takes it all back.
- Reminders for areas that hit creatures as they enter or end a turn inside, for example "Goblin 2 ended its turn in Spirit Guardians".
  - Built in v1 wave 2. Each area has its own reminders: when a creature enters it, starts its turn in it, or ends its turn in it. They are in the area tool's More options.
  - A spell preset turns them on where SRD 5.2.1 says the spell hits again: Spirit Guardians, Moonbeam and Cloudkill on entering and at the end of a turn, Web on entering and at the start, Stinking Cloud at the start, and others.
  - Entering means coming into the area during a turn of a fight, by the creature's own move or by the area moving onto it, as the 2024 wording counts both. A move that crosses an area and stops beyond it entered it on the way, each move counted as a straight line. Placing an area is not entering it.
  - An area whose spell hits "only once per turn" (Spirit Guardians, Moonbeam, Cloudkill and others) reminds about a creature once a turn, whichever comes first. Others remind once a turn for each: a creature that enters Grease and ends its turn there is reminded of both. The area tool's "Once a turn" sets it on any area.
  - Each reminder is a line in the log. The DM always reads it, and a player only for a creature and an area in their sight, never what happened out of it. The DM also gets a toast, and so do the players of the creature and of the area.
- Cones and lines in 3D, aimed up or down.
  - Built in v1 wave 2. A cone or line aims from straight down to straight up in 5° steps, in the area tool's More options, so a cone can reach a flier.
  - Who it catches is measured in 3D, as for spheres and cylinders, through each creature's whole height. The map shades and outlines what it covers seen from above.

## 10. Initiative and combat

**MVP**

- Building the tracker:
  - The DM adds the selected tokens, every token on the scene, or only visible ones.
  - Players add their own character.
- Entering initiative:
  - Players type in their own result from physical dice or the D&D Beyond app.
  - The DM rolls monster initiative and types the results in. Identical monsters share one row value if the DM wants.
  - Auto initiative (the project owner, 2026-10-13): the DM's device rolls monster initiative instead, modeled on D&D Beyond's map combat tracker.
    - By creature (the default, as D&D Beyond does it): identical monsters share one roll, and every other monster, a boss included, rolls its own. A monster added mid-fight takes its group's value. A row's options can ungroup them.
    - One each: every monster rolls its own.
    - All at once: one roll for every monster, so they all act together.
    - Each roll is a d20 plus the creature's initiative modifier, with advantage or disadvantage from its reminder. By default it rolls only monsters still waiting for a value, and a switch re-rolls them all. A row's options can roll one monster on its own.
    - The DM sees each roll's dice until dismissing them. Players see each visible monster's total, as if the DM typed it, never the dice or modifiers, and never a hidden monster's row.
    - The DM's last choice is remembered for the room on that device.
  - Reminders show who rolls with advantage or disadvantage. In 2024, Invisible gives advantage, and being surprised or Incapacitated gives disadvantage.
- Optional 2024 initiative score (10 + Dex modifier) for monsters, so no roll is needed.
- Sorted high to low. Ties are fixed by dragging rows.
- Round counter, Next and Previous. Previous is logged as taking back the turn, so a turn that starts again never reads as a repeated line. Before the DM presses Start, players read that the fight has not started.
- The active token gets a turn marker. The DM's view can follow the active token.
- Player view: turn order, names and conditions. Hidden combatants appear on their first turn: their row and token are revealed when their turn comes (a DM setting, on by default). Players then see a revealed creature as they see any creature: on a fog scene only on revealed ground, and with party vision only while the party can see it. While it acts out of their view, they see "Another creature's turn". Enemy HP follows the HP display setting.
- "Your turn" notice in the turn strip, which lights up on a player's own turn and never covers the map. Android phones vibrate. iPhones cannot, so they play a short sound when sound is on. Players get an End Turn button beside the strip on their own turn. There is no "Up next" for players: their order leaves out hidden and fogged creatures, so it could be wrong, and the server saying it would give away a creature they cannot see.
- Each row shows HP, AC (DM only) and condition chips. Tapping a row opens the same menu as tapping the token.
- Damage and healing:
  - Math input works here too.
  - One entry can apply to a multi-selection.
  - Temporary HP is spent first.
- At 0 HP, monsters are marked dead (a DM setting), and player characters get death save pips that the player fills in.
- Per-turn resources:
  - Reaction used clears at the start of the creature's turn.
  - Legendary Action pips refill at the start of the monster's turn.
  - Legendary Resistance uses per day.
  - An "in lair" toggle.
- A marker where the active creature stood when its turn began, with the path it has walked since and the distance moved along it (section 4). It clears when the turn ends. Players see it only for tokens they can see, so a hidden or fogged token's starting spot never reaches them, and of the path only the stops they could see.
- Optional turn timer: a DM setting, off by default, from 30 seconds to 10 minutes. Everyone sees the turn count down. At zero the device of whoever acts vibrates or chimes once and says time is up, and the clock counts the time past it. It never ends a turn.
- A strip across the top of phone screens: the current combatant large, the next few small.
  - On a phone it is a band of its own under the top bar during a fight, so the bar keeps the room name beside the DM's Undo and Redo or a player's chip.
  - Players see only the current combatant, or "Another creature's turn" (the project owner, 2026-10-13: there is no "Up next" for players, since their order leaves out hidden and fogged creatures). Only the DM's strip shows the next few.
- Encounter builder (first in v1), DM only: players never receive a saved encounter, only the tokens it places.
  - 2024 XP budgets (Low, Moderate, High).
    - From SRD 5.2.1's XP Budget per Character table, and each monster's XP from its own stat block (the lair's XP for one placed in its lair). A party of mixed levels adds each character's own budget.
    - The party is the room's player characters by their level, which the DM or the character's player sets on the character's card. A character without a level is named and left out, never guessed at. The DM can edit the party (how many at which level) for one encounter, and it is saved with it.
    - The builder shows the three budgets, the monsters' XP, and the lowest budget the encounter stays within.
  - Save an encounter and drop it onto any map.
    - Built from the SRD monsters and the room's own, with a count for each. Saved in the room and its backups, at most 50 creatures in one.
    - Placed on the scene the DM views, around the next tap or the middle of the view: each creature a token as if placed by hand from the monster browser (its monster's image, numbered duplicates), hidden from players if the DM asks. In a running fight its creatures can join the tracker, grouped like identical monsters. One undo takes it all back.
- Hold and Ready markers: a creature can be marked as holding a Ready action, with its trigger.
  - Hold means the same as Ready (the project owner, 2026-10-14), so this one marker is both.
  - It shows on the row and the token, and ends at the start of the creature's next turn.
  - Players see only that a creature no player owns readied, not its trigger (the project owner's decision). The DM and the creature's owners see the trigger, and a party member's is the whole table's. A creature only a DM owns counts as no player's. The DM's "Show the trigger to players" switch on the marker shows a monster's to everyone.
  - "It fired" spends the creature's Reaction. The DM and the creature's owner mark it, and a player may also mark their own creature's Reaction used.
- Combat log of HP changes, with undo: each HP change in a fight is logged with what was left ("Goblin 2 takes 7 damage, 3/7 left") in the tracker and the Log.
  - Players see only lines about creatures they can see, with numbers only where the HP display setting allows them.
  - The DM can take back any one of them, whoever made it, while the creature is as that change left it. Otherwise it is refused as changed since. The log says the DM took it back.

## 11. Fog of war, lighting and vision

**MVP**

- Manual fog:
  - A scene can start fully fogged.
  - The DM reveals or hides with a rectangle, polygon or brush.
  - "Reveal room" uses a map-builder room in one tap.
  - The DM sees the fog as translucent.
- The DM edits fog privately and pushes Reveal when ready. A live mode is also available. The publish button names what the draft does (Reveal to players, Fog for players, or both), and the brush widths read in feet.
- Fog is drawn on each player's device. Players are trusted with the map image, so it is not cut up on the server.
- Fog never flashes the map:
  - A player's map stays hidden until the fog has loaded.
  - If fog data is missing or broken, a player sees the whole scene as fogged.
  - So a reload, a reconnect or a slow phone never shows unrevealed areas.
- Hidden tokens, DM notes and DM-only drawings are still never sent to players.
- Monsters standing fully under the fog are not sent to players either, on scenes with fog turned on. They appear when the DM reveals their area. Player characters always stay visible to the party, drawn above the fog.
- Map labels fully under the fog are not sent to players either, so a "Trap" label stays secret until its area is revealed.
- New scenes start fully fogged when they have a map or a build, and with no fog when they are a blank battle mat.
- The DM can preview the scene as players see it.

**v1**

- Walls and doors block player movement, as a toggle:
  - Built in v1 wave 4. Each scene has "Walls and ledges block players' moves" in its settings, beside its Vision settings. It is on for every scene made from wave 4 on (a battle mat, a builder scene, a map image or an import) and off for scenes from before, until the DM turns it on. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - A player's drag stops at a wall, a closed door or a ledge: the token holds on the last spot before it, ringed in red with "Wall in the way" or "Ledge in the way", so a drag into a wall never bounces. A note says what stopped it ("Stopped at a wall. Drop at the corner first, then go on.", "Ledge in the way. Take the stairs." or "A door is in the way. Tap it to open."), with a faint ghost where the token was dropped. Going around a corner takes two drops.
  - A creature fits through an opening one size too small, as the SRD's narrow opening allows: a Large creature passes 5 ft doors and corridors and can stop squeezed in one, drawn full size over the walls while every rule counts it at its squeezed size (the project owner, 2026-10-14). A Huge one needs 10 ft and a Gargantuan one 15 ft. Nobody passes a wall, and a squeeze holds only in a real narrow space, never beside one wall in the open.
  - "Teleport here" on the note (the project owner, 2026-10-14), for Misty Step and anything else that passes walls or ledges: the walk to the wall is taken back and the token lands where it was dropped, as one move that does not count against its speed. The DM's devices show "Thorn teleported past a wall." and the DM's log keeps it. Players never see that line.
  - In a group drag, each token's own move is tested, and the ones stopped stay where they were, with a note.
  - The DM opens, closes and locks doors.
    - Built in v1 wave 4. With the Select tool a tap on a door shows a pill above it: Open or Close, Lock or Unlock, and for a secret door Mark found or Hide.
  - Players can open unlocked doors.
    - Built in v1 wave 4. A tap on a door the player can see shows Open or Close, and a token's action bar offers "Open door" or "Close door" while a door is within its reach, so a door never has to be hit exactly. Reach is 5 ft or one square, whichever is more, counting height, with a clear line to the door, so a creature flying above it does not reach. Otherwise: "Too far from the door." A locked door answers "It's locked." That reach is the design's recommendation, which the owner chose and the project owner approved on 2026-10-14.
  - The DM can always move through walls.
    - Built in v1 wave 4. The DM's moves are never stopped.
- Dynamic lighting and vision:
  - Built in v1 wave 4. A scene's Vision settings turn on "Players see only what their characters see" and set its light: Bright, Dim or Dark. Turning it on turns fog on too, since fog is what remembers explored ground.
  - Walls block sight.
    - Built in v1 wave 4. So do closed doors, secret doors not yet found and pillars, and raised ground above a creature's eyes. Windows let sight through.
  - Line of sight from each player character.
    - Built in v1 wave 4, as party vision (the project owner, 2026-10-14): every player sees what any party creature sees. The party is every creature a player owns, and any creature the DM marks "Shares sight with the party", such as an allied NPC. At most 12 lend sight on a scene, and the rest stay shown.
  - Darkvision.
    - Built in v1 wave 4, read from the creature's senses line, with blindsight and truesight, each up to 150 ft. Darkvision sees dim light as bright and darkness as dim in shades of gray, which the map draws blue-grey. Owners keep editing their senses, which the project owner decided is trusted (2026-10-14), and the DM sees what they set. The token panel says what the creature sees: "Sees in the dark to 60 ft".
  - Light sources with presets: torch 20/20, lamp 15/30, Light cantrip 20/20.
    - Partly built in v1 wave 3. A Universal VTT import's lights are stored, each with a bright radius and dim light beyond it of at most 120 ft, and the DM sees them as small suns. They light nothing yet, and placing or editing one by hand comes with dynamic lighting.
    - Built in v1 wave 4. The builder's Lights mode places a light with a tap (a Torch, or another SRD preset: Candle 5/5, Torch 20/20, Lamp 15/30, Hooded Lantern 30/30, Light 20/20, Daylight 60/60), and a tap on one opens a pane to change its radii, turn it on or off, choose whether walls cast shadows from it, or delete it. A drag moves it. A token's action bar offers Light (None, Candle, Torch, Lamp, Hooded Lantern, Light, Custom) to the DM and the token's owners, with Custom radii up to 120 ft each. At most 100 placed lights per scene. The DM cannot light or show a 21st token light on a scene, while a player's torch is never refused: past 20, the party's own lights light first and the DM's Vision settings say how many light nothing. Players see only a light's effect, never the light.
  - Explored areas are remembered.
    - Built in v1 wave 4. Ground the party has seen stays drawn, dimmed, with no creatures on it, and ground never seen stays under fog. The DM's own fog tools keep working: a reveal shows more, a hide makes players forget the area except where the party is looking now, and undoing a fog edit takes back only the DM's edit, never what the party explored since (the project owner, 2026-10-14). The DM sees explored ground like revealed ground, with a dotted edge.
  - Scene darkness level and shared party vision.
    - Built in v1 wave 4. Inside the party's sight the map is clear in bright light and darker in dim light, other creatures appear when they come into sight and vanish when they leave it, and their initiative rows follow them. The DM's own map stays fully lit, and a "Party sight" switch beside "View as player" veils what the party cannot see. Moving players to a scene where no party creature can see warns first.

**Later**

- Weather overlays.

## 12. Drawing, pings and annotation

**MVP**

- Tools: freehand, line, rectangle, circle, polygon, arrow and text. Color, fill, opacity and line width.
- Each player draws in their own color by default. A new player starts on a color no other member uses. Eraser, which finds a text anywhere on its letters and tells a player it erases only their own drawings. Undo your own drawings. The DM can clear everything.
- DM-only drawings.
- Ping a spot with sound (and vibration on Android). A DM "look here" ping moves the view of everyone on that scene.
- Laser pointer: a stroke that fades on its own and is never saved.
- Pings, the laser and other members' rulers show who made them, in their color.

**v1**

- Map pins linked to notes.
  - Built in v1 wave 5. The DM's Pin tool places a pin with a tap, and its pane sets a label, a linked journal page, a color and "DM only", and says who will see it ("Players who can read Old Map: Thorn"). A journal page's "Pin to the map" places one linked to the page. A tap on a pin opens its page, or shows its label.
  - A pin reaches a player only when it is not DM only, not under the fog, and its page, if any, is one they may read, so players never learn that a note exists where they cannot read it. A pin from the Pin tool starts DM only, and one from a page starts visible, so its page decides who sees it. Dropping or changing a pin's link to a page not shared with everyone turns DM only on, unless the DM turns it off again, and deleting a page makes its pins DM only.
- A per-player drawing permission.
  - Built in v1 wave 5. Room settings, Players, "Who can draw": No one, Every player (the default) or Chosen players. A player who may not draw keeps a Draw tool that only erases their own drawings, and one who loses it while drawing is told "The DM turned off drawing for you." Kept rulers, pings and the laser stay allowed. That is the design's recommendation, which the project owner approved on 2026-10-14.

## 13. DM tools and the DM vs player view

**MVP**

- The DM sees everything. Hidden things are translucent. There is a DM-only layer.
- View as a player: shows exactly what players see, with fog and without hidden things.
- A player chip in the top left of a player's screen, matching the DM's chip. It shows the player's name, with a dot and a border in their color. On a phone the room name gives way to it, as it does to the DM's Undo and Redo, down to its first few letters.
- "Bring everyone here" (one time) and "Follow me" (live).
- Pause or black out the players' screens, for a break or a dramatic reveal. Players then see only the pause screen: no map, panels, initiative or notices. Their devices are sent none of it either, so a reload or browser devtools shows nothing the DM sets up meanwhile.
- Undo and redo for DM edits. One brush stroke or one room is one step, and each undo or redo says what it took back. On a phone or a tablet they sit in the top bar.
- Ctrl+Z or Cmd+Z undoes, and Ctrl+Shift+Z or Cmd+Shift+Z redoes. They do nothing while typing in a text field.
- Players can undo their own token moves. An undo is refused when someone else has moved that token since.
  - The undo takes back the move alone, so damage or conditions added since stay. A player's own change of a token's elevation or facing undoes the same way, on its own, and so does their "Doesn't count" (section 4). On its turn, a creature's leg of the path goes with the move.
  - On a phone, the token's action bar offers "Undo move" right after a player moves it, or changes its elevation. Each press takes back one step, newest first, and then offers the one before it. It stops offering after any other undo or redo, a drawing, or a refused move, and it only ever takes back the move it shows. Ctrl+Z and the Draw tool's Undo work too.

**v1**

- Table display mode for a TV at in-person sessions: no UI, fog applied, follows the DM view or fits the map.
  - Built in v1 wave 5. In the DM panel's "Table display", "Add a TV" shows a code, valid for 10 minutes and once, to type on the TV after choosing "Set up a table display" on its Home page, with a link and a QR code too. "Open on this device" opens the display in a new window, for a laptop wired to the TV. A room has at most 4 displays.
  - The TV shows the players' scene as a player who owns nothing sees it, fog and party vision included, and nothing else: no bars, panels, notices, log, roll requests or initiative strip. It shows the pause screen, handouts shown to everyone and the X-card. A tap shows a small menu: Follow the DM, Fit the map (the default), "Show whose turn it is" (off by default), Full screen and Leave. Follow the DM shows the area the DM's device shows while "Show my view on the table display" is on there.
  - A display is not a player: it never shows on the roster, sends nothing, and has its own sign-in, so even a TV in a shared room holds nothing a player could not see. It shows in the DM devices list, where the DM can sign it out. It stays signed in until Leave, a sign out, a password change, or 30 days without connecting. That is the design's recommendation, which the project owner approved on 2026-10-14.
- Scene outliner: a searchable list of everything on the scene, with tap to focus.
  - Built in v1 wave 5. The DM's Outliner panel lists the creatures and objects, the map's stamps, labels, pins and lights, the areas, the drawings and every door, in groups that fold, each row saying what players get of it: "Hidden", "Under fog", "Out of the party's sight", "DM only", "Only Thorn", or for a secret door whether it is found. A search filters them all, and chips narrow it to one group. A tap frames the thing and selects it where it can be selected, so a token opens its action bar. On a desktop, / opens it with the search ready.
- Request a roll from players ("Dex save, DC 15").
  - Built in v1 wave 5. "Request a roll" in the party bar ("Ask the party") or a selected creature's action bar asks for a saving throw or an ability check, with a skill and one more choice the creature picks from ("Strength (Athletics) or Dexterity (Acrobatics)"), a DC or none, and a note. Two switches, both on by default, say whether players see the DC and whether they see pass or fail. That default is the design's recommendation, which the project owner approved on 2026-10-14.
  - Each player gets a card for their creatures with reminders from its conditions (Restrained has Disadvantage on Dexterity saves, Exhaustion 2 reduces the roll by 4, and others), types the total they rolled, or taps "Fail without rolling" on a save. The card then folds into a chip such as "Dex save: sent 17. Pass." No dice are rolled.
  - The DM sees a live card for each request with every answer, marks Pass or Fail where there is no DC or to overrule one, reopens an answer, and closes requests, all answered ones at once. Only the DM and the creature's player see an answer, and a display sees none. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - With the DC hidden and pass or fail shown, an answer is final once it has a result ("Final. Ask the DM to change it."), so changing totals cannot find the DC. Each answer is a line in the log.
- Party bar: AC, passive Perception and HP at a glance.
  - Built in v1 wave 5, for the DM only, since players do not receive other characters' AC and Passive Perception (section 15). Every character a player plays shows its portrait, name, HP with temporary HP and a bar, AC, Passive Perception and conditions, or Dying, Stable or Dead. From 900 px up it sits atop the side panel and folds to one line. On a phone it is the Party panel. A tap frames that character's token, and "Ask the party" requests a roll. A DM-only bar is the design's recommendation, which the project owner approved on 2026-10-14.
- Edit several selected tokens at once.
  - Built in v1 wave 5. With two or more tokens selected, the action bar sets conditions on all of them (lit when all have one, half lit when some do), raises or lowers them 5 ft, and requests a roll. For the DM it also hides, locks, adds them to the fight or deletes them ("Delete 6 tokens?" on a second tap), and More sets their ring, size, layer, image, what players see of their HP and names, whether they stay visible under fog, and their owners.
  - Each change applies to all of them or none, and one undo takes it back. A player gets only what they may do to every selected token. One HP entry for several creatures is also one undo step now.

**Later**

- Triggers and traps that run when a token enters an area.

## 14. Dice

Not built, except auto initiative for the DM's monsters (section 10). Players roll physical dice or use the D&D Beyond app. Wherever the app needs a result (initiative, saves against an area, death saves, concentration, and since v1 wave 5 a roll the DM requests), players type it in or tap pass or fail.

## 15. Characters and monsters

**MVP**

- Each token has a light stat card:
  - HP, AC, speeds (walk, fly, swim, climb, burrow).
  - Initiative bonus, passive Perception, senses.
  - Size, creature type and notes.
  - It is not a full character sheet.
- Who sees a stat card: the DM sees every card. A player sees and edits their own character's card. Other players see only the name, conditions and whatever HP the DM allows.
- Player characters live at room level. Tokens on different scenes point to the same character, so HP and conditions follow them everywhere.
- Monsters are independent copies.
- SRD 5.2.1 monster compendium, about 327 stat blocks:
  - Search, then drop on the map.
  - The token gets average HP (or the DM types a number), AC, speed, size, initiative and senses.
  - The DM can read the full stat block.
- Monster filters modeled on D&D Beyond's (the project owner, 2026-10-14), such as legendary, condition immunities, monster type and CR range, while a CR can still be typed into the search box:
  - A Filters button beside the search opens a sheet: CR range, creature type, legendary, has a lair, size, condition immunities, damage immunities, resistances and vulnerabilities, movement, senses and alignment. Each tap applies at once, and the sheet counts the matches.
  - A monster needs any one of the types, sizes or alignments picked, and every one of the rest: "immune to Charmed and Frightened" means both.
  - The filters that are on show under the search as chips, each removed with a tap, with "Clear filters" beside them and their count on the button.
  - The typed search keeps its words and its exact "cr 5", with three small changes: a size word also finds a "Medium or Small" block by its second size, "cr 05" matches CR 5, and "cr 1/" keeps meaning CR 1 until the 2 of "cr 1/2" is typed (the project owner's choice). A range types as "cr 1-5" or "cr 1/2-3", "cr 10-" means 10 and up, and "cr-5" means up to 5. The search and the filters combine.
  - The room's own monsters filter by the same fields. One that lacks a field, such as a homebrew creature type, matches no filter on that field.
  - The encounter builder's search has the same filters. They belong to the DM's device and are remembered per room.
  - Left out: habitat, source, mythic and partnered content, since the SRD has no such data. AC and HP ranges, save and skill proficiencies, languages and tags, to keep the sheet short on a phone. The typed search already finds a tag such as "devil" or "chromatic".
- Homebrew monsters by quick entry.
- Custom monster editor (the project owner, 2026-10-13, first in v1): the DM enters a full stat block from a sourcebook they own, such as the Monster Manual. It is kept in that room only and never ships with the app, because those books are not openly licensed.
- Paste stat block text, for example from the DM's own D&D Beyond copy, and have it parsed into the editor.
- A default image per monster (the project owner, 2026-10-13: "per monster images should be supported"):
  - The DM sets an image once for a monster, SRD or the room's own, from its stat block page or in the custom monster editor, with the same picker and crop as token images.
  - Every token of that monster placed afterwards starts with it.
  - "Apply to N tokens on this scene" puts it on that monster's tokens already on the scene the DM views, as one undo step. A token whose image was set by hand, such as a disguise, keeps it unless the DM includes it. So does a token a player plays, such as a druid's Wild Shape placed from the SRD.
  - It lives in the room and its backups. Only the DM sets it, and players see it only on tokens they can see.
- A link from a token to its owner's D&D Beyond sheet.
- A room setting, off by default: players can create their own characters (owned by themselves only, at most 3 each, with a portrait they uploaded) and place their tokens on the players' scene. The DM can still edit, take over or delete them.
  - Who may delete a character (the project owner, 2026-10-16): the DM, any character, and a player, one that player plays alone, whoever made it and whatever the setting says. The room does not record who made a character, so playing it alone is the rule. A character shared with another player stays the DM's to delete.
  - A player's delete takes what the DM's takes: every token of the character on every scene, its companions and its rows in the fight. It cannot be undone, since a player's undo holds only their drawings and moves, so the card says first what goes, counting only the tokens and rows that player can see and naming the rest in general words ("any token of it on another map"), and Delete asks for a second tap.
- Short and long rest buttons, which restore HP, reset uses and remove one Exhaustion level, as SRD 5.2.1 describes each rest.
  - Either rest needs at least 1 HP.
  - A short rest takes the HP the player's Hit Point Dice rolled. The app rolls no dice and keeps no count of them.
  - A long rest restores all HP, ends temporary HP, removes one Exhaustion level and resets Legendary Resistance and legendary actions.
  - The DM rests anyone, and the whole party at once. A player rests their own character.
  - Rests stay allowed during a fight. The rest section then says that rolling Initiative stops a rest, so the table chooses.

**v1**

- Full stat blocks.
  - Built in v1 wave 5, read as the full 2024 stat block on the token. That reading is the design's recommendation, which the project owner approved on 2026-10-14. A monster or NPC token's panel shows the DM its whole block, from the SRD or from the room's own monster it was placed from, and a tracker row's options open it. The token's own HP, AC and conditions stay its own.
  - Under the block: Edit for the room's own monster, "Copy to this room's monsters and edit" for an SRD one, and Detach. A token with no block offers "Attach a stat block", which picks one from the monster browser and changes none of the token's numbers. A block deleted from the room says so.
  - A player who plays an SRD creature, such as a druid's Wild Shape, sees its block too. A block from the room's own monsters never reaches a player, since it may come from a book the DM owns. Player characters keep their D&D Beyond link.

## 16. Chat, handouts and notes

**MVP**

- A log of chat messages and important events (HP changes, conditions, turn changes).
- Whispers to the DM or to one player. Only the sender and the recipients see a whisper.
- While the Log is closed, its button counts new messages, and a whisper to you shows a short notice.
- Handouts: the DM shows an image to everyone or to chosen players as a popup. A player can zoom into it, and one closed stays closed after a reload and opens again from the Library.

**v1**

- Journal pages in Markdown: DM-only, shared with all, or private to one player. Secret blocks the DM can reveal.
  - Built in v1 wave 5. The Journal panel lists pages in folders. The DM writes a page as blocks of Markdown, with a title, a folder and "Who can read it": DM only, Everyone or one player. "Add a secret" adds a block players never receive until the DM taps Reveal, and Hide takes it back. Saving an edit never changes what is revealed.
  - Players read the pages they may read, revealed secrets as ordinary text, and the Journal button counts pages new or changed since they last looked. Players do not write pages. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - Pages take headings, lists, quotes, bold, italic, tables and https links, never images or HTML.
- Session log export.
  - Built in v1 wave 5. The Log panel's Export lists the evenings in the log, a session being a run of lines with no gap over 4 hours, and "Everything". It saves a Markdown file named like `crypt-crawlers-log-2026-10-14.md`, with each line as the Log panel reads it, in this device's time. Everyone can export, and each file holds only the lines that person's Log shows, so it never tells a player when hidden things happened. A member exports or lists at most 10 times an hour per room.
- Anonymous safety card (X-card).
  - Built in v1 wave 5. "X-card" at the top of the Menu opens a card, and a tap on its large X sends it. Every device in the room, the sender's included, then shows "Someone tapped the X-card. Edit out what just happened, with no questions asked." with Dismiss, and the DM's adds "Pause the game". It shows on table displays and behind the pause screen too, where a player can still send one (an owner decision).
  - Nobody at the table, the DM included, can tell who tapped it: the app stores nothing about a tap, not even when the sender's device was last seen. A proxy or tunnel in front of the server, such as Cloudflare's, may still log each request's address. The X-Card is John Stavropoulos's, credited on the About page.

**Later**

- Ambient music and sound effects, synced.
- In-game calendar and time of day.

## 17. Look, feel and accessibility

**MVP**

- Dark theme by default. In a room, buttons and other accented controls take your own member color, made lighter or darker when needed so they stay readable and never look like the turn highlight or a disabled button. Elsewhere the accent is the crest's yellow. The crest's orange stays in the logo only. Optional light theme (not built yet).
- Every image that ships with the app (builder textures, condition icons, generic tokens) comes from an openly licensed source and is credited in the app. No AI-generated art.
  - Built in v1 wave 3. The map stamps too: CC0 and CC BY 3.0 sprites from OpenGameArt, and CC0 Poly Haven models rendered from above by a committed script, each source credited on the About page and in `CREDITS.md`.
  - Built in v1 wave 5. The 4,180 token icons too, from game-icons.net at a pinned version, CC BY 3.0 and a few CC0, with every author credited on the About page and in `CREDITS.md`, and each icon's author and license shown where it is picked.
- Large touch targets, 16 px inputs so iOS does not zoom, and room for the notch and home bar.
- On a phone each tool in the toolbar shows its name under its icon.
- Respects the operating system's reduced-motion setting.
- Conditions use icons and color together, never color alone, so they work for colorblind players.
- The browser tab title of a room is `RaccoonVTT · <room name>`, so room tabs are told apart from the home page's tab. It follows a rename. Home, the join page and every other page read `RaccoonVTT`.

**v1**

- UI scale setting.
  - Built in v1 wave 5. Menu, This device, "Interface size": 85%, 100% (the default), 115% or 130%. It scales the bars, toolbar, panels, sheets, dialogs, notices and the token action bar, and the names, chips and badges on tokens. The map keeps its own zoom. At a large size a narrow window gets the phone layout.

## 18. Data, backup and operations

**MVP**

- All data lives on the server: Postgres plus an image volume. Nothing important is kept only in the browser.
- Export a whole room to one file and import it again, for backups or moving servers.
  - Built in v1 wave 3. The export carries stamps, lights, walls off the grid, map phases, folders and thumbnails, and the import brings them into the new room.
  - Built in v1 wave 4. It carries heights, stairs and the party's explored ground too.
  - Built in v1 wave 5. It carries journal pages, map pins, who can draw, stat block links, icon tokens and Openverse credits too. Open roll requests are dropped on import, since they belong to a moment of play.
- Deployed with Docker Compose:
  - No published ports.
  - Internal-only networks.
  - A cloudflared tunnel, run as its own compose project, reaches the app.
  - An egress proxy is the only way out, used for image search.
- Resource limits on every container, a health check, and structured logs.

**v1**

- Scheduled automatic database backups.
  - Built in v1 wave 5. A `backup` service on the server dumps the database every night at 04:00 (`BACKUP_AT` and `TZ` change it), reads the whole dump back, and copies every image it names, keeping 7 daily and 4 weekly good backups on a backups volume. A run that fails or runs short of space keeps the last good backup and deletes nothing else, and it always leaves 2 GiB free.
  - README gives one command to back up now, the restore steps, the sizing, a drill to run once, and how to copy the backups off the server. The backups stay on the server's disk until the server owner copies them. That is the design's recommendation, which the project owner approved on 2026-10-14.
- Admin page behind the admin password: list rooms, delete rooms, see storage use.
  - Built in v1 wave 5. `/admin` exists only once the server owner sets `ADMIN_PASSWORD_HASH`, made by `node scripts/admin.ts hash-password`. It shows the image volume's and the database's use, the images waiting for cleanup, and the last backup, with a warning when no good one has run for 36 hours. It lists every room with its size, images, last activity and whether it is loaded, pinned or read-only.
  - It pins or unpins a room, and deletes one after its ID is typed, through the DM's own delete. It never shows a room's contents, links, password or members. Wrong passwords are throttled, and a session lasts 12 hours.
- Cleanup of unused images.
  - Built in v1 wave 5. Every day the server deletes scene thumbnails a day after they were replaced, and, once a week, image files no room names. The DM's image library marks the images nothing in the room uses "Not in use" and deletes them, one or all, on a second tap. Images nothing uses are not deleted on their own, since one may be a handout or a map the DM keeps for later. That is the design's recommendation, which the project owner approved on 2026-10-14.
  - A deleted image file waits 48 hours before it is gone, so a backup running meanwhile still copies it. An undo that would bring back a deleted image is refused, so no token ever shows a broken picture.

## 19. Skipped, and why

- **Voice and video chat.** The app is built for a group in the same room, and a remote player can join by Discord or a call.
- **Dice roller.** Players use physical dice or the D&D Beyond app. The one exception is the DM's auto initiative for monsters, which the project owner asked for later (section 10).
- **Full character sheet builder.** D&D Beyond does this well. Tokens link to it instead.
- **D&D Beyond import.** There is no public API, and scraping breaks its terms.
- **Macros, scripting and a plugin system.** Plugins are Foundry's biggest pain point. Features are built in instead.
- **Hex and isometric grids.** Every rule in the app, from movement to areas of effect, is built on squares.
- **Native apps.** The installable web app covers phones and tablets.
- **Non-SRD monsters and art** (Beholder, Mind Flayer and similar). The official sourcebooks are copyrighted and not openly licensed, so there is no legitimate source to ship them from. The project owner chose the custom monster editor (section 15) for monsters from books a group owns. Openly licensed third-party bestiaries (Tome of Beasts and similar) were offered and not chosen.

## 20. Architecture notes that shape these features

- **Server-authoritative state with per-viewer filtering.**
  - Each room's state lives on the server.
  - Every change is checked against the sender's role, applied, then sent to each viewer in the form that viewer is allowed to see.
  - When a token is hidden, players receive a removal. When it is revealed, they receive the whole token.
  - This is how hidden data stays private. Shared-document approaches (CRDTs such as Yjs) cannot keep secrets from players.
- **One rules module shared by the client and the server.** Distance, footprints, area coverage and initiative ordering live in one tested module, so the preview on your phone and the server's answer always agree.
- **Stack.**
  - Node 24 with Fastify 5 and WebSockets (`ws`).
  - React 19 single-page app built with Vite, Konva for the map, Zustand for client state.
  - Postgres 17, sharp for images, zod for message validation.
  - TypeScript 7 as a typechecker only. Node 24 runs the server's TypeScript directly, so there is no server build step.
- **Attribution.** SRD 5.2.1 content is CC-BY-4.0, so the About page carries Wizards' required notice.
