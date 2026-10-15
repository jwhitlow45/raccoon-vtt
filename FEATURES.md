# RaccoonVTT features

RaccoonVTT is a self-hosted virtual tabletop for D&D groups playing the 2024 rules (5.5e) on a square grid, 5 ft per square. It is made for phones first, and it works on tablets, laptops and a TV too. It suits a group around one table, players joining from elsewhere, or both. It has no voice or video chat: a group that plays apart uses a call of its own for that. One server hosts many groups at once, each in its own room. There is no dice roller: everyone rolls real dice or uses the D&D Beyond app and types in the result. The one exception is auto initiative, which rolls for the DM's monsters.

This page lists what RaccoonVTT does today, grouped by area. "The DM" means anyone who holds DM in the room, co-DMs included. [docs/features.md](docs/features.md) is the planning list: what is planned next, and what was skipped and why.

<!-- Keep this page current: update it in the same change that adds, changes or removes a feature. -->

## Secrets stay secret

- The DM sees everything. Hidden things show translucent or dimmed to the DM.
- Players' devices never receive what players may not see: hidden tokens, monsters and map labels under the fog, hidden stamps, lights, DM notes, monster stats, the DM's fog edits before they are published, the map's other phases, scene folders and thumbnails, DM-only journal pages, secrets not yet revealed, and creatures out of the party's sight. So even a reload or the browser's developer tools cannot show them.
- The log never tells players what happened to a creature while they could not see it, even after it is revealed.
- The map image itself reaches players whole, and each player's device draws the fog over it. A group has to trust its players with that.

## Rooms and joining

- A room is one campaign. It holds the scenes, tokens, characters, journal, log and initiative tracker.
- Anyone who can reach the site can create a room from the Home page. Whoever creates it becomes its DM and gets a private DM link, the way back in as DM. Save it before going on.
- Each room has a short ID, such as `K7QH-2MXA`, and a player password the DM sets, at least 8 characters. The form suggests a three-word passphrase such as `owlbear-druid-wand`, easy to type on a phone.
- Players join with the room ID and the password, then pick themselves from the player list, so a new phone carries on as the same player. Someone new joins with a name and a color. There are no accounts.
- Anyone, DMs included, can change their own color at any time: Menu, then Members, then Color on your own row. Your pings, laser, rulers and buttons change at once. Drawings, pins and areas you already made keep their color. Here and on the join page, a color someone else uses carries their initial ("DM" for a DM, or a count when several share it) and stays pickable.
- The player link carries the password, so opening it skips typing it. The DM can copy or share the link, or show its QR code for phones at the table, at any time from the DM panel or Members. "Copy player link" is in the Menu too. "Show password", beside the link, is there for anyone who would rather type it.
- A device stays signed in. Coming back never asks for the password again.
- Home lists the rooms this device has been in, and as whom. "Leave room" in the Menu goes back there.
- The DM can kick a player, change the player password and delete the room. A new password signs every player out and stops old player links.
- Creating rooms is limited: a few per address a day, 20 a day across the site, and a storage limit per room. The server owner can turn on a free, usually invisible human check (Cloudflare Turnstile) on the create form.
- Wrong passwords meet growing delays. Guessing cannot lock a room's players out. After many wrong passwords in an hour, joining that room with the password needs the human check, if the server owner turned it on.

### DM devices and co-DMs

- Opening the DM link on a device makes it a DM device. A new device asks who it is: "This is me" carries on as the same DM, with the same whispers and undo, and a new name joins as a co-DM. A player can never be picked there.
- A DM device can show a one-time QR code, good for 10 minutes, to add another device.
- The DM devices list under Members shows every DM device and table display, which are online, and Sign out for each. The DM can also take DM away from a co-DM.
- Replacing the DM link signs out every other DM device.
- "Enter a DM link or invite" on Home works in the installed iPhone app, which cannot open links itself.
- If every DM device and the DM link are lost, the server owner can make a new DM link from the command line.

## Phones, tablets and connection

