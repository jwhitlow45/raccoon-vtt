# RaccoonVTT features

RaccoonVTT is a self-hosted virtual tabletop for D&D groups playing the 2024 rules (5.5e) on a square grid, 5 ft per square. It is made for phones first, and it works on tablets, laptops and a TV too. It suits a group around one table, players joining from elsewhere, or both. It has no voice or video chat: a group that plays apart uses a call of its own for that. One server hosts many groups at once, each in its own room. Dice roll on the server, so everyone sees the same result. Anyone can still roll real dice and type the total.

This page lists what RaccoonVTT does today, grouped by area. "The DM" means anyone who holds DM in the room, co-DMs included. [docs/features.md](docs/features.md) is the planning list: what is planned next, and what was skipped and why.

To learn the tools as a DM, read the [DM guide](docs/dm-guide.md): a quick start, how to build maps and run fights, and worked scenarios.

<!-- Keep this page current: update it in the same change that adds, changes or removes a feature. -->

## Secrets stay secret

- The DM sees everything. Hidden things show translucent or dimmed to the DM.
- Players' devices never receive what players may not see: hidden tokens, monsters and map labels under the fog, hidden stamps, lights, DM notes, monster stats, other players' companion stat blocks, the DM's fog edits before they are published, the map's other phases, scene folders and thumbnails, DM-only journal pages, secrets not yet revealed, and creatures out of the party's sight. So even a reload or the browser's developer tools cannot show them.
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
- The DM can kick a player, change the player password and delete the room. A new password signs every player out and stops old player links. On Members, Manage on a member's row holds Kick and Remove.
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
- On a short screen, a notice that lasts (Reconnecting, the Starting view bar, a part that did not load, "Viewing as") keeps to one line, its buttons in the same row and More to read the rest, so it never stands over the toolbar. Where even that leaves no room for a row of the tool's options, the options stand over it.
- Other people's token drags move live, with their name over the token in their color.
- One finger uses the current tool, and with the Select tool a drag on empty map moves the map. Two fingers pan and pinch-zoom. With a mouse, the wheel zooms at the pointer, as two fingers on a trackpad do, and pointing at a token shows its whole name. Nothing needs a long press.
- Tapping a token opens its action bar. On a screen 600 px or wider, or a phone on its side, it opens as a window at the bottom right of the map instead of under the token. Drag it by its header, or by the grip at the header's start ("Move window"). With the grip focused, the arrow keys move it, and Shift moves it further. On a computer, drag the round handle at its free corner, or an edge beside it, to resize it ("Resize window"), and with the handle focused the arrow keys resize it. It scrolls inside when it is smaller than what it holds. This device remembers the spot and the size for every token's window, and the reset button left of Close ("Reset window position and size") puts both back. Beside a phone's sideways sheet it narrows, and where it would be too narrow it folds into the sheet's header. "Fit the map" keeps the map out from under it. On a phone held upright it spans the screen under the token. On a screen too short for either, it opens taller, over the Multi-select bar and if need be the toolbar. Close it to reach the toolbar again.
- The action bar opens with a summary: AC, HP, speed and passive Perception for a creature whose stats you have, then the HP entry, then for the DM a monster's or NPC's six saving throws and its resistances, immunities and vulnerabilities from its stat block. On a phone held sideways, a window made shorter than 300 px, or a screen too short for the whole bar, such as a phone held upright at a larger interface size, the bar keeps AC, HP and the HP entry at the top, and "More stats" holds the rest. A phone held upright keeps one layout whichever token you tap, with Apply in view. "Stat block" opens the whole block in the token's panel, with the action bar still open beside it on a wide screen or a phone on its side, except where the panel fills a very short screen. A player's own character offers "Open the sheet". "Details" sits beside them.
- The action bar's buttons come in rows. Undo move (for players), Doesn't count and the door lead on a line of their own when they apply. Then come Conditions, Hidden and Multi-select, always together on one line, then Roll (for the DM and the token's owners) and Light. The last row holds Locked, Duplicate and Delete for the DM, or Dismiss for a companion's player.
- A tap on empty map closes the action bar. Panning, pinching and holding a finger down to ping leave it open.
- The fight's alerts and a docked action bar share the right of the map without covering each other. Where there is no room for both, the alerts show as one row naming the most pressing one, and its tap hides the bar and shows them. Where the tool's options leave the alerts too little room for one whole card, as on a small phone with the Ruler, the same row stands for them, clear of the tool's buttons and of End turn. Its tap opens a roll waiting for your answer, or shows the alerts over the tool's options until you tap elsewhere, and opens the alerts over the screen where the column has no room, until you tap Close, press Escape or go Back. The action bar keeps clear of notices that last, such as Reconnecting or the Starting view bar.
- On a phone held upright, an open sheet folds the token's action bar and the fight's alerts into one row on the sheet's top edge: a button with the token's name, its Close, and one button that names the most pressing alert and how many more wait. The token's name closes the sheet and brings the bar back as it was, a half-typed HP entry included. The alert button closes the sheet and shows the alerts, or opens a roll waiting for your answer. Where the screen is too short for that row, its buttons sit in the sheet's header.
- The fit button in the top bar ("Fit the map to the screen") brings the map back into view. A pinch anywhere but the map never zooms the page.
- Android's Back button and the Escape key close an open sheet, handout or action bar before they leave the room. While the token's panel shows that token, they and the bar's Close put the bar away and keep the token in the panel. With the bar away, Escape lets go of the token.
- On a phone, panels open as sheets from the bottom, and the toolbar names each tool under its icon, as it does on any touch screen. On a screen 900 px or wider, panels are tabs in a side panel, in one row: the most used first, as many as fit, then More, which lists the rest. A panel opened from More shows its name on More, and the tabs never move. A long name there may end in "…", and the panel then shows its full name at its top. A count on a panel inside More shows on More too. Each panel opens scrolled where you left it, whether you come back by its tab, More or a link, in either of two panels, or in a phone's sheet. The Token and Dice panels do so for the token they showed, and open at their top for another. Hide panels at the end of the tabs, or the S key, hides the side panel, and Panels in the toolbar brings it back. This device remembers the choice. A short screen, such as a large phone held sideways, starts with it hidden. The toolbar scrolls sideways when its tools do not fit, and with a mouse the wheel scrolls it. On a phone held sideways, Hide in a panel's header tucks the panel away with its place kept, and Panels brings it back. Where the screen is too short for a panel beside the map, it opens over the whole screen, with the token's actions and the fight's alerts as buttons in its header, and the room's notices, "Your turn" and messages between the header and the panel.
- Two panels, at the top of More, shows two panels at once, one above the other, such as Initiative above a token's stats, or for a player their character's card. The tabs pick the top one. The bottom one starts on Token for the DM and Characters for a player. The bar between them names it: press its name to pick another, or use Swap panels or Close, and drag the bar, or move it with the keys, to share the room. A link that opens a panel, such as Stat block, Details or a pin's page, leaves an open panel where it is and otherwise opens in the other pane, so the panel you are reading stays. This device remembers the two panels and where the bar sits, for a DM and for a player. A side panel too short for two shows the top one until there is room, and a phone shows one panel at a time.
- Swipe a sheet down to close it: from its header at any time, or from anywhere on it once it is scrolled to the top. A short grabber bar at the top of a sheet shows that it swipes. A slow swipe settles on the nearest place: past halfway down it closes, and short of that it springs back. A quick flick down closes it at once. Panels, the menus and pickers that rise from the bottom (such as a scene's menu, the monster filters and Request a roll), the X-card, and the label, pin and light panes all close this way, and a roll request swiped down waits for later, as Later does. A sheet holding something you typed and have not sent or saved, such as a chat message or an encounter being edited, springs back and stays open. A sheet on the right of a phone held sideways keeps Hide and Close.
- Swipe a panel up from its header to fill the screen, as a video app's comments do, or use the Full screen button that Tab reaches in its header. From there a short swipe down brings it back to its normal height, a long swipe past halfway to the bottom or a quick flick down closes it, and a slow swipe between the two settles back at the normal height. Each panel opens at its normal height.
- On a phone, the DM's setup tools (Add token, Pin, Map builder and Line up grid) sit behind Setup in the toolbar, which then shows the one in use. Their keys still pick them directly. On a computer all ten tools stay in the toolbar.
- A tool's options take one row. On a phone held upright it sits above the toolbar. On a phone held sideways it shares the toolbar's row, so the map keeps its whole height, and where the tools and the options do not fit side by side the toolbar shows Select and the last tool you used, whose second tap opens every tool. On a computer it floats above the toolbar. What does not fit the row waits behind ⋯ (More options), and a wider screen shows more of it. Choices with many values, such as the drawing tool, a color or an area's shape, show their value on a button that opens a small pop-up above the row, and the map stays live under it: two fingers still pan and zoom, and a tap on the map closes it without drawing or pinging. The tool's hint or reading floats above the row on one line, and a tap shows all of it when it is cut. A second tap on the active tool hides its options, and another brings them back, while the tool stays in use. For a tool behind Setup or the tool menu, picking it again there does the same. While a task is under way, such as an area not yet placed, a small "options hidden" line stays, and a tap on it brings them back. Buttons that show a value, such as an area's shape, add their icon where the row has room.
- Panels are listed with the ones used in play first, in an order that never changes with use. A DM's phone list and the side panel's More group them under In play and Prepare.
- A page inside a panel, such as a journal page, a monster's stat block, an area's damage page, the encounter editor or a Menu page like Members, puts its own name at the top, with a back button that says where it goes, such as "Back to Journal".
- Add to Home Screen installs it as a full-screen app on an iPhone. The screen stays awake during a session.
- Phones load a smaller copy of each map, and the map redraws only when something changes.
- A panel that cannot load, offline or after the site was updated, says so inside itself, and the rest of the room keeps running. Its Reload waits until your changes are saved and the connection is back, and opens the panel again. The SRD monster list and stat blocks offer the same Reload when they did not load.

## Scenes and maps

All of this is the DM's.

- A room holds many scenes. The DM moves the players to a scene, and can prepare another one privately while the players stay where they are. The Scenes panel marks the players' scene "Players here".
- A new scene is a Battle mat (a blank grid with a background color), a Map image, or a Builder scene. "From a Universal VTT file" brings in a whole map (below). Cancel folds the new scene form away, and during an upload it stops the upload and keeps the form.
- The server resizes and re-encodes uploaded maps and makes a smaller copy for phones. A scene's map image is added, replaced or removed in its This scene section. Changing the map image of the scene the players are on asks first, since they see it at once.
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
- **Walls and doors** draws a Wall, Door, Secret door or Window on a square's edge, marks an edge No wall, or removes it. Doors are open, closed, locked or secret. Players see a locked door as closed, and a hidden secret door as plain wall. Drag along a grid line to draw a run. With Door chosen, a tap on a door steps it through closed, open and locked.
- **Erase** and **Erase area** clear everything in the squares: floor, walls, doors, windows, labels, stamps, lights and heights.
- **Heights and stairs** paints ground from 20 ft down to 100 ft up in 5 ft steps. Hold + or − to step quickly. It also marks stairs, which point up toward the higher side. Raised ground looks raised, lighter and casting a soft shadow, and stairs draw their treads. Past 30 ft the look stays the same, so tap the ground to read its height. Heights go over a map image too, so a cliff in a drawn map can be raised. A token placed, dropped or duplicated on raised ground stands on it.
- While Heights and stairs is open, each raised or lowered area shows its height in a pill, such as "↑10 ft". The pills grow and shrink with the map like token names. They draw under token names, condition chips, elevation badges and HP bars, and keep off them. A pill with no free spot at the current zoom shows again once zooming in gives it room.
- **Label**: type, then tap the map. Tap a label, here or with the Select tool, to change its text and size or delete it. Drag it here to move it.
- **Lights**: a tap places a light (Candle, Torch, Lamp, Hooded Lantern, Light or Daylight), up to 100 a scene. Tap one to change its reach, turn it on or off, choose whether walls cast shadows from it, or delete it. Drag one to move it. Players see only the light it gives, never the light itself.
- **Stamp** places pictures: 46 shipped top-down stamps (trees, stones, foliage, village pieces, furniture and rocks) or any token image in the room's library. A stamp moves by dragging, turns and resizes by its handles, takes one of 8 tints, flips, comes to the front, duplicates, hides from players, or is deleted. Its tint, flip, front, duplicate, DM only, delete and Done sit in the builder's row, or behind ⋯ where the row has no room, on every screen.
- The builder's bar has Undo and Redo buttons, the same undo as everywhere else. "Clear the build" in the scene's settings removes all of the build.

## Tokens

- Token kinds: player character, NPC, monster, and object or marker.
- Each token has a name (which the DM can hide from players), an image, a size from Tiny to Gargantuan or a custom one, HP, maximum and temporary HP, AC, speeds, elevation, facing and conditions.
- The DM and a creature's owners change its size on the fly, for Enlarge or Reduce, a Wild Shape or a polymorph: Size in its action bar, below Conditions and Multi-select, steps it one size larger or smaller, and Size in its Stats picks any, with "Back to Medium" where its character or stat block gives its own size. The creature keeps its middle and its elevation, and its height, reach rings and attached areas follow. Shrunk back on the same device before it moves, it returns to the square it grew from. On a scene where walls stop moves, a player's resize is checked like a move: the creature never crosses a wall, and grows over the squares it filled into the room around them, away from walls the least it must, or keeps its size with "No room to grow here". The DM's changes are never stopped. A size change undoes as one step, keeping damage dealt since, and counts no movement. The DM alone sets and changes a custom size, and a locked token keeps its size for its players.
- The DM edits every token. Players move and edit the tokens they own. The room setting "Who can move any token" also lets no one (the default), every player, or chosen players move any visible, unlocked token. A drag that is not allowed says why.
- A player's top bar shows their own chip, their name in their color. On a phone the room name gives way to it, down to its first few letters.
- "Find my token" in a player's top bar jumps to their token. The next press goes to their next one.
- HP takes math: `-7`, `+5`, `=20`. Temporary HP is spent first.
- What players see of a monster's HP, set per token: nothing, a label (Healthy, Bloodied, Dying, Dead), a bar, or the exact number.
- A colored ring shows ally, neutral or hostile.
- Copies of a monster are numbered (Goblin 1, Goblin 2). A token without a picture shows its initials, G1, G2 or "AR" for Ash Rider, the same on the board, in the tracker and in the Characters and Monsters panels.
- Each creature shows its AC on a small shield in the bottom left corner of its token. The DM sees every creature's, a player sees the AC of the creatures whose stats they have: their own character and creatures they own. A dead creature's shield hides, and on a token too small for it the action bar still says its AC.
- Names, condition chips and badges draw above every token and the fog. They scale with the map and make way when crowded.
- Hidden tokens are translucent to the DM and never reach players. A locked token shows a padlock and cannot be dragged.
- A token sits on the creatures layer or the objects layer, under creatures.
- A token at 0 HP shows as dead or dying.
- Each token has three notes: "For everyone", which everyone who can see it reads, written by the DM and its owners, "On the card", the character's or monster's notes for the DM and the card's owners, and "For DMs only".
- Up to 6 other images per token, swapped with one tap for Wild Shape or a disguise. Only the DM and the token's owners get the list. In the token's panel, "Add another image" sits beside "Change image", and its tooltip and the picker it opens say what other images are for.
- A token's panel starts with its name, then its image, then for a monster or NPC its stat block, whose header shows its AC, speed and passive Perception even when folded. Then HP, conditions, position, range rings, notes, rest and sight. Stats, token settings, a companion's settings and owners fold away at the foot. This device remembers which you opened, the stat block included. Max HP and temporary HP always sit side by side, with their labels above them on a narrow panel.
- Range rings around a token, such as 30, 60 and 120 ft: preset circles to tap on and off, and a "Custom ft" field for any other distance, up to 4 rings. With 4 on, a line says so, and the other presets and the field stay reachable by keyboard and screen reader, which hear why they do nothing.
- A token can carry a light (Candle, Torch, Lamp, Hooded Lantern, Light, or a custom one), set by the DM and its owners. A scene lights up to 20 token lights. Past that the DM cannot light another, while a player's torch is never refused: the party's own lights light first, and the scene's Vision settings tell the DM how many light nothing.
- A character's token can link to its owner's D&D Beyond sheet.

### Several tokens at once

- Select several tokens with Shift or Ctrl and a click (Cmd on a Mac), with "Multi-select" in a token's action bar or the Initiative panel, or with a box drag: Shift or Ctrl and a drag on empty map with a mouse, or any drag on empty map while Multi-select is on. Drag any of them to move them all.
- With Multi-select on, a tap on empty map hides the group's action bar and keeps the group, and "Actions" in the Multi-select bar brings it back. A tap on a token in the group takes it out. Done ends Multi-select and lets go of the group, and so do Escape and Android's Back while the bar is hidden.
- The group's action bar offers one HP entry for all of them, Conditions, and elevation up and down 5 ft.
- The DM also gets Roll, which opens the Dice panel's group rolls, Request a roll, Hidden, Locked, Start a fight or Add to the fight (objects stay out of the fight), Delete, and More: ring color, size, layer, image, how players see HP, hiding names from players, "Always visible, even under fog", and owners.
- Each action shows only when you may use it on every selected token, except Request a roll and Start a fight or Add to the fight, which show when any of them can take part. A player who selected their own creatures gets conditions and elevation.
- A change to the whole group undoes as one step.

## Images and art

- The image picker gets an image five ways: Icons, Device (an upload, or the camera roll on a phone), Link (an image's web address), Search the web, and Library. Pasting an image from the clipboard works too.
- **Icons**: 4,180 game-icons.net icons, each on a colored disk, found by name or artist. Picking one needs no upload and no search, so it works when web search is used up, and once the icon list has loaded it works offline too. Each icon names its artist and license where you pick it.
- **Search the web**: type "goblin archer" and tap a result. It searches Google Images, with safe search on, while the server has a Google search key and searches left this month. Otherwise it searches Openverse's openly licensed images, and "Search Openverse instead" asks Openverse on purpose. An Openverse image keeps its credit (title, author, license and what was changed), shown in the library and the token panel.
- Crop to a circle with zoom and pan. The ring takes the disposition color.
- The server checks, resizes and re-encodes every image and strips its metadata.
- The room's library keeps every image for reuse. The DM's library marks images nothing uses as "Not in use" and deletes them one at a time or all at once ("Delete N not in use", under Clean up at the foot), on a second tap. An image in use cannot be deleted. Undo cannot bring back a token or anything else whose image was deleted since.
- A tap on an image in the Library opens it large in the same viewer, so the DM can look at any handout, map or token image, and a player at any token image they can see. The viewer's header gives the image's size, its credit where it has one, and for the DM whether it is in use, with Delete for one not in use. The DM's library lists handouts first, and marks each image "In use" or "Not in use" in its corner.
- The DM's library shows a PDF handout as one item with its page count. A tap opens it with every page, and Delete removes it with its pages.
- A monster's default image: set it once, and every token of that monster placed afterwards starts with it. "Apply to N tokens on this scene" puts it on the ones already there.
- Every piece of art that ships with the app is openly licensed and credited on the About page. None of it is AI generated.

## Conditions and statuses

- The 15 conditions of the 2024 rules, each with its rules text from SRD 5.2.1 behind "Rules text" in the Token panel.
- Exhaustion levels 1 to 6, with a level badge.
- Common statuses: Concentrating (with the spell), Hidden, Flying, Dodging, Raging, Blessed, Baned, Hasted, Hunter's Mark, Hexed, Marked, Surprised, Heroic Inspiration and Readied action. Bloodied shows on its own from HP, Dying (with death save pips) and Dead come from HP and Mark dead, and Reaction used is a switch on the initiative row.
- Custom statuses take an emoji or a letter, a color and a label.
- A token's action bar has a quick Conditions grid, each condition named under its icon.
- A status can carry a counter, such as rounds or charges left, that a tap counts up or down.
- Durations: a number of rounds, or until the start or end of a chosen creature's turn. They count down with initiative, and everyone is told when one ends.
- A concentrating creature that takes damage gets a prompt with the DC (the higher of 10 and half the damage, at most 30). Its player reports pass or fail, or taps Roll.
- A condition can end on a save at the end of each of its turns. The DM's reminder rolls it, or asks a player, whose passing answer ends it. A failed one stays open for a corrected total or an allowed reroll. Players see which save ends it, never its DC.
- The DM can hide a condition from players, the creature's owner included. The log hides it too.

## Height and elevation

- Every token has an elevation in feet, negative for burrowing, with +5 and -5 buttons. A badge such as "↑30" shows whenever it is not 0.
- With Select, tap raised or lowered ground to see its height for a few seconds, such as "↑10 ft", or "Stairs" on a stair. Under the fog it shows nothing. Screen readers hear it too.
- Rulers, distances between tokens and areas of effect all count height.
- Creatures have a height from their size, so a fireball can miss one flying above it.
- A flying token's shadow shows from 5 ft up and drifts down and away as it rises, further for a larger creature.
- On raised ground from the builder, with "Walls and ledges block players' moves" on, a player's walking token crosses an edge only by a stair, while a flier above it passes. A creature sees over a ledge no higher than its eyes, and one in a pit cannot see out.
- A token left inside the ground after a height change says so and offers "Stand on it".

## Measuring and movement

- Ruler: drag to measure, and tap to add waypoints. It shows the total and each segment's length. Players' rulers show to everyone in their color. The DM's stays private until shared. A double tap keeps a ruler on the map. A point on raised or lowered ground stands on it, so the distance counts the height. A player's ruler counts only ground they can see, and everyone reads the same numbers.
- Dragging a token measures as it goes: green within its speed, yellow within a Dash, red beyond. A creature above 0 ft with a fly speed is measured against that. In a fight only the creature whose turn it is gets the colors.
- Tokens snap to the grid.
- Distance between two tokens counts from edge to edge, right for their sizes, and includes height.
- Diagonals follow the room's rule: every square 5 ft (the 2024 rule, and the default), alternating 5 ft and 10 ft, or true distance. Feet per square can change too.
- On a creature's turn its path is tracked. Each drop or change of elevation adds a leg, and the trail draws on the map with a ring where the turn began. "Moved" totals the whole path walked, which helps the table judge opportunity attacks. Nothing detects them for you.
- A player's "Undo move" takes back their newest drag, elevation change or turn of facing. "Doesn't count" leaves a shove, Misty Step or a teleport out of the total.
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

- A scene with a map or a build starts fully fogged, unless a Universal VTT import was made with "Start under fog" off. A blank battle mat starts with none, and keeps none when a build is added to it.
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
- A player's area tool always shows who the next area comes from, such as "From Thorn". It starts on when Thorn is your only character on the scene, and a tap turns it off or on. With a companion or a second character it lists them, and No caster. With none of your creatures on the scene it stays, greyed out, and says why. It stays as you left it until you reload, and selecting your creature before opening the tool still casts from it. While an area comes from your creature, a tap on another creature aims it there. Set caster in More options casts from someone else. The DM's areas start with no caster, and once one is cast from a token the same button drops or restores it.
- Spell presets from SRD 5.2.1: search "fireball" and get a 20 ft sphere.
- A private preview shades the squares and lists who is in it ("In area (3): Goblin 1, Goblin 2, Thorn (ally)") before you place it. A cone, cube, line or emanation leaves its caster out unless you include it. A sphere or cylinder catches a caster inside it.
- Auras stick to a token and move with it, such as Spirit Guardians or a Paladin's aura. The list of who is inside updates live.
- Placed areas stay until removed. They move, turn and resize, and show to everyone or to the DM only. Only the DM and the area's owner change one.
- An area's name keeps clear of tokens and their names, and on a player's screen of fogged ground.
- Room settings choose which squares an area covers (at least half the square, which is the 2024 rule, any part of it, or its center) and which creatures it catches (any of their squares, their center, or most of their space).
- Height counts: every shape measures in 3D. An area put down on a platform starts at the platform's height, and one moved before it is placed keeps its height above the ground.
- Walls block an area.
- **Save and damage** (DM): from a placed area, the group save for everyone it catches, filled from the spell and its caster, or No save for damage everyone takes. Temporary HP and concentration checks follow, and one undo takes it all back.
- **Reminders**: an area can remind when a creature enters it, or starts or ends its turn in it, as Spirit Guardians, Moonbeam and Web need. Presets turn them on where the spell says. During a fight's turns, each reminder goes in the log, and reaches players only for what they can see.
- A room setting decides whether players see each other's areas.

## Combat and initiative

- The DM starts a fight with the selected tokens, every token on the scene, or only the visible ones. Players add their own character with "Join the fight".
- Players type in their own initiative, or tap Roll in their row's initiative box. The DM types in the monsters', taps Roll in a row's box, or uses **Auto initiative**: by creature (identical monsters share a roll), one each, or all at once. A row's Roll shows while it has no value and the row has room for it, and otherwise its options hold "Initiative, sets its row". The DM's Roll shows on rows no player plays. Once set, its options hold "Roll again, replaces 17", so a stray tap never reorders the fight. Each roll is a d20 plus the creature's modifier, with advantage or disadvantage from its conditions. Its dice roll on the server and show in the DM's Recent rolls. Players see the totals, never the dice. It sits right after the order, with what it rolled.
- "Use initiative scores for monsters" in Room settings, or "Monsters use initiative scores" in the Initiative panel, gives them 10 + their Dexterity modifier instead of a roll.
- The order runs high to low. Dragging rows settles ties. A round counter, Start, Next and Previous run the fight. The round counter and its buttons, or End turn, stay at the top while the order scrolls under them, and scroll away once the order has passed. They stay put only while there is room for them and two rows under them, shrinking to one line where the full ones would not leave that much. So they stay put in a panel opened over the whole of a very short screen when its body has that room, and otherwise scroll with the order.
- The active token gets a turn marker. With "Camera follows the turn" on, the DM's map pans to whoever acts. Players' maps stay where they are, unless the DM uses Follow me or Look here.
- Players see the turn order, names and conditions. Turning a token's Hidden off, by its action bar, a group's bar, the H key or its panel's switch, shows its row too, in one undo step. A row's own "Hidden from players" still hides the row alone. With "Reveal hidden combatants on their turn" on, a hidden creature appears when its first turn comes, but only where players could see it: on revealed ground, and with party vision only while the party can see it. While it acts out of their view, they see "Another creature's turn".
- "Initiative order players see" (Room settings, Combat) keeps monsters' places in the order secret until their turn: Player characters, the rest on their turn (the default for new rooms), Player characters and allies, the rest on their turn, or Everyone (what rooms made before the setting keep). Players see the creatures players play from the start, and with allies those with the Ally ring too. Every other creature, the DM's NPCs included, joins their order when its first turn comes and keeps its place for the rest of the fight. Before then nothing of it reaches them: no row, value, place or count, and no initiative roll for it, even one the DM rolls in the open. Previous takes back the turn that showed it. The DM sees every row, and View as a player shows what players see. The DM's row says "Secret until its turn" while players do not see it.
- A strip across the top of a phone shows whose turn it is. On a phone held sideways it sits in the top bar when the bar has room for it, and on a computer it is a chip in the top bar. Only the DM's strip shows who comes next. On their own turn a player gets "Your turn" in the strip, a vibration on Android or a chime, and an "End turn" button.
- Rows show AC, HP and conditions. The DM sees every creature's AC, and a player their own creatures'. Tapping a row opens the same menu as tapping the token.
- Damage and healing take math, and one entry can apply to several creatures. "Players can apply damage and healing" lets players do it too.
- At 0 HP, monsters die ("Monsters die at 0 HP") and characters get death save pips that their player fills in, or rolls with the death save row's Roll. "Skip defeated creatures" passes over the dead.
- Healing a dead creature brings it back with the HP healed ("Healing brings back the dead", on by default). Off, healing does nothing to the dead, and the HP entry says so. The DM's Revive is in a dead creature's action bar and its tracker row's options, and brings it back with 1 HP.
- Per-turn resources: Reaction used clears at the start of the creature's turn, Legendary Action pips refill, Legendary Resistance counts uses per day, and an "in lair" switch.
- Recharge: at the start of a monster's turn, an action that recharges, such as Fire Breath, and was marked Used in this browser tab's Dice panel, prompts the DM to roll its recharge.
- A Ready marker (Hold is the same thing) records the trigger and shows on the row and the token until the creature's next turn. Players learn only that a monster readied, not its trigger.
- The combat log keeps each HP change ("Goblin 2 takes 7 damage, 3/7 left"). The DM can take any one back while the creature is still as that change left it.
- An optional turn timer, from 30 seconds to 10 minutes. It never ends a turn.
- "End the fight" ends it, with a second tap to confirm.

### Encounter builder

- The Encounters panel (DM) builds an encounter from SRD monsters and the room's own, with a count for each.
- It shows the 2024 XP budgets (Low, Moderate, High) for the party, from each character's level, and which budget the encounter fits. The DM can change the party for one encounter.
- Saved encounters drop onto any map, hidden from players if the DM asks. In a running fight their creatures can join the tracker. One undo takes it all back.
- With unsaved changes, the editor's back button asks "Discard changes?" first, and a second tap leaves.

### Companions

- A companion is a token that belongs to a character: a creature such as a familiar or a summoned spirit, or an effect with no HP such as Spiritual Weapon. Whoever plays the character controls it: moves it, changes its HP, conditions and stats, renames it and dismisses it.
- Each companion takes its own turn with its own initiative, acts on its character's turn listed under it in the order, or acts on its character's turn and stays out of the order. Only a creature takes its own turn. A new creature starts listed under its character and a new effect out of the order, unless its maker picks another turn. One made with its own turn while its character is in a fight joins that fight at once, in a row of its own with its initiative still to roll.
- A player adds a companion from their character in the Characters panel. It goes right next to the character's token, up to 10 per character on a scene, and the DM's log says so. The DM can make any token a companion in its panel.
- A creature companion can have a full stat block: an SRD 5.2.1 creature, such as an owl for Find Familiar or a wolf, text pasted from a book with "Paste a stat block", or one typed in the editor. Its players and the DM read it in its panel, and its action bar shows its saves, resistances and immunities. Other players see its token, name and HP as before.
- A character keeps up to 100 stat blocks for its companions, so a familiar summoned again starts from the same block. Its players and the DM add, edit and delete them from the character's card. "Add a companion" can start from one, which fills in the form.
- Attaching a block can set the companion's AC, max HP (the block's average, a typed number, or the maximum it has), speed, size, senses, passive Perception and initiative. An unhurt companion stays at full HP, and a hurt, dying or dead one stays so. Conditions, effects and temporary HP stay.
- A block's size goes through the same resize as any token's: a companion its player grows near a wall grows into the space around it, still covering where it stood, and moves just enough to stand where a move could end, never across the wall, or keeps its size with "No room to grow here", while the block and its other numbers still apply. Ctrl+Z right after attaching takes back the size change alone, and the block and its numbers stay. Detach takes the block off.
- A summon cast at a higher level takes its AC and HP as you type them when you add it.
- A companion listed under its character keeps its own Reaction and Ready action in the order.
- A companion's token panel says whose it is ("Companion of Bree"), as its own row in the order does.
- Other players see a party member's companions, under the character in the order, with HP as "Players see the party's HP" allows. A creature companion lends the party its sight, an effect does not.
- Effects on a companion that acts on its character's turn count that character's turns.
- A companion stays on its scene when the party moves on. The DM finds the ones left behind by searching "companion" in that scene's outliner.

## Dice

Every roll happens on the server, with a secure random source, so everyone sees the same result and nobody can fake one.

- The Dice panel is for everyone, after Initiative among the tabs. Type any formula and tap Roll, or press Enter: "10d4+1d8", "4d6kh3" (keep the three highest), "4d6dl1" (drop the lowest), "d%", "2d6+3 fire" (the words after the formula are its label) or "1d20+5 Stealth adv". A roll holds up to 100 dice and 20 parts. The line under the field reads the roll and its range before you roll it, such as "2d6+3, fire: 5 to 15". Quick dice, the d20 first, then d4 to d100, add a die to the field.
- Adv, Dis and Secret are for the next roll only: the tap that rolls takes them, and they go back to their start, so a second roll never shares the first one's Advantage. Advantage and disadvantage cancel to a normal roll however many of each a roll has, the words "adv" and "dis" typed in the field included.
- Secret: a DM's rolls for monsters start secret. The Secret chip follows the selection, so a formula the DM types with a monster selected starts secret too, and one typed with no creature selected, or only creatures players play, starts public. One tap changes it. A press holds for the creatures it was made for, and selecting another creature starts Secret again, so a monster's roll starts secret even after the last monster's was shown. A player can send one roll to the DM only. The DMs and the roller read it in full. Other players read "Mara rolled in secret." only when the same roll made public would have reached them, so a roll for a creature they cannot see leaves no trace.
- The newest roll stays at the top of the panel, with its dice as chips, a dropped die struck through and a natural 20 or 1 marked, and Again rolls it once more. A refusal shows there with its reason. A tap on it opens the roll in Recent rolls.
- Recent rolls lists every roll in the log, newest first, a roll of several dice groups as one row, with Again on your own. Older rolls are in the Log.
- Others' rolls show as toasts while your Dice panel is not on screen, one for each roll ("Bree rolled 19 for Stealth.", or a damage of two types as its sum, "Bree rolled 14 for Flame Tongue damage."), and a roll of your own whose panel closed before it landed shows as one too. This device can turn the others' off.
- Rolling very fast pauses you for a few seconds ("You are going too fast. Wait a few seconds."). A room's day holds 10,000 rolls and applied changes, a player's 2,000, and the players together leave the DMs 2,000 of them.
- A roll needs a connection: while the room is offline, Roll is off and says "Rolling needs a connection." A roll sent just before the connection dropped is sent again and still rolls once. If its answer was lost, the device asks the server what became of it, and never rolls it again by itself: "This may have happened. Check the log."
- **Roll options**: the DM taps a token, a player picks a character, a companion or another creature they own, and the Dice panel lists its saves, checks, skills, initiative, death saves, attacks with riders and critical hits, save actions, healing and recharge, from its stat block, 2014 text included, each result shown on its row. Conditions such as Restrained, Poisoned or Bless set advantage, disadvantage or a die on every d20 roll. A roll the DM asked for answers the request, initiative goes into the tracker, and the newest damage, a player's included, shows in every HP entry as "Use 9". Roll in a token's action bar opens them. For a creature a player plays, the DM's "Ask Bree to roll" switch starts on and asks its player for saves and checks. A creature with no stat block, or a character whose numbers go only to the DM and its own players, still lists its saves, checks, skills and initiative, with no bonus shown: a tap that asks its player needs nothing, and a roll made here takes a bonus typed above them ("Str d20", then "Str d20+3"), never an unknown +0.
- **Critical hits**: an attack's Critical, which a natural 20 (or a wider critical range) presses on its own, rolls every damage die of the hit, riders such as Sneak Attack included, by the room setting "Critical hit damage" (Room settings, Combat): Roll the dice twice (2d6+3 crits as 4d6+3, the 2024 rule and the default), Max plus a roll (12 + 2d6 + 3), Double the dice rolled ((2d6 × 2) + 3) or Double the total ((2d6 + 3) × 2). One rule for monsters and characters alike, applied by the server. The roll shows how it was reached: in the log and Recent rolls ("12 max + 2d6+3 (4, 6) = 25"), and beside its total on its row, at the top of the Dice panel and in its toast ("25 (12 max + 13)"). Saves never crit.
- **Several creatures** (DM): one save or check for all, initiative for the ones in the fight, or a shared attack with its hits against an AC and its damage.
- **The group save** (DM): monsters rolled at once, players' creatures asked with the DM's roll one tap away (with a bonus the DM types for one with no stat block), pass or fail against a DC, damage rolled once and kept by type, full or half, conditions on a fail with their end, resistances, immunities, Evasion, Magic and Legendary Resistance on each row, every row changeable, its damage included, one Apply and one undo. Until the roll its creatures follow the selection, so a save action's Group save fills with the creatures selected after it. Monsters' rolls the DM shows to players carry the DC only with "Players see the DC" on, and a save-ends or concentration roll in the open never shows its DC. It stays on the DM's device through a reload, and an Apply whose answer was lost is never sent again unless the DM says so.

## Rolls

The DM asks players for a saving throw or an ability check, and each player rolls it in the app or types the total they rolled.

- "Request a roll" is in the action bar of several selected creatures that players play. For one creature, the bar's Roll opens its options, whose "Ask Bree to roll" switch asks its player. "Ask the party" is in the party bar.
- One tap picks the roll: a save or a check by ability, or a skill from a list, which starts at its usual ability and can go with another. Nothing is picked until the DM picks it, and a later tap replaces the whole roll. "Or a second choice" lets the creature pick between two, such as "Strength (Athletics) or Dexterity (Acrobatics)". Either can be removed.
- The DC, or none, on one row with the typical DCs for a check as chips from 5 (Very easy) to 30 (Nearly impossible).
- Who rolls, as chips. "Ask the party" starts with the characters on the players' scene picked, or every character when the DM is looking at another scene.
- What players see (the DC, and pass or fail), "Against a spell" for a save, and a note such as "against the poison" fold into one line that says what they are. Both switches start as the DM's last request from that device had them, else on. With the DC hidden and pass or fail shown, a typed answer is final once it passes or fails, so changing the total cannot find the DC. The DM can reopen it.
- The last three requests from that device are one tap each, with their DC, switches and note. Enter in the DC field or the note sends. If the server refuses the request, the sheet stays open with everything set and the reason. Closing the sheet while the request is sending does not stop it, and a refusal that comes after shows as a message.
- The player's device shows a card, with a vibration on Android or the turn chime. It asks the question with its DC or "DC hidden", and shows reminders from the creature's conditions and statuses, such as Restrained's disadvantage on Dexterity saves or an Exhaustion penalty. With two choices each names its bonus where the app knows it, and the higher one starts picked.
- While the creature waits, Roll rolls on the server with its bonus ("Roll +3"), or with a bonus the player types when the app knows none ("Roll d20", then "Roll d20+5"), with "Add a stat block" for a character that has none, shown only to the DM and the character's own players. Conditions such as Restrained, Bless or Magic Resistance against a spell apply as in the Dice panel, the player can add Advantage, Disadvantage or extra dice such as +1d4, and a line under Roll says how it will roll, or that they cancel. A condition that fails the save, such as Stunned on a Dexterity save, offers "Fail (Stunned)" first, and a roll made anyway records Fail with its total. Rolling needs a connection.
- A rolled result shows in the card, with its dice, a dropped die struck through, and a natural 20 or 1, until Done, then in the chip: "Dex save: rolled 17 (1d20+5: 12). Pass. Final." A rolled answer is final. The player can ask the DM, from the card or its chip, to reroll one die (Heroic Inspiration, the d20 or any other die such as Bless's d4, or Halfling Luck on a 1), to add advantage (Lucky) or to add a Bardic Inspiration die, and can withdraw the ask. A typed total that is final, with the DC hidden, can be fixed the same way with "Fix my total", whose Allow lets the player type it again but not roll.
- Or the player types the total and taps Send, and once a total is sent, Roll is gone. A save also offers "Fail without rolling". A refusal, such as rolling too fast, shows under the card's rows in the server's words. A typed total folds the card into a chip, such as "Dex save: sent 17. Pass." (with two choices it names the one rolled: "Str or Dex save: sent Dex 15. Pass."), which opens again to change the answer while the request is open. A card can also fold away to answer later. On a phone the chips fold into one button while a sheet covers the map, and otherwise only the newest two show, with a "Rolls" button that counts the answers (such as "Rolls 1/3"), shows the rest and folds them again. A card that would cover an open sheet on a phone folds too, into a "Roll asked" button that closes the sheet and opens the card again, with any total typed into it kept. A card at a phone's foot folds the same way while a popover of the tool's options is open, such as Shape or the spell results, and comes back when the popover closes. On a phone a card at the screen's foot stands on the tool's options, such as the Multi-select bar, and the token's action bar keeps above it. Where the screen is too short for the card's question, Later and total, or for both it and the bar, the card folds, and a "Roll asked" row at the top of the map stands for it. Its tap, like a chip's, hides the bar, keeping the token or group selected, and opens the card over the tool's options, rising to the screen's top where it needs the room, with its question, Later, total and Send in reach at once, until it is answered or put off with Later.
- The DM's live card counts passes and fails ("2 of 3 answered: 1 pass, 1 fail") and shows each creature waiting, or how it answered: "rolled 17 (1d20+5: 12)" with its dice, a natural 20 or 1 and a condition that failed it, or "typed 17", with the choice first when there were two, and an answer it replaced. A waiting creature whose bonus the DM's view knows has a Roll, such as "Roll +5, Disadvantage (Restrained)", and one with no stat block a Roll with a bonus the DM types beside it ("Roll d20+3"), which never replaces an answer that came first: "Thorn answered before your roll." Pass and Fail mark a roll with no DC, or overrule one, and the mark is kept apart from what the DC says. A player's ask shows on its row, "Asks to reroll (Heroic Inspiration)", with Allow, which rolls the change on the server, and Keep, one tap each. A card with an ask opens on a computer, names the ask on its folded line on a phone, and leads the alerts summary over a sheet. Closing a request keeps any ask, and "Close all answered" leaves a request with an ask open. "Reopen for one more answer", Close, and "Close all answered", which shows while two or more cards are up, finish it. On a phone the DM's cards start folded to one line, only the newest two show, with a "Rolls" button (such as "Rolls 1/3") for the rest, and all of them fold into one button while a sheet covers the map.
- Only the DM and the creature's player see an answer, and its log line. With pass or fail hidden, a Pass or Fail mark from the DM adds no line to the player's log, unless it only repeats what the answer already said.
- No card shows on a player's screen while the game is paused.

## Characters and monsters

- Every token has a light stat card: HP, AC, speeds (walk, fly, swim, climb, burrow), initiative bonus, passive Perception, senses, size, creature type and notes. It is not a full character sheet.
- A player character can have a stat block: level, ability scores, saving throw and skill proficiencies with expertise, Jack of All Trades, Alert, a spellcasting ability, resistances, immunities and vulnerabilities, a critical range for Improved Critical, Evasion, and its weapons, spells and other rolls, with riders such as Sneak Attack or Hunter's Mark on an attack. Modifiers, saves, skills, initiative, Passive Perception, spell save DC and spell attack follow the scores and the level. Type a total to keep a difference, such as a Cloak of Protection's.
- The DM and the character's players read and edit it. Only they get Add a stat block, Edit, Take a shape and End the shape, so a player lent a token of another character rolls for it but never changes its block. Its numbers stay theirs too: the lent token's player rolls its saves, checks, skills and initiative as a d20 with a bonus they type, and its row's Roll in the tracker opens the Dice panel for that. Other players and the table display never see it.
- Fill it from pasted text, read as a stat block, or from D&D Beyond with a public character's share link or its JSON. It reads numbers, proficiencies, weapons and spells, never their text, and lists what to check before anything is saved. Importing again replaces what it read and keeps the rolls you added. It changes the maximum HP but never brings a character back or puts one down, and never changes the size. It is best effort, since D&D Beyond can change its format.
- A character with a stat block shows it in its token's panel under the image and on its card, its saves in the action bar, and "Stat block" in its tracker row's options. Its initiative and Passive Perception come from the stat block.
- Take a shape on a character's own token: an SRD creature as Wild Shape, where the druid keeps Intelligence, Wisdom, Charisma and proficiencies and each save and skill takes the higher of the two, or as Polymorph, with all of the creature's numbers. A character with no stat block takes all of the creature's numbers in Wild Shape too, and the shape's words point at adding one. The token takes the creature's AC and speeds, and HP stays the character's. One checkbox, on by default, gives the 2024 temporary HP, the level for Wild Shape and the creature's HP for Polymorph, only where they are more than the character holds. End the shape to go back: the character's AC and speeds return, and what is left of Polymorph's temporary HP goes, unless temporary HP from another source replaced them.
- The DM sees every card. A player sees and edits their own character's card. Other players see only the name, conditions and whatever HP the DM allows.
- Player characters belong to the room, so their HP and conditions follow their tokens to every scene. Monster tokens are independent copies.
- "Players see the party's HP" shows every player the exact HP of the other player characters. Off, they see only Healthy, Bloodied or Dying.
- The Characters panel lists the party. With "Players can create their own characters" on, each player can make up to 3 and place their tokens on the players' scene. New rooms start with it on. A room made earlier keeps its own setting, and one stored before the setting existed reads it as off. The DM can still edit, take over or delete the characters players make. A character's card lists its companions and adds new ones.
- A player can delete a character only they play, whoever made it and whether or not players can create characters, at any time, mid-fight included. Every token of it on every map, its companions and its place in the fight go with it, as when the DM deletes it. It cannot be undone, so the card says first what goes, counting only what the player can see and naming the rest in general words, and Delete asks for a second tap. A screen reader hears the same as Delete's description. The DM's log says who deleted what, such as "Pat deleted Bree, with 2 tokens and its place in the fight." A character the player shares with someone else stays the DM's to delete, and its card says so.
- Short rest and Long rest follow the SRD. A short rest adds the HP the player rolled on Hit Point Dice. A long rest restores all HP, ends temporary HP, removes one Exhaustion level and resets legendary uses. The DM can rest the whole party at once.
- The Monsters panel (DM) holds all 330 SRD 5.2.1 stat blocks. Search, then drop one on the map with average HP (or a typed number), AC, speed, size, initiative and senses.
- Filters like D&D Beyond's: challenge rating, creature type, legendary, lair, size, condition and damage immunities, resistances, vulnerabilities, movement, senses and alignment. Or type it in the search: "cr 5", "cr 1-5", "cr 1/2-3", "cr 10-".
- Custom monsters: the DM enters a full stat block from a book the group owns, or uses "Paste a stat block" to read pasted text into the editor. They stay in that room only.
- Full stat blocks on tokens: a monster or NPC token's panel has its stat block right under its image for the DM, with abilities, saves, skills, senses, languages, CR, traits, actions, bonus actions, reactions and legendary actions, and folds. "Stat block" in the token's action bar or a tracker row's options opens it. Edit opens a room monster in the editor, and an SRD monster offers "Copy to this room's monsters and edit". "Attach a stat block" links a token that has none, and Detach unlinks it.
- A player whose token is an SRD monster, such as a druid's Wild Shape, can read its SRD block, and a companion's players read its block. A room monster's block never reaches players, a companion's included.

## DM tools

- "View as a player" shows exactly what a chosen player sees.
- "Follow me" makes players' maps follow the DM's as they pan and zoom. "Bring everyone here" moves them once. A ping with "Look here" on moves every player's view to that spot.
- "Black out players' screens" for a break or a reveal. Players see only a black screen that says "The DM has paused the game." Meanwhile their devices receive nothing from the game but the X-card. When the game resumes, each player's selected token, its action bar and any HP typed into it and not applied come back as they were.
- Undo and Redo for the DM's changes, each saying what it took back. They sit in the top bar.
- **DM guide**: the app serves the [DM guide](docs/dm-guide.md) at /docs/dm-guide, for anyone, signed in or not, with its screenshots and a contents list that jumps to each section. A link such as /docs/dm-guide#areas opens on that section. Menu, DM guide opens it in a new tab for the DM and the players. For the DM, the panels it covers (Token, Initiative, Dice, Areas, DM, Scenes, Monsters, Encounters, Characters and Outliner) end in a small Guide link to their section, and the empty Token and Initiative panels link to its quick start.
- The DM panel leads with Handouts, then Players' screens (Follow me, Bring everyone here and Black out), then Check their view (View as a player and Party sight), then the player link and the table display.
- **Outliner**: a panel listing everything on the scene in view, in groups that fold: Creatures and objects, Map (stamps, labels, pins and lights), Areas, Drawings, and Doors. Each row says what players get, such as Hidden, Under fog, Out of the party's sight, DM only, or a secret door hidden or found. The search filters as you type. A tap frames the item on the map and picks it: a token opens its action bar, a label or pin its pane, an area the Area tool, and a stamp or light the builder in its mode. A drawing, door or window flashes.
- **Party bar**: each player character's portrait, HP with temporary HP and a bar, AC on the same shield as the tokens', hidden while dead as theirs is, passive Perception as "PP 13", and up to three conditions. Dying, Stable or Dead replace the HP bar. On a wide screen it sits above the side panel's tabs, hides with the panel, and folds to one line. On a phone it is the Party panel. A tap jumps to that character's token and opens its action bar, and a character with no token on the scene in view reads "Not on this scene".

## Journal and map pins

- The Journal panel holds pages in folders. The DM writes them, and picks who can read each one: DM only, Everyone, or one player.
- Pages use Markdown: bold, italic, headings, lists, numbered lists, quotes and https links.
- A page is made of blocks, and any block can be a secret. Players don't see a secret until the DM taps Reveal on it, and Hide takes it back. Revealed secrets read as ordinary text.
- When a page a player can read is new or changes, the Journal button shows a dot and the page reads "New" or "Updated".
- **Map pins**: the Pin tool (DM) places a pin with a tap. Its pane sets a label, a linked page, a color and "DM only", and says who will see the pin. If the server refuses a change, the pane keeps it and says why. Tap a pin to open its pane, or drag it to move it. A page's "Pin to the map" places a pin linked to that page.
- Players see a pin only on their scene, out of the fog, and when they can read its linked page. Deleting a page makes its pins DM only.
- With the Select tool, a tap on a pin opens its page, or shows its label when it links none, until a few seconds pass or the next tap elsewhere on the map.
- A room holds up to 200 pages, and a scene up to 200 pins.

## Log, chat and handouts

- The Log holds chat and the important events: HP changes, conditions and turns.
- Whisper to the DM or to one player. Only the sender and the recipients see a whisper.
- While the Log is closed, its button counts new messages, and a whisper to you shows a short notice.
- **Export** in the Log saves it as a Markdown file, one evening or all of it. A gap of more than 4 hours starts a new evening. Everyone can export, and the file holds only what that person's Log shows. On an iPhone it saves through the share sheet. Listing the evenings and each export count toward 10 an hour per person.
- **Handouts** (DM panel): show an image to everyone or to chosen players as a popup. It pops up for the players in the room when the DM shows it, or shows it again. A player who joins, or opens the room in a new tab, finds the handouts already showing in the Library instead. A handout can also be a PDF: Upload a file in Show a handout takes an image or a PDF. The DM chooses which pages, up to 100, and the DM's browser turns them into pages, showing its progress in the DM panel, and names the handout after the PDF's title or file name. Players scroll it like a PDF, page with the Previous page and Next page buttons or Page Up, Page Down, Space, Home and End, and zoom over the whole document, down to a whole page. Download saves a handout of several pages as a PDF. A PDF with a password or an XFA form is refused, and nothing inside a PDF runs. A tap on a handout's picture under Showing now opens it for the DM as the players see it. Players can zoom in with a pinch, a double tap, the wheel, the zoom buttons or the + and − keys. On a handout of several pages the wheel scrolls through them, and Ctrl with the wheel, or a trackpad's pinch, zooms. Zooming uses the whole popup. On a tablet or a computer the popup starts as a card, and zooming in opens it to the whole window, at once with a button, a key or the wheel, or when a pinch ends. A small pinch then settles with the whole picture fitted to the window. Zoom out or Reset zoom, the turning arrow left of the zoom buttons, brings the card back, and Expand opens it to the window without zooming. On a phone it fills the screen from the start. Anyone shown a handout can download it with the popup's Download button, saved under the handout's title. On a phone that can share files, Download opens the share sheet instead, to save the image to Photos or Files or send it on. A closed handout stays closed after a reload, and a reload of the same tab brings back the one that was open. Any handout showing opens again from the Library. Its picture there opens it too, at the page it was left on, and closing it comes back to the Library.

## Drawing, pings and the laser

- The Draw tool: freehand, line, rectangle, circle, polygon, arrow and text, with color, fill, opacity and line width. Everyone draws in their own color by default.
- Players erase and undo their own drawings. The DM can clear everything and can make drawings DM only.
- "Who can draw" in Room settings: no one, every player (the default), or chosen players. A player who may not draw keeps the drawings they made. While they have some on the scene, their Draw tool offers only the eraser and "Clear mine". Rulers, pings and the laser stay for everyone.
- **Ping**: tap a spot to ping it, with a sound, and a vibration on Android for everyone but you. The DM's "Look here" moves every player's view there. With the Select tool, a press held still on the map, off any token, pings that spot too.
- **Laser**: drag with the Ping tool for a stroke that fades on its own and is never saved.
- Pings, the laser and rulers show who made them, in their color.

## The table display

Show the players' view of the map on a TV at the table, with nothing else on screen.

- The DM sets it up from the DM panel's Table display section:
  - "Add a TV" shows a code of 10 letters and numbers (such as `K7QH 2MXA 4F`), a link and a QR code, good once and for 10 minutes. On the TV's browser, "Set up a table display" on Home takes the code.
  - "Open on this device" opens the display in a new window, for a laptop wired to the TV. The window draws only what players get, but the laptop is still signed in as the DM.
- The display shows the players' scene as players see it: the map, the fog, party vision, tokens, shared areas, drawings, pins (except those linked to a page not every player can read), and pings and rulers. It shows no bars, panels, chat, roll requests or initiative strip.
- It also shows the pause screen during a blackout, handouts shown to everyone, the X-card, and "Waiting for the DM to choose a scene" when there is none.
- A handout of several pages shows one page at a time, with its page number. The arrow and page keys step through it, and a tap shows Previous page, Next page and Close.
- A tap, a click or any key shows a menu for 5 seconds: Follow the DM, Fit the map, "Show whose turn it is" (off at first), Text size (85% to 130% for the names, chips and badges on the map), Full screen, and Leave. The display remembers these choices. While the X-card or a one-page handout is open, a tap closes it instead.
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
- **Show others' rolls as they happen**: a toast for each roll someone else makes while the Dice panel is not on screen. On at first.
- "Show the shortcuts": the keys, and what a key or another mouse button does with a click, a drag or the wheel.

## Shortcuts

`?` shows the list for your role, and so does Menu, This device, "Show the shortcuts". It lists the keys, then what a key or another mouse button does with a click, a drag or the wheel (on a device with a mouse or trackpad), then the keys that work inside one part of the room. A plain click, tap, drag or pinch is described with its feature above.

### Keys

On any device with a keyboard. They do nothing while you type in a field or a dialog is open. On a Mac, Cmd works where Ctrl is written.

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
| S | Hide or show the side panel, on a screen 900 px or wider | everyone |
| O | Go to the other panel, with two in the side panel | everyone |
| ? | Show the shortcuts | everyone |
| Escape | Close an open pop-up first, then a sheet, else the token's action bar, else let go of the selection and end Multi-select. While the token's panel shows one token, the bar closes and keeps it. While the panel is open, a group whose bar is hidden stays until Done. A field outside the pop-up keeps its Escape | everyone |

### Mouse with keys

| Mouse | Does | Who |
| --- | --- | --- |
| Shift or Ctrl+click a token (Cmd on a Mac) | Add it to the selection, or take it out, as Multi-select does | everyone, with the Select tool |
| Shift or Ctrl+drag on empty map (Cmd on a Mac) | Draw a box that adds the tokens in it to the selection | everyone, with the Select tool |
| Right-click a token | Select it alone, whatever the tool. With the Select tool its action bar opens too | everyone, with Multi-select off |
| Drag with the right or middle button | Move the map | everyone, with any tool |
| Space+drag | Move the map | everyone, with any tool, while nothing has focus or the map does |
| Ctrl+wheel, or a pinch on a trackpad | Zoom in or out at the pointer, faster than the wheel alone | everyone, with any tool |
| Ctrl+wheel, or a pinch on a trackpad | Zoom the picture or the pages in or out at the pointer, down to a whole page | everyone, in the handout viewer |

### Android

| Button | Does | Who |
| --- | --- | --- |
| Back button | Close what opened last, such as a pop-up, a sheet, a dialog, a handout or the action bar | everyone |

### Toolbar

Each tool key picks its tool, also one behind Setup or the tool menu.

| Key | Does | Who |
| --- | --- | --- |
| The tool's key | Show its hidden options again. It never hides them | everyone, for the tool in use |
| Arrow keys, Home, End | Move to a tool, as a letter does to one whose name starts with it. Enter or Space picks it, or on the tool in use hides or shows its options. Escape closes the menu, and Tab closes it and moves on | everyone, in Setup or the tool menu |

### Tool options

A tool's options row, its More options and the pop-ups its buttons open.

| Key | Does | Who |
| --- | --- | --- |
| Enter, Space | Open its pop-up with the keyboard in it | everyone, on a button that shows a value, or on More options |
| Arrow keys | Change the choice and keep the pop-up open. Enter or Space picks it and closes the pop-up | everyone, in a pop-up's choice |

### Side panel tabs

On a screen 900 px or wider, with a tab or More's list focused. There, and on a focused choice or slider, the arrow and Page keys never move a token, and in the list a letter goes to a panel instead of running a shortcut.

| Key | Does | Who |
| --- | --- | --- |
| Left, Right | Switch to the tab beside it, wrapping around at the ends. On More, or on the panel open below, stop there and switch nothing | everyone |
| Home, End | Go to the first tab, or to More, the last, switching as Left and Right do | everyone |
| Enter, Space, Down, Up on More | Open the list, at the open panel or the first, or with Up the last | everyone |
| Up, Down, Home, End in the list | Move through it, wrapping around at the ends | everyone |
| Letters in the list | Go to the next panel whose name starts with them | everyone |
| Enter, Space in the list | Open the panel, or turn Two panels on or off, and close the list. More then shows the panel's name | everyone |
| Tab, Shift+Tab in the list | Close it. Tab goes on to the next control, Shift+Tab back to More | everyone |
| Escape in the list | Close it, back to More | everyone |

### Two panels

On a screen 900 px or wider, with two panels in the side panel. With the bar's grip focused, the arrow keys move the bar and never move a token.

| Key | Does | Who |
| --- | --- | --- |
| Up, Down | Move the bar 8 px, or 64 px with Shift | everyone, with its grip focused |
| Escape | Put the bar back where it was | everyone, while you drag it |
| Enter, Space, Down, Up on the bottom panel's name | Open its list of panels, at the one open or the first, or with Up the last. The list takes More's list keys | everyone |

### Handout viewer

A handout the DM shows, or a picture or a PDF opened from the Library.

| Key | Does | Who |
| --- | --- | --- |
| +, - | Zoom in, zoom out | everyone |
| 0 | Reset the zoom | everyone |
| Arrow keys | Move the zoomed picture, or a handout's pages | everyone, while it is larger than the viewer |
| Page Down, Page Up | Scroll down or up about a screen | everyone, on a handout of pages taller than the viewer |
| Space, Shift+Space | Scroll down or up about a screen, as Page Down and Page Up do | everyone, on a handout of pages taller than the viewer, with focus on the viewer rather than a button |
| Home, End | Go to the top of the first page or the end of the last | everyone, on a handout of pages taller than the viewer |

### Token window

Where the action bar opens as a window: on a screen 600 px or wider, or a phone on its side. With its grip or corner handle focused, the arrow keys move or resize it and never move a token.

| Key | Does | Who |
| --- | --- | --- |
| Escape | Put it back where it was | everyone, while you drag its header or resize it |
| Arrow keys | Move it 8 px, or 64 px with Shift | everyone, with its grip focused |
| Arrow keys | Resize it 8 px, or 64 px with Shift | everyone, with its corner handle focused, on a computer |

### Initiative

| Key | Does | Who |
| --- | --- | --- |
| Enter | Save the initiative you typed | everyone, in a row's initiative box |
| Escape | Drop the initiative you typed | everyone, in a row's initiative box |
| Enter | Go to the next box, and save after the last | DM, while typing several values |

### Dice

| Key | Does | Who |
| --- | --- | --- |
| Enter | Roll what the field holds | everyone, in the Dice panel's formula field |
| Up, Down | Go back through the formulas this device rolled, newest first, or forward again to what was being typed | everyone, in the formula field |
| Enter | Roll the parts, or take the typed numbers | DM, in the group save's damage field |

### Roll requests

| Key | Does | Who |
| --- | --- | --- |
| Enter | Send the request | DM, in Request a roll's DC or note field |
| Enter | Send the total you typed | players, in a roll card's Total field |
| Enter | Roll, with the bonus and extra dice you typed | players, in a roll card's Bonus or Extra dice field |

### Token and character fields

| Key | Does | Who |
| --- | --- | --- |
| Enter | Save the field and leave it | everyone, in a one-line field |
| Escape | Drop what you typed and leave the field | everyone, in a one-line field |

### Label, pin and light panes

| Key | Does | Who |
| --- | --- | --- |
| Enter | Finish the text, as Done does, or save a light's name | DM |
| Escape | Close the pane | DM |

### Dialogs

| Key | Does | Who |
| --- | --- | --- |
| Escape | Close it. A journal page or a monster with unsaved changes asks first | everyone |
| Tab, Shift+Tab | Move through its controls without leaving it | everyone |

### Choose an image

| Key | Does | Who |
| --- | --- | --- |
| Ctrl+V (Cmd+V on a Mac) | Paste an image to upload it, or an https link to import it | everyone, with focus outside a text field |

## Look and accessibility

- A dark theme. In a room, buttons take your own member color, adjusted so they stay readable.
- Large touch targets, 16 px text fields so an iPhone doesn't zoom in, and room for the notch and the home bar.
- Respects the system's reduced-motion setting.
- In a room, the browser tab reads `RaccoonVTT · <room name>`.
- A click or tap outside a dialog closes it, except a handout or a picture from the Library.

## Backups and moving a room

- Room settings, Backup: "Download a backup" saves the whole room as one .zip file, with every scene, token, character, journal page and image. At most 4 an hour.
- Home, "Import a room": "Import from a backup" makes a new room from that file, on this server or another, up to 95 MB. The server owner can import a bigger one from the command line.

## Running the server

For whoever runs RaccoonVTT. [README.md](README.md) has the setup steps and every command.

- It runs with Docker Compose behind any HTTPS reverse proxy or tunnel, such as Caddy, nginx or Cloudflare Tunnel, with no open ports. An outbound proxy is its only way to the internet, for image search and imports from a link.
- Google image search needs a SerpApi key. Openverse needs none. The Turnstile human check is optional.
- The strict egress port also allows `character-service.dndbeyond.com`, for the D&D Beyond import. Removing it from `docker/squid.conf` turns the link import off, and pasted JSON still works.
- **Nightly backups**: every night (at 04:00 by default) a backup copies the database and the images it needs, then checks the copy. It keeps the newest 7 good backups and one from each of the last 4 weeks. A run that cannot finish deletes nothing, so the last good backup always remains, and every run leaves 2 GiB free on the disk. One command runs a backup now, and another restores one. The backups live on the same disk as everything else, so copy them off the server now and then.
- **Admin page** at `/admin`, off until the server owner sets an admin password:
  - Storage: the image volume, the database, the images on disk, the images waiting for cleanup, and the last backup and the last good one. It warns when the last backup failed or no good one has run for 36 hours.
  - Every room with its size, images, last activity and whether it is loaded, sorted by last activity or size.
  - Pin or unpin a room (a pinned room is never unloaded to make space), or delete one after typing its room ID.
  - It never shows what is in a room and cannot enter one. A session lasts 12 hours, and repeated wrong passwords close the login for a while.
- **Cleanup of unused images**: once a day the server deletes replaced scene thumbnails, and once a week image files nothing names. Deleted image files wait 48 hours first, so a backup that is running still finds them. Images in a room's library are deleted only by its DM (see Images and art).
- **Admin commands** on the command line list rooms, create a room past the daily limits, pin or unpin a room, replace a lost DM link, import a large room backup, and make the admin password's hash.
- The X-card leaves nothing in the app's data or its logs. The HTTPS front end's own request logs, such as a reverse proxy's access log or Cloudflare's, can still record each request's address, the X-card's included, as they do for every request.