- Every change shows on every device at once, and your own edits show before the server confirms them.
- The connection mends itself. A dead connection is noticed within about 35 seconds. The app reconnects when the phone wakes or the network comes back, and catches up without a reload. Edits made offline are sent once it is back.
- A small dot shows the connection. A banner appears only after a few seconds offline.
- Other people's token drags move live, with their name over the token in their color.
- One finger uses the current tool. Two fingers pan and pinch-zoom. Nothing needs a long press.
- Tapping a token opens its action bar. On a screen 600 px or wider, or a phone on its side, it sits at the bottom right of the map instead of under the token. Drag it by its header, or press "Move bar" to send it to the next corner. This device remembers the spot, and "Reset bar position" puts it back. "Fit the map" keeps the map out from under it. On a phone held upright it spans the screen under the token. On a screen too short for either, it opens taller, over the Select several bar and if need be the toolbar. Close it to reach the toolbar again.
- A tap on empty map closes the action bar. Panning, pinching and holding a finger down to ping leave it open.
- The fight's alerts and a docked action bar share the right of the map without covering each other. Where there is no room for both, the alerts show as one row naming the most pressing one, and its tap hides the bar and shows them. Where the tool's options leave the alerts too little room for one whole card, as on a short phone with the Ruler, the same row stands for them, clear of the tool's buttons. Its tap opens a roll waiting for your answer, or shows the alerts over the tool's options until you tap elsewhere.
- On a phone held upright, an open sheet folds the token's action bar and the fight's alerts into one row on the sheet's top edge: a button with the token's name, its Close, and one button that names the most pressing alert and how many more wait. The token's name closes the sheet and brings the bar back as it was, a half-typed HP entry included. The alert button closes the sheet and shows the alerts, or opens a roll waiting for your answer. Where the screen is too short for that row, its buttons sit in the sheet's header.
- The fit button in the top bar ("Fit the map to the screen") brings the map back into view. A pinch anywhere but the map never zooms the page.
- Android's Back button and the Escape key close an open sheet, handout or action bar before they leave the room.
- On a phone, panels open as sheets from the bottom, and the toolbar names each tool under its icon. On a screen 900 px or wider, panels are tabs in a side panel.
- A page inside a panel, such as a journal page, a monster's stat block, an area's damage page, the encounter editor or a Menu page like Members, puts its own name at the top, with a back button that says where it goes, such as "Back to Journal".
- Add to Home Screen installs it as a full-screen app on an iPhone. The screen stays awake during a session.
- Phones load a smaller copy of each map, and the map redraws only when something changes.
- A panel that cannot load, offline or after the site was updated, says so inside itself, and the rest of the room keeps running.

## Scenes and maps

All of this is the DM's.

- A room holds many scenes. The DM moves the players to a scene, and can prepare another one privately while the players stay where they are. The Scenes panel marks the players' scene "Players here".
- A new scene is a Battle mat (a blank grid with a background color), a Map image, or a Builder scene. "From a Universal VTT file" brings in a whole map (below). Cancel folds the new scene form away, and during an upload it stops the upload and keeps the form.
- The server resizes and re-encodes uploaded maps and makes a smaller copy for phones. Changing the map image of the scene the players are on asks first, since they see it at once.
- "Line up the grid" fits the grid to a map that has one drawn on it: drag a box over 3 by 3 squares and fine-tune it by its corners, or type how many squares the image has across and down. Snapping, rulers and areas then match the drawn squares. A new map scene shows the app's own grid lines over the art, and "Grid lines" in the Grid tool or the Scenes panel turns them off for art that has its own.
- Grid lines take a color, opacity and line width, or hide. A scene's size in squares and its background color can change.
- Each scene can have a starting view ("Save current view").
- Switching scenes shows "Loading <scene>…" over the old scene until the new one and its map are in. Players moved by the DM see the same.
- Duplicate a scene from its menu, choosing what comes along: monsters, NPCs and objects, player characters, fog, and drawings and placed areas.
- Folders: "Move to folder…" files a scene under a header that folds with a tap. Each scene shows a thumbnail of its map, redrawn when the DM leaves a scene they changed, or with "Update thumbnail". Players never see folders or thumbnails.
- Map phases: up to 7 other images of the same map (8 in all), such as day and night or on fire, that keep tokens and fog in place. A chip, or the Phase menu on a wide screen, switches with one tap. A phase can bring its own light level, so Night can make the scene dark. Players get only the phase showing, never the others or their names.
- "Export as image" saves a scene's map as a PNG: the map image and the build, without tokens, drawings or fog. Pick 50, 70 or 100 pixels per square, the grid on or off, and the player view or the DM view. The file name carries the grid size, such as `crypt-30x20-70px.png` (with `-dm` added for the DM view), so other VTTs set the scale on import. A very large scene exports at fewer pixels per square, to stay within what an iPhone can draw, and says so. On an iPhone it saves through the share sheet.
- Universal VTT import: a `.dd2vtt`, `.uvtt` or `.df2vtt` file from Dungeondraft, Dungeon Alchemist or DungeonFog brings the map image, grid, walls, doors, windows and lights at once. It shows what it found before it makes the scene and suggests the scene's light level. One undo takes it all back. A phone takes files up to 40 MB, so large maps import on a computer.

## Building maps

The Builder tool is the DM's. Its modes:

- **Brush**, **Rectangle room** and **Shape room** paint floor, and rooms that touch merge into one floor. Floors come in stone, wood, grass, dirt and cave. Terrain comes in water, difficult ground, rubble, pits, pillars and stairs.
- Walls go up around rooms on their own. The scene's "Automatic walls" setting picks around every painted cell, around floor only (for terrain painted over a map image), or off (for an imported map that brings its own walls).
- **Walls and doors** draws a Wall, Door, Secret door or Window on a square's edge, marks an edge No wall, or removes it. Doors are open, closed, locked or secret. Players see a locked door as closed, and a hidden secret door as plain wall.
- **Erase** and **Erase area** clear everything in the squares: floor, walls, doors, windows, labels, stamps, lights and heights.
- **Heights and stairs** paints ground from 20 ft down to 100 ft up in 5 ft steps. Hold + or − to step quickly. It also marks stairs, which point up toward the higher side. Raised ground looks raised, lighter and casting a soft shadow, and stairs draw their treads. Past 30 ft the look stays the same, so tap the ground to read its height. Heights go over a map image too, so a cliff in a drawn map can be raised. A token placed, dropped or duplicated on raised ground stands on it.
- While Heights and stairs is open, each raised or lowered area shows its height in a pill, such as "↑10 ft". The pills grow and shrink with the map like token names. They draw under token names, condition chips, elevation badges and HP bars, and keep off them. A pill with no free spot at the current zoom shows again once zooming in gives it room.
- **Label**: type, then tap the map. Tap a label to change its text and size or delete it, or drag it to move it.
- **Lights**: a tap places a light (Candle, Torch, Lamp, Hooded Lantern, Light or Daylight), up to 100 a scene. Tap one to change its reach, turn it on or off, choose whether walls cast shadows from it, or delete it. Players see only the light it gives, never the light itself.
- **Stamp** places pictures: 46 shipped top-down stamps (trees, stones, foliage, village pieces, furniture and rocks) or any token image in the room's library. A stamp turns, resizes, takes one of 8 tints, flips, comes to the front, duplicates, hides from players, or is deleted.
- The builder's bar has Undo and Redo buttons, the same undo as everywhere else. "Clear the build" in the scene's settings removes all of the build.

## Tokens

- Token kinds: player character, NPC, monster, and object or marker.
- Each token has a name (which the DM can hide from players), an image, a size from Tiny to Gargantuan or a custom one, HP, maximum and temporary HP, AC, speeds, elevation, facing and conditions.
- The DM edits every token. Players move and edit the tokens they own. The room setting "Who can move any token" also lets no one (the default), every player, or chosen players move any visible, unlocked token. A drag that is not allowed says why.
- A player's top bar shows their own chip, their name in their color. On a phone the room name gives way to it, down to its first few letters.
- "Find my token" in a player's top bar jumps to their token. The next press goes to their next one.
- HP takes math: `-7`, `+5`, `=20`. Temporary HP is spent first.
- What players see of a monster's HP, set per token: nothing, a label (Healthy, Bloodied, Dying, Dead), a bar, or the exact number.
- A colored ring shows ally, neutral or hostile.
- Copies of a monster are numbered (Goblin 1, Goblin 2). A token without a picture shows its initials, G1, G2 or "AR" for Ash Rider, the same on the board, in the tracker and in the Characters and Monsters panels.
- Names, condition chips and badges draw above every token and the fog. They scale with the map and make way when crowded.
- Hidden tokens are translucent to the DM and never reach players. A locked token shows a padlock and cannot be dragged.
- A token sits on the creatures layer or the objects layer, under creatures.
- A token at 0 HP shows as dead or dying.
- Each token has two notes: one that everyone who can see it reads, written by the DM and its owners, and one for the DM alone.
- Up to 6 other images per token, swapped with one tap for Wild Shape or a disguise. Only the DM and the token's owners get the list.
- Range rings around a token, such as 30, 60 and 120 ft.
- A token can carry a light (Candle, Torch, Lamp, Hooded Lantern, Light, or a custom one), set by the DM and its owners. A scene lights up to 20 token lights. Past that the DM cannot light another, while a player's torch is never refused: the party's own lights light first, and the scene's Vision settings tell the DM how many light nothing.
- A character's token can link to its owner's D&D Beyond sheet.

### Several tokens at once

- Select several with Shift or Cmd and a click, with the "Select several" button, or with a box drag. Drag any of them to move them all.
- With Select several on, a tap on empty map hides the group's action bar and keeps the group, and "Actions" in the Select several bar brings it back. A tap on a token in the group takes it out. Done ends Select several and lets go of the group, and so do Escape and Android's Back while the bar is hidden.
- The group's action bar offers one HP entry for all of them, Conditions, and elevation up and down 5 ft.
- The DM also gets Request a roll, Hidden, Locked, Start a fight or Add to the fight (objects stay out of the fight), Delete, and More: ring color, size, layer, image, how players see HP, hiding names from players, "Always visible, even under fog", and owners.
- Each action shows only when you may use it on every selected token, except Request a roll and Start a fight or Add to the fight, which show when any of them can take part. A player who selected their own creatures gets conditions and elevation.
- A change to the whole group undoes as one step.

## Images and art

- The image picker gets an image five ways: Icons, Device (an upload, or the camera roll on a phone), Link (an image's web address), Search the web, and Library. Pasting an image from the clipboard works too.
- **Icons**: 4,180 game-icons.net icons, each on a colored disk, found by name or artist. Picking one needs no upload and no search, so it works when web search is used up, and once the icon list has loaded it works offline too. Each icon names its artist and license where you pick it.
- **Search the web**: type "goblin archer" and tap a result. It searches Google Images, with safe search on, while the server has a Google search key and searches left this month. Otherwise it searches Openverse's openly licensed images, and "Search Openverse instead" asks Openverse on purpose. An Openverse image keeps its credit (title, author, license and what was changed), shown in the library and the token panel.
- Crop to a circle with zoom and pan. The ring takes the disposition color.
- The server checks, resizes and re-encodes every image and strips its metadata.
- The room's library keeps every image for reuse. The DM's library marks images nothing uses as "Not in use" and deletes them one at a time or all at once ("Delete N not in use"), on a second tap. An image in use cannot be deleted. Undo cannot bring back a token or anything else whose image was deleted since.
- A monster's default image: set it once, and every token of that monster placed afterwards starts with it. "Apply to N tokens on this scene" puts it on the ones already there.
- Every piece of art that ships with the app is openly licensed and credited on the About page. None of it is AI generated.

## Conditions and statuses

- The 15 conditions of the 2024 rules. A tap shows each one's rules text from SRD 5.2.1.
- Exhaustion levels 1 to 6, with a level badge.
- Common statuses: Concentrating (with the spell), Bloodied (set on its own), Dead, Dying with death save pips, Hidden, Flying, Dodging, Raging, Blessed, Baned, Hasted, Hunter's Mark, Hexed, Marked, Surprised, Heroic Inspiration, Readied action and Reaction used.
- Custom statuses take an emoji or a letter, a color and a label.
- A token's action bar has a quick Conditions grid, each condition named under its icon.
- A status can carry a counter, such as rounds or charges left, that a tap counts up or down.
- Durations: a number of rounds, or until the start or end of a chosen creature's turn. They count down with initiative, and everyone is told when one ends.
- A concentrating creature that takes damage gets a prompt with the DC (the higher of 10 and half the damage, at most 30). Its player reports pass or fail.
- The DM can hide a condition from players, the creature's owner included. The log hides it too.

## Height and elevation

- Every token has an elevation in feet, negative for burrowing, with +5 and -5 buttons. A badge such as "↑30" shows whenever it is not 0.
- With Select, tap raised or lowered ground to see its height for a few seconds, such as "↑10 ft", or "Stairs" on a stair. Under the fog it shows nothing. Screen readers hear it too.
- Rulers, distances between tokens and areas of effect all count height.
- Creatures have a height from their size, so a fireball can miss one flying above it.
- A flying token's shadow shows from 5 ft up and drifts down and away as it rises, further for a larger creature.
- On raised ground from the builder, a walking token crosses an edge only by a stair, while a flier above it passes. A creature sees over a ledge no higher than its eyes, and one in a pit cannot see out.
- A token left inside the ground after a height change says so and offers "Stand on it".

## Measuring and movement

- Ruler: drag to measure, and tap to add waypoints. It shows the total and each segment's length. Players' rulers show to everyone in their color. The DM's stays private until shared. A double tap keeps a ruler on the map. A point on raised or lowered ground stands on it, so the distance counts the height. A player's ruler counts only ground they can see, and everyone reads the same numbers.
- Dragging a token measures as it goes: green within its walking speed, yellow within a Dash, red beyond.
- Tokens snap to the grid.
- Distance between two tokens counts from edge to edge, right for their sizes, and includes height.
- Diagonals follow the room's rule: every square 5 ft (the 2024 rule, and the default), alternating 5 ft and 10 ft, or true distance. Feet per square can change too.
- On a creature's turn its path is tracked. Each drop adds a leg, and the trail draws on the map with a ring where the turn began. "Moved" totals the whole path walked, which helps the table judge opportunity attacks. Nothing detects them for you.
- "Undo move" takes back the last leg. "Doesn't count" leaves a shove, Misty Step or a teleport out of the total.
- Players undo their own moves, newest first. An undo is refused when someone else has moved that token since.

## Walls and doors

- With the scene setting "Walls and ledges block players' moves" on, a player's drag stops at a wall, a closed door or a ledge. The token holds at the last free spot, with a note saying what stopped it. New scenes have it on.
- "Teleport here" on that note lands the token where it was dropped, for Misty Step and the like. It doesn't count against speed, and the DM's log notes it.
- A creature squeezes through an opening one size too small, as the rules allow. A Large creature fits a 5 ft door or corridor.
- The DM's moves are never stopped.
- With the Select tool, a tap on a door offers the DM Open or Close and Lock or Unlock, and Mark found or Hide on a secret door.
- Players open and close unlocked doors that their own token can reach, with a tap on the door or "Open door" in the token's action bar. A locked door answers "It's locked."
- Walls block areas of effect. Walls, closed doors and pillars block sight.

## Fog and vision

- A scene with a map or a build starts fully fogged. A blank battle mat starts with none.
- The Fog tool clears or adds fog with a rectangle, a polygon, a brush, or a whole builder room in one tap (the "Builder room" shape). The DM sees the fog as translucent.
- The DM edits fog privately and publishes it when ready. A live mode shows each edit at once.
- Fog never flashes the map. A player's map stays hidden until the fog has loaded, and missing fog reads as all fogged.
- Monsters and labels standing fully under the fog never reach players. Player characters always stay visible to the party.
- A creature a player drags under the fog vanishes for them, with a note saying so.
- "View as a player" shows the DM exactly what a chosen player sees.
- **Party vision.** The "Party vision" switch in a scene's Vision settings makes players see only what their characters see. The same settings set the light to Bright, Dim or Dark. Every player then sees what any party creature sees.
  - Walls, closed doors, secret doors not yet found, pillars, and raised ground above a creature's eyes block sight. Windows do not.
  - Darkvision, blindsight and truesight come from the creature's senses. Darkvision shows darkness in gray.
  - Lights from the builder and on tokens light the scene.
  - Ground the party has seen stays drawn, dimmed and without creatures. Ground never seen stays fogged.
  - Creatures appear when they come into sight and vanish when they leave it, initiative rows included.
  - The DM can mark a creature, such as an allied NPC, to share its sight with the party.
  - The DM's own map stays fully lit. The "Party sight" switch shades what the party cannot see.
  - Moving players to a scene where no party creature can see warns first.
  - A creature a player drags out of the party's sight vanishes for them too, with a note saying so once the server answers the move, since a light it carries can keep it in sight.

## Areas of effect

- Shapes: sphere, cylinder, cone, cube, line and emanation.
- Place an area freely, or cast it from a token: cones, lines and cubes start at the caster's edge, and emanations surround the caster. Aim by dragging or with a handle, in 15° or 45° steps or freely. Cones and lines can aim up or down.
- Spell presets from SRD 5.2.1: search "fireball" and get a 20 ft sphere.
- A private preview shades the squares and lists who is in it ("In area (3): Goblin 1, Goblin 2, Thorn (ally)") before you place it. The caster is left out unless you include it.
- Auras stick to a token and move with it, such as Spirit Guardians or a Paladin's aura. The list of who is inside updates live.
- Placed areas stay until removed. They move, turn and resize, and show to everyone or to the DM only. Only the DM and the area's owner change one.
- An area's name keeps clear of tokens and their names, and on a player's screen of fogged ground.
- Room settings choose which squares an area covers (at least half the square, which is the 2024 rule, any part of it, or its center) and which creatures it catches (any of their squares, their center, or most of their space).
- Height counts: spheres, cylinders and emanations measure in 3D. An area put down on a platform starts at the platform's height, and one moved before it is placed keeps its height above the ground.
- Walls block an area.
- **Damage** (DM): from a placed area, list everyone it catches, mark each save pass or fail, type the damage once, and apply full or half. Temporary HP and concentration checks follow, and one undo takes it all back.
- **Reminders**: an area can remind when a creature enters it, or starts or ends its turn in it, as Spirit Guardians, Moonbeam and Web need. Presets turn them on where the spell says. Each reminder goes in the log, and reaches players only for what they can see.
- A room setting decides whether players see each other's areas.

## Combat and initiative

- The DM starts a fight with the selected tokens, every token on the scene, or only the visible ones. Players add their own character with "Join the fight".
- Players type in their own initiative. The DM types in the monsters', or uses **Auto initiative**: by creature (identical monsters share a roll), one each, or all at once. Each roll is a d20 plus the creature's modifier, with advantage or disadvantage from its conditions. Players see the totals, never the dice.
- "Use initiative scores for monsters" gives them 10 + their Dexterity modifier instead of a roll.
- The order runs high to low. Dragging rows settles ties. A round counter, Start, Next and Previous run the fight.
- The active token gets a turn marker. With "Camera follows the turn" on, the DM's map pans to whoever acts. Players' maps stay where they are, unless the DM uses Follow me or Look here.
- Players see the turn order, names and conditions. With "Reveal hidden combatants on their turn" on, a hidden creature appears when its first turn comes, but only where players could see it: on revealed ground, and with party vision only while the party can see it. While it acts out of their view, they see "Another creature's turn".
- A strip across the top of a phone shows whose turn it is. On a phone held sideways it sits in the top bar when the bar has room for it. Only the DM's strip shows who comes next. On their own turn a player gets "Your turn" in the strip, a vibration on Android or a chime, and an "End turn" button.
- Rows show HP, conditions and, for the DM, AC. Tapping a row opens the same menu as tapping the token.
- Damage and healing take math, and one entry can apply to several creatures. "Players can apply damage and healing" lets players do it too.
- At 0 HP, monsters die ("Monsters die at 0 HP") and characters get death save pips that their player fills in. "Skip defeated creatures" passes over the dead.
- Per-turn resources: Reaction used clears at the start of the creature's turn, Legendary Action pips refill, Legendary Resistance counts uses per day, and an "in lair" switch.
- A Ready marker (Hold is the same thing) records the trigger and shows on the row and the token until the creature's next turn. Players learn only that a monster readied, not its trigger.
- The combat log keeps each HP change ("Goblin 2 takes 7 damage, 3/7 left"). The DM can take any one back while the creature is still as that change left it.
- An optional turn timer, from 30 seconds to 10 minutes. It never ends a turn.
- "End the fight" ends it.

### Encounter builder

- The Encounters panel (DM) builds an encounter from SRD monsters and the room's own, with a count for each.
- It shows the 2024 XP budgets (Low, Moderate, High) for the party, from each character's level, and which budget the encounter fits. The DM can change the party for one encounter.
- Saved encounters drop onto any map, hidden from players if the DM asks. In a running fight their creatures can join the tracker. One undo takes it all back.
- With unsaved changes, the editor's back button asks "Discard changes?" first, and a second tap leaves.

## Rolls

The DM asks players for a saving throw or an ability check, and each player types in the total they rolled.

- "Request a roll" is in the action bar of one or several creatures that players play. "Ask the party" is in the party bar.
- Choose Save or Check, then the ability. A check can name a skill, which fills in its usual ability. "Or…" adds a second choice, such as "Strength (Athletics) or Dexterity (Acrobatics)", and the creature picks which one it rolls.
- Set a DC, or none. A check offers the typical DCs as chips, from Very easy (5) to Nearly impossible (30).
- Two checkboxes, both on at first: "Players see the DC" and "Players see pass or fail". With the DC hidden and pass or fail shown, an answer is final once it passes or fails, so changing the total cannot find the DC. The DM can reopen it.
- Add a note, such as "against the poison", and tick who rolls. "Ask the party" starts with the characters on the players' scene ticked, or every character when the DM is looking at another scene. If the server refuses the request, the sheet stays open with everything set and the reason. Closing the sheet while the request is sending does not stop it, and a refusal that comes after shows as a message.
- The player's device shows a card, with a vibration on Android or the turn chime. It says what to roll, the DC or "DC hidden", and reminders from the creature's conditions, such as Restrained's disadvantage on Dexterity saves or an Exhaustion penalty. The reminders only remind. They decide nothing.
- The player types the total and taps Send. A save also offers "Fail without rolling". The card then folds into a chip, such as "Dex save: sent 17. Pass." (with two choices it names the one rolled: "Str or Dex save: sent Dex 15. Pass."), which opens again to change the answer while the request is open. A card can also fold away to answer later. On a phone the chips fold into one button while a sheet covers the map, and otherwise only the newest two show, with a "Rolls" button that counts the answers (such as "Rolls 1/3"), shows the rest and folds them again. A card that would cover an open sheet on a phone folds too, into a "Roll asked" button that closes the sheet and opens the card again, with any total typed into it kept. On a phone a card at the screen's foot stands on the tool's options, such as the Select several bar, and the token's action bar keeps above it. Where the screen is too short for the card's question, Later and total, or for both it and the bar, the card folds, and a "Roll asked" row at the top of the map stands for it. Its tap, like a chip's, hides the bar, keeping the token or group selected, and opens the card over the tool's options, rising to the screen's top where it needs the room, with its question, Later, total and Send in reach at once, until it is answered or put off with Later.
- The DM's live card shows each creature waiting, or with its choice, total and pass or fail. Pass and Fail mark a roll with no DC, or overrule one. "Reopen for one more answer", Close, and "Close all answered" finish it. On a phone the DM's cards start folded to one line, only the newest two show, with a "Rolls" button (such as "Rolls 1/3") for the rest, and all of them fold into one button while a sheet covers the map.
- Only the DM and the creature's player see an answer, and its log line. With pass or fail hidden, a Pass or Fail mark from the DM adds no line to the player's log, unless it only repeats what the answer already said.
- No card shows on a player's screen while the game is paused.

## Characters and monsters

- Every token has a light stat card: HP, AC, speeds (walk, fly, swim, climb, burrow), initiative bonus, passive Perception, senses, size, creature type and notes. It is not a full character sheet.
- The DM sees every card. A player sees and edits their own character's card. Other players see only the name, conditions and whatever HP the DM allows.
- Player characters belong to the room, so their HP and conditions follow their tokens to every scene. Monster tokens are independent copies.
- "Players see the party's HP" shows every player the exact HP of the other player characters. Off, they see only Healthy, Bloodied or Dying.
- The Characters panel lists the party. With "Players can create their own characters" on, each player can make up to 3 and place their tokens on the players' scene. The DM can still edit, take over or delete them.
- Short rest and Long rest follow the SRD. A short rest adds the HP the player rolled on Hit Point Dice. A long rest restores all HP, ends temporary HP, removes one Exhaustion level and resets legendary uses. The DM can rest the whole party at once.
- The Monsters panel (DM) holds all 330 SRD 5.2.1 stat blocks. Search, then drop one on the map with average HP (or a typed number), AC, speed, size, initiative and senses.
- Filters like D&D Beyond's: challenge rating, creature type, legendary, lair, size, condition and damage immunities, resistances, vulnerabilities, movement, senses and alignment. Or type it in the search: "cr 5", "cr 1-5", "cr 1/2-3", "cr 10-".
- Custom monsters: the DM enters a full stat block from a book the group owns, or uses "Paste a stat block" to read pasted text into the editor. They stay in that room only.
- Full stat blocks on tokens: a monster or NPC token's panel has a Stat block section for the DM, with abilities, saves, skills, senses, languages, CR, traits, actions, bonus actions, reactions and legendary actions. Edit opens a room monster in the editor, and an SRD monster offers "Copy to this room's monsters and edit". "Attach a stat block" links a token that has none, and Detach unlinks it. A tracker row's options open it too.
- A player whose token is an SRD monster, such as a druid's Wild Shape, can read its SRD block. A room monster's block never reaches players.

## DM tools

- "View as a player" shows exactly what a chosen player sees.
- "Follow me" makes players' maps follow the DM's as they pan and zoom. "Bring everyone here" moves them once. A ping with "Look here" on moves every player's view to that spot.
- "Black out players' screens" for a break or a reveal. Players see only a black screen that says "The DM has paused the game." Meanwhile their devices receive nothing from the game but the X-card. When the game resumes, each player's selected token, its action bar and any HP typed into it and not applied come back as they were.
- Undo and Redo for the DM's changes, each saying what it took back. On a phone or a tablet they sit in the top bar.
- **Outliner**: a panel listing everything on the scene in view, in groups that fold: Creatures and objects, Map (stamps, labels, pins and lights), Areas, Drawings, and Doors. Each row says what players get, such as Hidden, Under fog, Out of the party's sight, DM only, or a secret door hidden or found. The search filters as you type. A tap shows the item on the map and selects it.
- **Party bar**: each player character's portrait, HP with temporary HP and a bar, AC, passive Perception, and up to three conditions, or Dying, Stable or Dead. On a wide screen it sits above the side panel and folds to one line. On a phone it is the Party panel. A tap jumps to that character's token and opens its action bar.

## Journal and map pins

- The Journal panel holds pages in folders. The DM writes them, and picks who can read each one: DM only, Everyone, or one player.
- Pages use Markdown: bold, italic, headings, lists, numbered lists, quotes and https links.
- A page is made of blocks, and any block can be a secret. Players don't see a secret until the DM taps Reveal on it, and Hide takes it back. Revealed secrets read as ordinary text.
- When a page a player can read is new or changes, the Journal button shows a dot and the page reads "New" or "Updated".
- **Map pins**: the Pin tool (DM) places a pin with a tap. Its pane sets a label, a linked page, a color and "DM only", and says who will see the pin. If the server refuses a change, the pane keeps it and says why. Drag a pin to move it. A page's "Pin to the map" places a pin linked to that page.
- Players see a pin only on their scene, out of the fog, and when they can read its linked page. Deleting a page makes its pins DM only.
- With the Select tool, a tap on a pin opens its page, or shows its label when it links none, until a few seconds pass or the next tap elsewhere on the map.
- A room holds up to 200 pages, and a scene up to 200 pins.

## Log, chat and handouts

- The Log holds chat and the important events: HP changes, conditions and turns.
- Whisper to the DM or to one player. Only the sender and the recipients see a whisper.
- While the Log is closed, its button counts new messages, and a whisper to you shows a short notice.
- **Export** in the Log saves it as a Markdown file, one evening or all of it. A gap of more than 4 hours starts a new evening. Everyone can export, and the file holds only what that person's Log shows. On an iPhone it saves through the share sheet. Listing the evenings and each export count toward 10 an hour per person.
- **Handouts** (DM panel): show an image to everyone or to chosen players as a popup. Players can zoom in, and anyone shown a handout can download it with the popup's Download button, saved under the handout's title. On a phone that can share files, Download opens the share sheet instead, to save the image to Photos or Files or send it on. A closed handout stays closed after a reload and opens again from the Library.

## Drawing, pings and the laser

- The Draw tool: freehand, line, rectangle, circle, polygon, arrow and text, with color, fill, opacity and line width. Everyone draws in their own color by default.
- Players erase and undo their own drawings. The DM can clear everything and can make drawings DM only.
- "Who can draw" in Room settings: no one, every player (the default), or chosen players. A player who may not draw keeps the drawings they made. While they have some on the scene, their Draw tool offers only the eraser and "Clear mine". Rulers, pings and the laser stay for everyone.
- **Ping**: tap a spot to ping it, with a sound and a vibration on Android. The DM's "Look here" moves every player's view there.
- **Laser**: drag with the Ping tool for a stroke that fades on its own and is never saved.
- Pings, the laser and rulers show who made them, in their color.

## The table display

Show the players' view of the map on a TV at the table, with nothing else on screen.

- The DM sets it up from the DM panel's Table display section:
  - "Add a TV" shows a code of 10 letters and numbers (such as `K7QH 2MXA 4F`), a link and a QR code, good once and for 10 minutes. On the TV's browser, "Set up a table display" on Home takes the code.
  - "Open on this device" opens the display in a new window, for a laptop wired to the TV. The window draws only what players get, but the laptop is still signed in as the DM.
- The display shows the players' scene as players see it: the map, the fog, party vision, tokens, shared areas, drawings, pins (except those linked to a page not every player can read), and pings and rulers. It shows no bars, panels, chat, roll requests or initiative strip.
- It also shows the pause screen during a blackout, handouts shown to everyone, the X-card, and "Waiting for the DM to choose a scene" when there is none.
- A tap, a click or any key shows a menu for 5 seconds: Follow the DM, Fit the map, "Show whose turn it is" (off at first), Text size (85% to 130% for the names, chips and badges on the map), Full screen, and Leave. The display remembers these choices. While a handout or the X-card is open, a tap closes it instead.
- **Follow the DM** shows the part of the map a DM device shows, scaled to the TV. Turn on "Show my view on the table display" on that DM device. It follows only while the DM views the players' scene. Follow me, Bring everyone here and Look here move it too.
- **Fit the map** fits what players can see, the revealed ground and the party's tokens, and fits again when a reveal adds more.
- A display can't move or change anything, and it is not on the player list. A room can have up to 4.
- The DM devices list shows each display with Sign out. Changing the player password signs every display out. Leave, pressed twice on the display, signs it out for good. A display that has not connected for 30 days is signed out. A display shows one room: pairing it with another room, in another tab or window, signs it out of the first, which then says it now shows another room.

## Safety: the X-card

- "X-card" sits at the top of the Menu, for the DM and every player. A tap opens a small card, and a tap on its large X sends it, so a stray tap never does. Once it goes out, the sender's Menu closes, so their screen looks like everyone else's.
- Every device in the room then shows the same calm card, the sender's included: "Someone tapped the X-card. Edit out what just happened, with no questions asked." It shows on table displays too.
- Nothing covers the card. On a member's device, a handout the DM shows while it is up, or one that comes back when a pause ends, waits until the card is dismissed. On a table display the handout opens under the card, and a tap closes the card first.
- A player behind the pause screen still has the X-card there, and the card shows to them as to everyone.
- The DM's card adds "Pause the game", which blacks out the players' screens.
- Nothing about a tap is saved, not even in the log, so nobody at the table, the DM included, can tell who sent it.
- A tap within 10 seconds of a card joins that card instead of showing another. Each device can send the X-card up to 6 times an hour.
- The X-card is John Stavropoulos's safety tool, credited on the About page.

## This device

Menu, This device holds settings kept on this device alone:

- **Interface size**: 85%, 100%, 115% or 130%. It scales the bars, the panels, and the names and marks on tokens, and dialogs and panels still fit the screen at every size. The map keeps its own zoom.
- **Low power**: draws the map at a lower resolution, loads the phone size map, and skips small animations, to save battery on long sessions. Text on the map looks softer.
- **Map detail**: Phone size (up to 4096 pixels across, loads faster) or Full size (sharper on a large screen).
- **Turn sound** and **Ping sound**.
- "Show the keyboard shortcuts".

## Keyboard shortcuts

On any device with a keyboard. They do nothing while you type in a field or a window is open. On a Mac, Cmd works where Ctrl is written. `?` shows the list for your role.

| Key | Does | Who |
| --- | --- | --- |
| Ctrl+Z | Undo your last change | everyone |
| Ctrl+Shift+Z | Redo what you undid | everyone |
| V, R, A, D, P | Select, Ruler, Area, Draw, Ping | everyone (Draw only for players who may draw) |
| T, M, F, B, G | Add token, Pin, Fog, Builder, Grid | DM |
| Arrow keys | Move the selected tokens one square. Each press is a move, so walls stop it and it adds to the turn's path | anyone, on tokens they may move |
| Page Up, Page Down | Raise or lower the selected tokens 5 ft | anyone, on tokens they may change |
| H | Hide or show the selected tokens | DM |
| L | Lock or unlock the selected tokens | DM |
| Delete, Backspace | Delete the selected tokens. Ctrl+Z brings them back | DM |
| N | Next turn, or End turn on your own turn | DM, and players on their turn |
| +, - | Zoom in, zoom out | everyone |
| 0 | Fit the map | everyone |
| / | Search the scene in the outliner | DM |
| ? | Show the shortcuts | everyone |

With a mouse, the wheel zooms, and a drag with the right or middle button, or with Space held, moves the map. Escape closes a sheet or the token's action bar. While you drag the action bar, Escape puts it back.

On a focused side panel tab, Left and Right switch to the tab beside it, and Home and End to the first and the last. There, and on a focused choice or slider, the arrow and Page keys never move a token.

## Look and accessibility

- A dark theme. In a room, buttons take your own member color, adjusted so they stay readable.
- Large touch targets, 16 px text fields so an iPhone doesn't zoom in, and room for the notch and the home bar.
- Respects the system's reduced-motion setting.
- In a room, the browser tab reads `RaccoonVTT · <room name>`.

## Backups and moving a room

- Room settings, Backup: "Download a backup" saves the whole room as one .zip file, with every scene, token, character, journal page and image. At most 4 an hour.
- Home, "Import a room": "Import from a backup" makes a new room from that file, on this server or another, up to 95 MB. The server owner can import a bigger one from the command line.

## Running the server

For whoever runs RaccoonVTT. [README.md](README.md) has the setup steps and every command.

- It runs with Docker Compose behind any HTTPS reverse proxy or tunnel, such as Caddy, nginx or Cloudflare Tunnel, with no open ports. An outbound proxy is its only way to the internet, for image search and imports from a link.
- Google image search needs a SerpApi key. Openverse needs none. The Turnstile human check is optional.
- **Nightly backups**: every night (at 04:00 by default) a backup copies the database and the images it needs, then checks the copy. It keeps the newest 7 good backups and one from each of the last 4 weeks. A run that cannot finish deletes nothing, so the last good backup always remains, and every run leaves 2 GiB free on the disk. One command runs a backup now, and another restores one. The backups live on the same disk as everything else, so copy them off the server now and then.
- **Admin page** at `/admin`, off until the server owner sets an admin password:
  - Storage: the image volume, the database, the images on disk, the images waiting for cleanup, and the last backup and the last good one. It warns when the last backup failed or no good one has run for 36 hours.
  - Every room with its size, images, last activity and whether it is loaded, sorted by last activity or size.
  - Pin or unpin a room (a pinned room is never unloaded to make space), or delete one after typing its room ID.
  - It never shows what is in a room and cannot enter one. A session lasts 12 hours, and repeated wrong passwords close the login for a while.
- **Cleanup of unused images**: once a day the server deletes replaced scene thumbnails, and once a week image files nothing names. Deleted image files wait 48 hours first, so a backup that is running still finds them. Images in a room's library are deleted only by its DM (see Images and art).
- **Admin commands** on the command line list rooms, create a room past the daily limits, pin or unpin a room, replace a lost DM link, import a large room backup, and make the admin password's hash.
- The X-card leaves nothing in the app's data or its logs. The HTTPS front end's own request logs, such as a reverse proxy's access log or Cloudflare's, can still record each request's address, the X-card's included, as they do for every request.
