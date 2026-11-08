# RaccoonVTT features

RaccoonVTT is a self-hosted virtual tabletop for D&D groups playing the 2024 rules (5.5e) on a square grid, 5 ft per square, or on hexes. It is made for phones first, and it works on tablets, laptops and a TV too. It suits a group around one table, players joining from elsewhere, or both, and a group that plays apart talks over a call of its own. One server hosts many groups at once, each in its own room. Dice roll on the server, so everyone sees the same result. Anyone can still roll real dice and type the total.

This page lists what RaccoonVTT does today, grouped by area. "The DM" means anyone who holds DM in the room, co-DMs included. [docs/design/mvp.md](docs/design/mvp.md) is the planning list: what is planned next, and what was skipped and why.

The app's Docs page (/docs) lists every written doc. To learn the tools as a DM, read the [DM guide](docs/dm-guide.md): a quick start, how to build maps and run fights, and worked scenarios.

<!-- Keep this page current: update it in the same change that adds, changes or removes a feature. -->

## Secrets stay secret

- The DM sees everything. Hidden things show translucent or dimmed to the DM.
- Players' devices receive only what the DM has revealed and what the party can see. Nothing else reaches them:
  - On the map: hidden tokens, hidden stamps, lights, monsters and map labels under the fog, the DM's fog edits before they are published, the map's other phases, and scene folders and thumbnails.
  - Ground: on a scene with fog, the build (floors, walls, doors, heights and stairs) where the party never saw or was shown it. On a scene where each player sees for themselves, the creatures and ground only other players' characters have seen.
  - Creatures: monster stats, other players' companion stat blocks, creatures out of the party's sight, and, where the DM keeps them secret, monsters' places in the Initiative order and their Initiative rolls until their turn.
  - Traps: traps nobody has found, and what any trap does.
  - Notes and sound: DM notes, DM-only journal pages, secrets not yet revealed, the room's sound library, playlists and what plays next.
- The log never tells players what happened to a creature while they could not see it, even after it is revealed.
- The map image itself reaches players whole, and each player's device draws the fog over it. A group has to trust its players with that.

## Rooms and joining

- A room is one campaign. It holds the scenes, tokens, characters, journal, log and Initiative tracker.
- Anyone who can reach the site can create a room from the Home page. Whoever creates it becomes its DM and gets a private DM link, the way back in as DM. Save it before going on.
- Each room has a short ID, such as `K7QH-2MXA`, and a player password the DM sets, at least 8 characters. The form suggests a three-word passphrase such as `owlbear-druid-wand`, easy to type on a phone.
- Players join with the room ID and the password, then pick themselves from the player list, so a new phone carries on as the same player. Someone new joins with a name and a color. There are no accounts.
- Anyone, DMs included, can change their own color at any time: Menu, then Members, then Color on your own row. Your pings, laser, rulers and buttons change at once. Drawings, pins and areas you already made keep their color. Here and on the join page, a color someone else uses carries their initial ("DM" for a DM, or a count when several share it) and stays pickable. The sample button and its note follow the theme: on light, orange buttons use the crest's darker shade.
- The player link carries the password, so opening it skips typing it. The DM can copy or share the link, or show its QR code for phones at the table, at any time from the DM panel or Members. "Copy player link" is in the Menu too. "Show password", beside the link, is there for anyone who would rather type it.
- **Joining**, in Menu, then Members, sets how new players get in: **With the password** (every room starts here), **With the password, or by asking**, or **Only by asking**. In Only by asking the password and the player link let nobody new in, devices already in stay in, and the Player link section says the link opens the join page, where new players ask. Changing the setting updates every DM device at once.
- **Asking to join**: in With the password, or by asking, the join page shows a "No password?" card under the password card, with Ask to join.
  - In Only by asking it shows the ask card alone, and a player link opened there sends nothing and says to ask instead.
  - The newcomer types a name, picks a color and waits on a page that says "Waiting for the DM", with a spinner that reads "You asked to join as Rowan."
  - A reload, a new tab or a locked phone keeps the request, and Cancel ends it.
  - If the DM stops taking requests, the page says so, and if they turn requests back on, that card offers Ask again.
  - Until a DM answers, the newcomer learns nothing about the room: not who is in it, which colors are taken, whether a DM is online or how many others are waiting.
- When someone asks, every DM device shows a toast, "Quinn asks to join.", with Review, and the DM tab, and on a phone the Panels button, show a count.
  - A **Join requests** section sits at the top of the DM panel while anyone waits, each request with Let in and Turn away, and Turn away all when two or more wait.
  - The first answer from any DM device wins.
  - While a request is being let in, its row stays on every DM device with its buttons off, a slow one says "Still letting Quinn in…", and one that fails, such as into a full room, says why on every DM device and waits to be answered again. The words stay for about a minute, then go on every DM device, even one with the panel already open.
  - A DM device that opens the room while someone waits says so once.
  - Nothing lets everyone in at once.
- **Let in as** on each request is Someone new by default, or a player who joined before (never a former DM), for a player on a new phone. Picking a player always says what the device will get: that player's characters, tokens and whispers. While that player is online, it says so too. A typed name that matches a player's is only a hint.
- A request ends by itself after 10 minutes. A device that was turned away can ask that room again after 15 minutes. At most 8 requests wait at once from one address in a room, and 50 in a room. One address may ask 30 times an hour in a room, not counting asks that were let in, and 60 times an hour across rooms. After 20 asks in an hour, a room asks each newcomer for the human check, if the server owner turned it on, and its DM devices stop toasting each ask, saying so once.
- If asking stops working, switch Joining to With the password, or by asking, and share the player link.
- A device stays signed in. Coming back never asks for the password again.
- Home lists the rooms this device has been in, and as whom. "Leave room" in the Menu goes back there.
- Forget on Home asks for confirmation before removing a room from this device's list. Cancel, Escape and Close keep it. Forgetting leaves the room itself and this device's sign-in intact.
- The DM can kick a player, change the player password and delete the room. A new password signs every player out and stops old player links. On Members, Manage on a member's row holds Kick and Remove. In a room set to Only by asking, a kicked player stays out, even one whose let-in was still finishing when the kick came.
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
- The connection mends itself. A dead connection is noticed within about 35 seconds. The app reconnects when the phone wakes or the network comes back, and catches up without a reload. Music and background sounds that a server restart cut off load again on their own once the room reconnects. Edits made offline are sent once it is back. A burst of large edits, such as two Builder rooms on a large map, goes out at the pace the server takes it, so every edit lands within a few seconds.
- A small dot shows the connection. A banner appears only after a few seconds offline.
- On a short screen, a notice that lasts (Reconnecting, the Starting view bar, a part that did not load, "Viewing as") keeps to one line, its buttons in the same row and More to read the rest, so it never stands over the toolbar. Where even that leaves no room for a row of the tool's options, the options stand over it.
- Other people's token drags move live, with their name over the token in their color.
- One finger uses the current tool, and with the Select tool a drag on empty map moves the map. Two fingers pan and pinch-zoom. With a mouse, the wheel zooms at the pointer, as two fingers on a trackpad do, and pointing at a token shows its whole name. Nothing needs a long press.
- Wheel and keyboard zoom wait until a token drag ends, so its grabbed point stays under the pointer.
- When the top bar is short of room, "Players see black" becomes an outlined crossed-eye icon in the DM badge's place. Its accessible label still says who you are and what players see. It opens the DM menu, whose first items are End the blackout and Show players <scene>.
- **The top bar gives way in a fixed order** as it fills, and gives everything back as soon as there is room again: when a fight or a blackout ends, a chip's words get shorter, or the window widens.
  - Search goes to its icon first and stays on the bar from 900 px up. Below 900 px it lives in the field at the top of the Panels list.
  - Then, from 900 px up, in a fight the turn chip's next faces drop from five to three, the clock chip leaves, Now playing shrinks to its icon, Players see black becomes the crossed eye, the DM chip keeps its dot, Now playing leaves, Full screen leaves, the Phase menu leaves, the next faces go, the gaps tighten and View folds into the Menu.
  - What leaves the bar is in the DM menu: Time, Now playing and the map's phases. W and the Menu still reach Full screen.
  - On a cramped bar the turn chip then cuts the acting creature's name, and drops it, with the whole name shown on hover or focus. An overrun timer shows only the time past it, such as "+1:25", and keeps its name "Turn time is up, 1:25 over".
  - On a player's own turn, if the bar is still short of room, the words "Your turn" leave the chip while End turn stays. A screen reader still hears the turn arrive.
  - On the tightest bar during a blackout, the crossed eye drops its caret to take the dot's width, keeping its name and tooltip.
  - Undo, Redo, the Search icon, the turn chip's round, face and timer, Next and Fit never leave.
- Tapping a token opens its action bar.
  - On a screen 600 px or wider, or a phone on its side, it opens as a window at the bottom right of the map instead of under the token.
  - Drag it by its header, or by the grip at the header's start ("Move window"). With the grip focused, the arrow keys move it, and Shift moves it further.
  - On a computer, drag the round handle at its free corner, or an edge beside it, to resize it ("Resize window"), and with the handle focused the arrow keys resize it.
  - It scrolls inside when it is smaller than what it holds.
  - This device remembers the spot and the size for every token's window, and the reset button left of Close ("Reset window position and size") puts both back.
  - Beside a phone's sideways sheet it narrows, and where it would be too narrow it folds into the sheet's header.
  - "Fit the map" keeps the map out from under it.
  - On a phone held upright it rests as a strip at the foot of the map with the token's name, AC and HP, a Damage or Heal switch, the HP entry and the actions used most that fit, such as Conditions and Roll. It stays put as you pan, so every token can be brought above it, and as it opens it moves the map just enough to keep its token in view.
  - On a screen too short for either, it opens taller, over the Multi-select bar and if need be the toolbar. Close it to reach the toolbar again.
- On a phone held upright, Expand, just left of the action bar's Close, opens the whole bar and moves the map so the token stays in view above it.
  - Collapse rests it again, and so does Multi-select, so the map is free for picking tokens. Each is a chevron with its name beside it where the resting bar has room for it and the token's whole name, as on a phone at the 85% interface size, and else the chevron alone, its name shown on a long press.
  - Conditions in the resting bar opens the bar with its grid, and closing the grid rests it again. A roll card that comes meanwhile leaves the grid open, and the bar opens again with it as the card goes.
  - A token dropped under the expanded bar moves the map once so it stays in view. A bar you open afresh rests. On a screen too short to expand, the resting bar scrolls to everything else.
  - While you type an HP change, the line under the name says what Apply will do, a kept Critical Hit and who it leaves out included, or why it cannot, and a longer message shows just above the bar.
  - Toasts keep above the resting bar, and where the map above it is short, a new toast shows as one line over the top bar, its button whole, and a tap on its words shows all of it, its time held until Close or Escape.
  - A phone's open sheet bounds the toasts the same way. In the very short sheet the toasts' place holds that one line too, and a tap on its words shows all of it until Close or Escape, with the sheet left open. A toast that waited there unseen when the sheet closes shows over the map as a new one.
  - Beside a sideways sheet the keyboard raises over the top bar, the one line keeps to the map left of the sheet. Where a sheet covers the one line's place, as a bottom sheet that fills a page the keyboard shortened, and in the very short sheet while the keyboard is up, the toasts wait until it closes, their time starting as they show, so a toast never hides under a sheet or moves the field you type in.
  - When an open menu takes Escape, including while its button holds focus, Escape closes the menu first and leaves the toast expanded. While it shows, the fight's alerts row that stood over the top bar moves into the resting bar's header, and goes back as the toast goes.
  - A toast that comes while the expanded bar's header stands where the toasts show starts just under the header, so Close and Collapse stay in reach.
  - The fight's alerts stand over the resting bar only where all their cards leave a band of map above it, else as their one row.
  - Layout: The whole bar is up to about two thirds of the screen. The toasts stay 60 px above an open sheet, and where under 44 px is left there, or beside a sheet held sideways, the newest shows as that one line and the older ones wait, their time starting as they show. With the on-screen keyboard open the sheet stands on it, and the toasts keep 60 px above that. With no sheet open they keep 8 px above the keyboard, and above the tool's buttons where those stand on it, and show as the one line where that leaves under 44 px.
- The action bar opens with a summary: AC, HP, then Speed after its footprints and "PP" for Passive Perception, as the token panel's quick numbers show them, for a creature whose stats you have, then the HP entry, then for the DM a monster's or NPC's six saving throws and its resistances, immunities and vulnerabilities from its stat block.
  - On a phone held sideways, a window made shorter than 300 px, or a screen too short for the whole bar, such as a small phone held upright at a larger interface size, the bar keeps AC, HP and the HP entry at the top, and "More stats" holds the rest. A phone held upright keeps one layout whichever token you tap, with Apply in view.
  - "Stat block" opens the whole block in the token's panel, with the action bar still open beside it on a wide screen or a phone on its side, except where the panel fills a very short screen. "Details" sits beside it.
  - A player's own character ends the summary line with a small "Sheet" link, named "Open the sheet", as the token panel's numbers do.
  - Where the summary does not fit on one line, Speed, PP, the "Sheet" link and the elevation, which a narrow window shows at the line's end, go together onto a line of their own, and where the saves do not, they wrap three and three, so nothing stands alone on a line. A Speed with several modes that do not fit on one line keeps its last mode beside PP, and what follows PP, such as Init or the "Sheet" link, stays on PP's line where it fits.
- The action bar's buttons come in rows.
  - On a phone held upright the resting bar shows what fits of these, Undo move as its arrow in Roll's place, and Expand shows them all.
  - Undo move (for players), Doesn't count and the door lead on a line of their own when they apply.
  - Then come Conditions, Hidden and Multi-select, always together on one line, then Roll (for the DM and the token's owners), Uses, and Light on a scene with party vision or while the token carries a light.
  - Uses leads with a lightning bolt in these rows, and keeps its word alone in the resting bar, where an icon would push another button out. Conditions and Multi-select keep their words alone, since an icon would cost the rows a line on a small phone.
  - Uses shows for the DM and a creature's owners when it has something to spend: Legendary Actions, Legendary Resistance, a recharge or X/Day ability, Regeneration or class resources. It opens the creature's uses above the button rows, where Conditions opens its grid, and one tap closes either.
  - A monster whose stat block is still loading holds the button's place, so Light and Attach never jump.
  - The last row holds Locked, Duplicate and Delete for the DM, or Dismiss for a companion's player.
- A tap on empty map closes the action bar. Panning, pinching and holding a finger down to ping leave it open.
- The fight's alerts and a docked action bar share the right of the map without covering each other.
  - Where there is no room for both, the alerts show as one row naming the most pressing one and how many more wait, and its tap hides the bar and shows them. A column that cuts its last card short, such as on a phone held sideways, says "Scroll for more".
  - Where the tool's options leave the alerts too little room for one whole card, as on a small phone with the Ruler, the same row stands for them, clear of the tool's buttons and of End turn.
  - Its tap opens a roll waiting for your answer, or shows the alerts over the tool's options until you tap elsewhere, and opens the alerts over the screen where the column has no room, until you tap Close, press Escape, go Back or press a card's button that opens a panel, such as a trap's Save and damage. A card you unfold in the column that no longer fits there opens the same way, over the tool's options or over the screen, so it stays in view.
  - A label's, pin's, light's or trap's pane opened as a bottom sheet folds the alerts away until it closes, so its header and Close stay in reach, and their row sits on the pane's top edge where there is room for it, and a tap on it closes the pane and shows them. A toast that comes while such a pane is open starts just under the pane's header, and one already showing at the top moves there as the pane opens.
  - A toast shown at the top while the phone is held sideways moves below all drawn cards as the phone turns upright, or stays above them where no toast row fits below.
  - A trap's toast, which comes with its own card, takes its place below all drawn cards as its card shows, or above them when no toast row fits below.
  - A toast already showing as a creature's turn starts follows that same rule once the turn's card or death save card shows, so the card's Show and words stay in reach.
  - A toast that comes while one at the top reaches down past the drawn cards starts under that toast instead, so neither covers the other's button.
  - Turned sideways with a pane open, the toast under its header moves to the top of the screen, or below all drawn alert cards, where a toast row fits.
  - Where toasts would run down over the tool's buttons, as on a small phone held sideways at 130%, the oldest whose words stay in the log and that have no button give way first, such as whispers, while a refusal or error the log does not keep stays. Past three toasts, only an older one of those gives way, so refusals, errors and toasts with a button all stay, and the stack scrolls where it runs past its room.
  - The rest scroll in the room left, the newest in view, so a trap's Save and damage always takes a tap, and a tap beside the scrolling toasts still reaches the map.
  - A screen reader hears each toast once, as it comes, even when it moves, and an alert that comes while the alerts are folded away names a trap only once.
  - On a wider screen the same pane, opened as a card by its thing, keeps left of the alerts, and where the screen leaves it no room beside them the alerts show as their one row, which the pane keeps under and whose tap closes the pane and shows them, so a trap that goes off while its pane is open never covers the pane's header, Close or sections.
  - Where the top bar leaves the pane too little room, as on a small phone held sideways at 130%, the pane stands over the top bar, so its header and Close stay in sight and take a tap.
  - The action bar keeps clear of notices that last, such as Reconnecting or the Starting view bar.
  - A creature's turn card never puts the alerts into their one row or moves the bar: under 600 px wide, or where it would not fit above the bar, it folds to one row, "Adult Red Dragon's turn: 3 uses", with Show, and where even that row would meet the bar, it waits in the creature's tracker row and bar instead.
  - Layout: Toasts keep 8 px left of a docked action bar, and the one line over the top bar, where the keyboard raises the bar there, keeps 12 px. On a phone, a toast that comes while the alerts show cards starts 8 px below all drawn cards, a creature's turn card included, so it clears their buttons. If less than 44 px remains below them, it stays above the cards, which reserve at least an 8 px gap below the toast.
- A toast that has no room below the measured alerts stays above them.
  - Layout: The cards immediately clear its bottom by at least 8 px.
- Alert cards keep their pushed position when only a toast expires. A change to the shown cards, the lane layout or the interface size resets that position to the current notices.
- A toast action keeps keyboard focus when the toast moves under a pane header or between stacks. A toast moves below its own alert card even when an older, shorter toast remains above it. The card starts below that older toast, leaving its buttons clear without moving the toast already being read.
- New toasts join the stack still on screen after its alert card, pane or expanded bar closes. They do not start another stack over the toasts still being read.
- On a phone held upright, an open sheet folds the token's action bar and the fight's alerts into one row on the sheet's top edge: a button with the token's name, its Close, and one button that names the most pressing alert and how many more wait. The token's name closes the sheet and brings the bar back as it was, a half-typed HP entry included. The alert button closes the sheet and shows the alerts, or opens a roll waiting for your answer. Where the screen is too short for that row, its buttons sit in the sheet's header.
- The fit button in the top bar ("Fit the map to the screen") brings the map back into view. A pinch anywhere but the map never zooms the page.
- Full screen gives the room the whole screen, without the browser's bars.
  - On a computer, Full screen at the end of the top bar turns it on, and Leave full screen, in its place, turns it off. W does both, for the DM and players.
  - Menu, This device has a Full screen switch, so a tablet or an Android phone has it too.
  - None of these show where the browser can't go full screen, such as Safari on an iPhone.
  - Where a narrow window leaves the top bar no room for the button, it waits until the window is wider, and W and the switch still work.
- On a Mac, full screen moves the window to a Space of its own, as the window's green button does. In Chrome and Edge, Escape keeps closing what is open, and holding Escape leaves full screen. In other browsers Escape leaves full screen first. The browser's own full screen, from F11 or the green button, is separate: Full screen still hides what the browser shows there, and leaving goes back to it.
- Android's Back button and the Escape key close an open sheet, handout or action bar before they leave the room. While the token's panel shows that token, they and the bar's Close put the bar away and keep the token in the panel. With the bar away, Escape lets go of the token.
- On a phone, panels open as sheets from the bottom, and the toolbar names each tool under its icon, as it does on any touch screen.
  - On a tablet held upright, the sheet is no wider than a dialog and stands in the middle of the map, with the token's actions and the fight's alerts on its top edge as on a phone.
  - On a screen 900 px or wider, panels are tabs in a side panel, in one row: the most used first, as many as fit, then More, which lists the rest.
    - Each tab shows its panel's icon, which leaves room for four, and names it on hover and keyboard focus.
    - A panel opened from More shows its icon and name on More, or its icon alone where the name would not fit, and the tabs never move.
    - On a touch screen, such as a tablet or a phone held sideways, the panel's name shows above it whenever the tabs show its icon alone, so no one needs a long press to learn which panel is open.
    - A count on a panel inside More shows on More too.
    - Hide panels at the end of the tabs, or the S key, hides the side panel, and Panels in the toolbar brings it back. This device remembers the choice.
    - A short screen, such as a large phone held sideways, starts with it hidden, unless a panel is open as the phone turns, which then stays in view and comes back as a sheet when it turns back.
  - Each panel opens scrolled where you left it, whether you come back by its tab, More or a link, in either of two panels, or in a phone's sheet. The Token and Dice panels do so for the token they showed, and open at their top for another.
  - The toolbar scrolls sideways when its tools do not fit, and with a mouse the wheel scrolls it.
  - On a phone held sideways, Hide in a panel's header tucks the panel away with its place kept, and Panels brings it back.
  - A panel's button that places something on the map, such as Add and place, leaves the side panel's panel open, so a tablet turned upright shows it as a sheet. One that waits for a tap on the map, such as Place a token or Pin to the map, keeps it tucked away behind Panels instead, with the map and the tool's options in view.
  - Where the screen is too short for a panel beside the map, it opens over the whole screen, with the token's actions and the fight's alerts as buttons in its header, and the room's notices, "Your turn" and messages between the header and the panel.
- Two panels, at the top of More, shows two panels at once, one above the other, such as Initiative above a token's stats, or for a player their character's page.
  - The tabs pick the top one. The bottom one starts on Token for the DM and Characters for a player.
  - The bar between them names it: press its name to pick another, or use Swap panels or Close, and drag the bar, or move it with the keys, to share the room.
  - A link that opens a panel, such as Stat block, Details or a pin's page, leaves an open panel where it is and otherwise opens in the other pane, so the panel you are reading stays.
  - This device remembers the two panels and where the bar sits, for a DM and for a player.
  - A side panel too short for two shows the top one until there is room, and a phone shows one panel at a time.
- From 900 px up, drag the side panel's left edge to widen it, from 360 px to 640 px, as far as the map keeps 600 px, so a window under 960 px keeps the panel at 360 px.
  - Reset width, beside Hide panels, or a double-click on the edge puts it back.
  - With the edge focused, Left and Right resize it, and Home and End give the default and the widest.
  - This device keeps the width.
  - A narrower window draws the panel narrower until there is room again, and the top bar gives way as the map narrows and brings each part back once it fits.
- Swipe a sheet down to close it: from its header at any time, or from anywhere on it once it is scrolled to the top.
  - A short grabber at the top of a sheet shows that it swipes, in the design picked in This device, and fills with your color and stretches as you pull it, fully when a slow release would move it.
  - A sheet holding unsaved input keeps the handle from filling completely toward closing, while expanding or stepping down still fills it.
  - A slow swipe settles on the nearest place: past halfway down it closes, and short of that it springs back. A quick flick down closes it at once.
  - Panels, the menus and pickers that rise from the bottom (such as a scene's menu, the monster filters and Request a roll), the X-card, and the label, pin and light panes all close this way, and a roll request swiped down waits for later, as Later does.
  - A sheet holding something you typed and have not sent or saved, such as a chat message or an encounter being edited, springs back and stays open.
  - A sheet on the right of a phone held sideways keeps Hide and Close.
- Swipe a panel up from its header to fill the screen, as a video app's comments do, or use the Expand sheet button that Tab reaches in its header (the up arrow, with a mouse). From there a short swipe down brings it back to its normal height, a long swipe past halfway to the bottom or a quick flick down closes it, and a slow swipe between the two settles back at the normal height. Each panel opens at its normal height.
- With a mouse or trackpad on a window under 900 px, a sheet that swipes shows a small up arrow and down arrow beside its grabber.
  - Up (Expand sheet) fills the screen.
  - Down brings a full sheet back to its normal height (Shrink sheet) and, from the normal height, puts the sheet away as a swipe down does (Put away sheet). A sheet with something typed in it stays, as it does for a swipe.
  - Menus, pickers and panes at the screen's foot show Down only, and on a roll request it is Put away roll, which waits for later as Later does.
  - The strip around the grabber also drags with the mouse, as a finger swipes. A drag on the title or the content selects text as before.
  - A touch laptop keeps its swipe too, and only one of the two moves the sheet at a time. A touch-only phone shows no arrows.
- Swiping right in a panel goes back.
  - Swiping back keeps the live page's radio choices unchanged.
  - Swipe right in a panel to go back, as its Back at the top left does: from a panel to the list of panels, with focus where Back puts it, and from a page inside a panel, such as Members or a journal page, to the panel.
  - The panel's page follows the finger under its header, over where Back leads, the list of panels or the panel's first page, dimmed until the page has gone. Where that panel is very long (over 2,000 elements, as a full Initiative list is), the swipe shows the plain dimmed panel there, not a picture of it.
  - Past half its width, or with a quick flick right, it goes back, and short of that it springs back with nothing changed.
  - The first movement decides: a swipe that starts up or down stays a scroll or a sheet swipe all the way.
  - A swipe that starts on something that scrolls sideways and is not at its left edge, such as the quick dice or a wide table, scrolls it instead. Sliders, text fields, selected text and a held roll button keep their own drags too.
  - A swipe that starts at the screen's left edge stays the browser's or the phone's own Back.
  - A panel holding something you typed and have not sent or saved springs back and stays, as it does when swiped down.
  - Reduced motion goes back or springs back at once, with no slide.
  - A mouse never swipes back.
- On a phone, whatever you type in rides on the on-screen keyboard: its foot stands just above the keyboard, it grows no taller than the room left above it, and the field you type in scrolls into view with its buttons, such as Lay on Hands' amount with Spend and Cancel, or the HP change field with Apply.
  - That holds for a sheet and the row on its top edge, a sheet on the right of a phone held sideways or over the whole screen, a dialog such as Add a class resource, the token's action bar with its HP entry and its Uses drawer, the tool's options, a roll request card at the foot, the fight's alerts, a label's, pin's, light's or trap's pane, and a pop-up, which opens in the room above the keyboard.
  - A scroll of your own while you type is left alone, a tap on a button such as Spend lands with the keyboard still up, and once the keyboard closes everything goes back where it was.
  - Where there is too little room for the field and its buttons, as on the smallest phones or a phone held sideways at a larger interface size, the sheet, the dialog or the token's window takes the whole height above the keyboard, over the top bars, the dock's buttons join the sheet's header, a dialog's title steps out of sight and a pop-up's title and "Scroll for more" go, all until the keyboard closes.
  - While you type the room never turns sideways or changes its layout, even where the browser makes the page shorter.
- On a phone, the DM's setup tools (Add token, Pin, Trap, Map builder and Line up grid) sit behind Setup in the toolbar, which then shows the one in use. Their keys still pick them directly. On a computer all eleven tools stay in the toolbar. On a phone held upright the tools share the whole row up to Panels, so a player with few tools, such as with drawing off, still has them end where Panels starts.
- A tool's options take one row.
  - On a phone held upright it sits above the toolbar.
  - On a phone held sideways it shares the toolbar's row, so the map keeps its whole height, and where the tools and the options do not fit side by side the toolbar shows Select and the last tool you used, whose second tap opens every tool.
  - On a computer it floats above the toolbar.
  - What does not fit the row waits behind ⋯ (More options), and a wider screen shows more of it.
  - Choices with many values, such as the drawing tool, a color or an area's shape, show their value on a button that opens a small pop-up above the row, and the map stays live under it: two fingers still pan and zoom, and a tap on the map closes it without drawing or pinging.
  - Buttons that show a value, such as an area's shape, add their icon where the row has room.
  - The tool's hint or reading floats above the row on one line, and a tap shows all of it when it is cut.
  - A wait there, such as "Finding the way…", "Checking players' remembered map…" or "Looking for a grid…", is muted with a small spinner and keeps the line's place, so nothing over the map moves for it.
  - A refusal or a failure, such as "No grid found.", reads in the warning color, and the green says only that something worked.
  - A second tap on the active tool hides its options, and another brings them back, while the tool stays in use. For a tool behind Setup or the tool menu, picking it again there does the same.
  - While a task is under way, such as an area not yet placed, a small "options hidden" line stays, and a tap on it brings them back.
- With a keyboard, the key of the tool in use shows its options if they are hidden and goes to its next main choice: Area's shape, Draw's drawing tool, the Ruler's Straight or Walking, Fog's Clear fog or Add fog, the builder's mode, Add token's blank kind and the Trap's zone.
  - Shift with a letter key goes back, and a held key moves once.
  - A drag in progress keeps the choice, and so does anything a change would lose: a shape, a room or text not yet finished, an area from a spell, or a label being edited.
  - Select, Ping, Pin and Line up grid have no such choice.
- Panels are listed with the ones used in play first, in an order that never changes with use. A DM's phone list and the side panel's More group them under In play (Token, Initiative, Dice, Log, Journal, Areas), Run the table (DM, Scenes, Sound, Time) and Prepare. A player's list has no groups, and Sound and Time follow Areas for them.
- A page inside a panel, such as a journal page, a character's page, a monster's stat block, an area's damage page, the encounter editor or a Menu page like Members, puts its own name at the top, with a back button that says where it goes, such as "Back to Journal".
- Add to Home Screen installs it as a full-screen app on an iPhone. The screen stays awake during a session.
- The app's icon is a raccoon face on a white rounded square, the shape of an iPhone app icon, in the browser tab, on the Home Screen, on Home and About, and over the docs.
- Phones load a smaller copy of each map, and the map redraws only when something changes.
- A panel that cannot load, offline or after the site was updated, says so inside itself, and the rest of the room keeps running. Its Reload waits until your changes are saved and the connection is back, and opens the panel again. The SRD monster list and stat blocks offer the same Reload when they did not load.

## Scenes and maps

All of this is the DM's.

- A room holds many scenes. The DM moves the players to a scene, and can prepare another one privately while the players stay where they are. The Scenes panel marks the players' scene "Players here". Each scene's row says whether it has a map image, its size as its Size and view summary says it (the whole hexes a hex scene holds, not its steps), and whether fog is on.
- A new scene is a Battle mat (a blank grid with a background color), a Map image, or a Builder scene. Its **Grid** row picks Squares, Hex rows or Hex columns. "From a Universal VTT file" brings in a whole map (below), and a Builder scene can start from a generated dungeon (below). Cancel folds the new scene form away, and during an upload it stops the upload and keeps the form. Each new scene starts on what players see of it, the room's choice or "Like" the scene on screen (Fog and vision).
- **A scene's settings**, under New scene, start with the scene's name under **This scene** and gather the rest in six groups by what the DM is doing: **Light and weather** (the light, **Light per phase**, and the weather), **Scene sound** (the scene's own sound, while the server offers sound files), **Fog and vision** (Players see, Sight, who sees for themselves and **Sight sources**, the **Switches** fold of Fog and Party vision, and Copy to other scenes…), **Map and grid** (the map image, its phases, the grid lines' look, **Grid shape**, Line up the grid, Find the grid and the **Square count**), **Walls and movement** ("Walls and ledges block players' moves", Automatic walls, Open the builder and Clear the build) and **Size and view** (size in squares, or in feet steps on a hex scene with the hexes it holds, background, starting view and suggested view).
  - **Export** follows them and never folds. Delete is in the scene's ⋯ menu.
  - Each group is a row like the token panel's, with its icon, and a tap on its name folds it or opens it again.
  - Folded, a group says what it holds at the row's end: "Dim · Heavy rain · Strong wind" (the light only while party vision is on, and "Clear" with no weather), "Tavern night, Cave drips", "Silent" or "None of its own", "Explore" (with "· Per player" when Sight is), "Map image · Hex rows, 50 px" or "No map image · Squares", "Walls block moves" or "Walls do not block moves", and "20 × 14 squares" or "40 × 34 hexes" (with "· Isometric" when that is the suggested view). Where the row has no room for both, the summary moves whole under the group's name.
  - Folded on Explore over a map image with no walls, Fog and vision's row wears a **No walls** tag, so the warning inside is never out of sight. With party vision off, Light says it works only with party vision.
  - The Switches fold opens chevron first like the other folds, and says "Fog on · Party vision on" or how else they stand while folded.
  - On a phone only Light and weather starts open, on a wide screen every group does, and each group stays as the DM left it on that device, on every scene. Folding a group never stops an upload or loses counts typed in it. **New scene** folds too: folded on a phone, open from 900 px up and while the room has no scene.
- **Starter maps**: "From starter packs", under Map image, makes a scene from one of 45 openly licensed maps: 29 of Dyson Logos's hand-inked maps, the 5 Scarlet Heroes maps, 10 Index Card Dungeons and a painted cavern, by pack and then by setting, such as Taverns and inns or Crypts and tombs, with a search over names and tags.
  - The map is copied into the room with its credit.
  - The 22 maps whose drawn grid the build measured start lined up on it and skip grid alignment. The rest open on Line up grid, as an upload does, with the box already at the drawn squares' size on the 5 where only that was measured.
  - Ink-on-paper maps start with a dark grid that shows on white.
  - See Images and art for the starter packs.
- The server resizes and re-encodes uploaded maps and makes a smaller copy for phones.
  - A scene's map image is added, replaced or removed at the top of its Map and grid settings, with Cancel on a line of its own under the ways to bring an image.
  - Changing the map image of the scene the players are on asks first, since they see it at once: the sentence that says so comes first, then the first map's fog choice, then the ways to bring an image.
  - Layout: Use the still only stands last on the line of ways to bring an image, and Remove map image takes the last line, the full width, so its second tap's longer words never move another button.
- "Line up the grid" fits the grid to a map that has one drawn on it: drag a box over 3 by 3 squares and fine-tune it by its corners, or type how many squares the image has across and down. Snapping, rulers and areas then match the drawn squares.
  - On a hex scene the box is 3 hexes across and holds 7 hexes (3 by about 2.9 cells on hex rows), keeps that shape as it is dragged, resized by its corners or nudged, and the hexes it proposes draw over the map. Typing counts across and down is for squares only ("Counting works on squares. Use the box.").
  - A new map scene shows the app's own grid lines over the art, and "Grid lines" in the Grid tool or the Scenes panel turns them off for art that has its own.
  - While Line up grid is open, the DM's board hides the app's own grid lines, squares or hexes and their copy over built floors, so only the art's lines and the proposed grid show. They come back when the tool closes. Nothing is sent, the Grid lines setting stays as it was, and players' boards are unchanged.
- Switching Grid shape while Line up grid is open keeps the box size you measured. A find already offered for the new shape still brings its own measured box.
- A map image whose file name gives no size that fits the scene's grid, for a new scene or in place of a scene's image, is searched for a drawn grid while it uploads, on the DM's device.
  - Every search looks for squares, hex rows and hex columns at once, so the DM never has to say which the map has. Hexes drawn with lines too thick for the first look are looked for again at half and at a quarter of the size, so a large map with heavy lines is found too.
  - A found hex lattice goes on the scene only when measured clearly regular, which heavy lines on a small map can leave too coarse to tell, and hexes found at a quarter of the size only on a map 1,200 px tall or more (wide, for hex columns): otherwise they only offer the box.
  - When only the stretch margin holds back a find that would otherwise be sure, with its turn measured and no competing shape, the scene still switches to the found hex orientation if allowed. The grid and scene size stay as they were, and the box is placed for the DM to check and Apply. That switch is one step in Setup history, and Use default after an import puts the old shape back. Searches that protect an existing grid never switch its shape.
  - A grid found with confidence goes on the scene, and Line up grid opens on it saying "Found a grid of 70 px squares." (or hexes), with Use default to go back to the first guess and the scene's size before it. Hexes found on a new map in a square room start the scene on hexes with their grid, and squares in a hex room on squares, saying "Found hex rows of 70.4 px. The grid is hex rows now."
  - Use default restores the shape, grid alignment and scene size together, including maps with phases, as one Setup undo step labeled "lining up the grid". When the scene can no longer go back, as when heights now stand on its hexes, Use default changes nothing and says why. If an edit on another device prevents that return, the server refuses the whole reset.
  - A less certain find only places the box on the scene's grid, to check and Apply.
  - On a phone or an iPad, a map over 4,096 px on a side is searched on the server's smaller copy once it uploads, and a search that needs longer goes on in Line up grid after the scene opens, saying "Looking for a grid…".
  - "Find the grid", in Line up grid's options or the scene's Map and grid settings, looks again at any time on any map, and Undo setup, in Setup history, takes back a grid it applied. Apply or a move of the box stops a search still running, so a late answer never replaces your own grid. If the scene's image, grid, grid shape or size changes while it looks, on any device, a grid it then finds is not applied, and Line up grid says so. A grid found before a switch of Grid shape is dropped with the switch, unless it was found for the new shape.
  - Find the grid works on hex scenes too, and a sure find of the other shape switches the scene's shape with its grid in one Setup history step when the scene can change shape. When it cannot, as with painted ground on its squares, the line says why ("Found hex rows of 70.4 px, but this scene has painted ground…"). Any other less certain find of the other shape only says so ("These lines may be hex columns of 70.4 px. Change Grid shape to use them."), and changing Grid shape then brings its box. A map showing both shapes, such as squares drawn over hex floor tiles, is only offered on the scene's own shape, naming both ("The map shows squares of 70 px and hexes of 52 px.").
  - A new image of the old one's shape keeps the scene's grid, scaled to it, and is searched all the same: a grid found there that differs from the scene's, sure or not, only places the box ("These lines may be the map's grid…"), since the DM may have lined the old grid up by hand, and lines where the scene's grid already is say nothing, also when a phone's search runs on in Line up grid. The same file again keeps the grid and is not searched.
  - A size in the file name wins on every grid.
    - The counts are read as that grid's cells: `crypt_30x20.jpg` is 30 squares across and 20 down on squares, and on a hex scene 30 hexes across and 20 down, when the image is exactly as wide and tall as that many hexes (hex rows are 30 and a half hexes wide, and hex columns are tall by the same rule).
    - The scene is sized to hold the art, and on a hex scene every hex of it, so that art makes a scene 31 across and 18 down (20 rows, 30 hexes in each). Scenes made before that keep the size they have.
    - Art that replaces another and is named for a new scale resizes a scene whose size still followed the old art, and puts the size and the art in one Setup history step.
    - A name whose counts do not fit the scene's grid sets no scale, and the grid is looked for as usual.
  - A Universal VTT import keeps the grid its file states: on such a scene Find the grid, and the search of a new image for it, only place the box, saying the scene came with its own grid. Square floor tiles laid edge to edge can read as a grid, so the box is worth a look.
- Grid lines take a color, opacity and line width, or hide. A scene's size in squares and its background color can change.
- **Hex grids**: a scene's grid is Squares, Hex rows (pointed tops, rows run straight across) or Hex columns (flat tops). New scenes are squares unless the DM says otherwise.
  - **Grid on new scenes**, last in Room settings' Grid and distance, sets what a new Battle mat or Map image starts with, and the form's Grid row changes it for one scene. A Builder scene, a starter map and a Universal VTT import start as squares whatever the room says, though the form can pick hexes for a Builder scene or a starter map.
  - **Grid shape**, in a scene's Map and grid settings, changes it later, and a map scene that changes shape opens Line up the grid. Grid on new scenes, the form's Grid row and Grid shape are one choice drawn one way: three options sharing a row, a long name wrapping between its words, and one per row on a narrow phone at a large interface size. The form's Kind of scene does the same.
  - The choice is refused, with the reason under it, while the scene holds something that can't stand on the other grid (painted ground, walls and doors on grid lines, heights, stairs, difficult ground, traps, a squeezing creature, Builder room's shape in a fog draft), and for a scene that came with its own square grid from its file.
  - Each existing scene stays squares, and a room's squares play exactly as before.
  - A cell is the distance between two hex centers, the room's feet per square, so a hex is one cell across its flat sides.
  - Layout: Hex lines draw only while a hex is at least 6 px across.
- On a hex scene tokens snap to a hex. Tiny, Small and Medium creatures take 1 hex, Large 3, Huge 7 and Gargantuan 12 (the DMG's table), and a custom size reads as its size category. A resize keeps the creature's reference hex. Placing, duplicating and companions search rings of hexes for a free spot. The selected token shows the outline of its hexes. Words that name a square say hex on a hex scene, and Room settings say "square or hex" while the room holds a hex scene or starts new ones on hexes.
- Each scene can have a starting view ("Save current view").
- Switching scenes shows "Loading <scene>…" over the old scene until the new one and its map are in. Players moved by the DM see the same.
- Duplicate a scene from its menu, choosing what comes along: monsters, NPCs and objects, player characters, fog, and drawings and placed areas.
- Folders: "Move to folder…" files a scene under a header that folds with a tap. Each scene shows a thumbnail of its map, redrawn when the DM leaves a scene they changed, or with "Update thumbnail".
  - The menu's last row, "Delete", removes the scene with its tokens, drawings, build and fog. It asks for a second tap on the same row first, and a tap anywhere else cancels it.
  - The last scene in a room cannot be deleted, and neither can the scene the players are on until they are moved to another: its Delete, in the menu and at the end of the scene's settings, says "Move the players to another scene first." An Undo setup or Redo setup that would take it away says the same.
  - Players never see folders or thumbnails.
- Map phases: up to 7 other images of the same map (8 in all), such as day and night or on fire, that keep tokens and fog in place. A chip, or the Phase menu on a wide screen, switches with one tap. A phase can bring its own light level, so Night can make the scene dark. Players get only the phase showing, never the others or their names.
- **Animated maps** ([design](docs/design/design-v1-animated-maps.md)), while the server's owner has turned them on: a WebM (VP8, VP9 or AV1), MP4 (H.264 or AV1) or MOV (H.264) of up to 64 MB, 1 second to 10 minutes, 60 frames a second and 3840 × 2160 (8.3 megapixels, no side over 4096), wherever a map image comes in: New scene's Map image, a scene's Map and grid, and Add a phase.
  - The DM's device reads the video's first frame as the map's still, then uploads the video and the still, each with its percent ("Uploading the video… 42%"), and the grid is looked for on the still.
  - A name like `crypt_30x20.webm` sets the scale as for an image.
  - Cancel stops any step. A refused video says why, such as "That video is HDR, which looks washed out on the map. Export it in SDR."
  - Phone videos show the way the phone showed them ([design](docs/design/design-v1-video-turns.md)).
    - A video recorded upright, turned, mirrored or with stretched pixels (up to twice as wide or tall) is accepted, and the server rewrites only the file's headers, so every browser plays the same plain picture and the app turns or stretches it on the map, in the Library and in its still.
    - An iPhone's MOV, recorded with Settings > Camera > Formats > Most Compatible, is stored as an MP4 without its location, face and device data. That is about 30 seconds of 1080p video under the 64 MB cap.
    - HEVC, the iPhone's High Efficiency default, is refused on the device before anything uploads, with how to export it as H.264, and a video whose file crops its picture is refused too.
  - When the DM's device can't read the first frame before the upload, or the video is turned or stretched, the still is read from the uploaded copy instead, and the button says "Reading the first frame…" again. A device that can't read that either (a WebM on an iPhone before iOS 17.4) asks for a still image of the video's shape as it shows, keeping the uploaded video, and after iOS Low Power Mode refused it, offers Try again.
  - The map moves for everyone on its scene, under the board, the tokens, darkness, fog and weather. Each device loops its own copy from its own start, with no sound. Players get only the video of the phase showing.
  - The Map image row says "A 1920 × 1080 px video, 0:42, looping. Its first frame is the still." (the size as it shows, so a portrait phone video is 1080 × 1920) and, under it, "Moving on this device." or why this device shows the still. **Use the still only** drops the video in one Setup step and keeps the still as a plain map. A video phase shows "Video" after its name.
  - A device shows the still when its Animated maps is Still, under Low power or reduced motion, in Isometric and while the Builder, Fog, Line up grid or Trap tool is in use, when it cannot play the file smoothly, on Phone size map detail past 1920 × 1080 or 30 frames a second, and after the video slowed it, until a reload. If the browser refuses to start it, a tap on the map tries again.
- "Export as image" saves a scene's map as a PNG: the map image and the build, without tokens, drawings or fog. Pick 50, 70 or 100 pixels per square, the grid on or off, and the player view or the DM view.
  - The file name carries the grid size, such as `crypt-30x20-70px.png` (with `-dm` added for the DM view), so other VTTs set the scale on import.
  - A hex scene exports pixels per hex with its hex lines ("Hex lines") and is named like `crypt-hex-70px.png`, since a WxH name would read as squares.
  - A very large scene exports at fewer pixels per square, to stay within what an iPhone can draw, and says so.
  - On a phone or tablet that can share files, the made image offers **Save or share**, which opens the share sheet, beside **Download**. An animated map exports its still image.
- Universal VTT import (always squares, and a room whose default is hexes says so in the summary): a `.dd2vtt`, `.uvtt` or `.df2vtt` file from Dungeondraft, Dungeon Alchemist, Arkenforge or DungeonFog brings the map image, grid, walls, doors, windows and lights at once, and a door Arkenforge draws as an outline comes in as one door.
  - It shows what it found before it makes the scene, asks what players see there, and suggests the scene's light level.
  - A map that brings lights of its own starts dark with party vision on (Explore), so its lights light it for the party, and the summary opens by saying so with the count and Keep it lit beside it (Bright, and what players see goes back to the room's choice).
  - A conversion retried with different options updates that line and its proposed light, keeping any light or Players see choice the DM already made.
  - A map whose ambient light is 70% or brighter keeps its daylight, and one whose image is already lit with no lights stays Bright.
  - One Undo setup in Setup history takes it all back. A phone takes files up to 40 MB, so large maps import on a computer.
- **Generate a dungeon**, under New scene's Builder form ("Or start from a generated dungeon"), makes a whole Builder scene on squares: rooms joined by corridors, automatic walls, a closed or locked door at every doorway, and a way in at the room nearest the map's edge, a closed door and then a corridor to stairs at the edge. The dialog's choices are Theme, Size, Rooms, Density, Corridors, Corridor width, Extra ways around, Heights and Traps.
  - **Theme**: Dungeon (stone and wood rooms, rubble and pits, about 1 door in 7 locked) or Crypt (stone halls whose rooms 5 by 5 or larger have a ring of pillars, about 1 door in 4 locked). Any room 6 by 6 or larger may have a dais 5 ft up with a stair.
  - **Size**: Small, Medium or Large (30, 50 or 80 squares a side) or Custom (20 to 100 across and down), shown in the room's feet. **Rooms** run from 2 up to one per 90 squares and at most 40, and start at 6, 12 or 20 by size. **Density** is Sparse, Normal or Dense.
  - **Corridors**: Straight ones take the shortest way between doorways that face each other, turning only where they must.
    - Bending ones take a few deliberate turns, their doorways set off the line between the rooms.
    - Winding ones snake from side to side and wind round a room where the rock between two rooms is narrow, so they run longest.
    - The three look different at every size.
    - The rooms stay where they are when Corridors changes, though which rooms are raised and the dressing can change with the doorways.
  - **Corridor width** is Narrow, or Wide with double doors, so Large creatures walk through without squeezing once the doors are open.
  - **Extra ways around** adds loops, so the way back is not always the way in.
  - **Heights**: a slider from Flat to 75% of the rooms raised or sunk by 5 or 10 ft, in steps of 5%, never the entrance room, with the marks Flat, Few (10%), Some (25%), Many (50%) and Most (75%) under it and its value read beside it, such as "About 3 rooms of 12 off flat ground". Each raised or sunk room is reached by a straight flight of stairs from each of its doors. A map with little rock between its rooms may raise fewer.
  - **Traps**: a slider with the marks None, Few (one per six rooms), Some (one per three) and Many (one per two), and a step between each, read as a count such as "About 4 traps", at most 20. While it is above None, **Party level** (1 to 4, 5 to 10, 11 to 16 or 17 to 20) sets how strong they are: their save DCs, damage and pit depths follow the SRD for that level. They are the SRD's example traps: Hidden Pit, Spiked Pit, Falling Net and Poisoned Needle. None is in the entrance room, and players see one only once it is found.
  - A slider steps with the arrow keys, goes to its ends with Home and End, and jumps to its next or previous mark with Page Up and Page Down. A tap on a mark's name sets it.
- **The generator's preview** is the map drawn from exactly what Make the scene sends, with each trap's zone hatched and the entrance ringed.
  - **Reroll** draws another dungeon from the same choices.
  - The **Seed** (16 letters and digits such as `5K7Q-H2MX-A9F3-TWQ5`, read without regard to case, spaces or dashes) makes the same dungeon again on this version of the app, and **Copy seed** copies it in that form, however it was typed. A seed from another version says it makes a different dungeon now. The seed is never stored or sent: the dialog remembers this device's last choices for the room, never the seed.
  - The foot counts rooms, doors (locked ones in brackets) and traps, and a line above the choices says when fewer rooms fit than asked or when fewer than two fit, which turns Make the scene off. Make the scene stays off, with "Drawing the dungeon…", until the new dungeon's picture is on screen, so it always makes the dungeon shown. A picture this device cannot draw says so and keeps Make the scene off until a Reroll or another choice draws one.
  - Layout: On a computer the dialog is wide and the preview fills its column, as tall as the dialog's body allows, while the choices keep at least 360 px beside it once the window is wide enough.
- **Make the scene** sends the dungeon as ordinary builder changes in one Setup step, so Undo setup in Setup history usually takes the whole dungeon back, and the scene's Delete always does once the players are on another scene.
  - Undo setup is refused for the players' scene just as Delete is, so move the players to another scene first for either.
  - Make the scene opens the scene with the Map builder picked, framed on the entrance room, on this device only, so every other device opens it as any Builder scene, and no starting view is stored.
  - The foot counts the answers ("Making the dungeon… 18 of 30") while Cancel becomes Hide, and says "Waiting for the server…" offline. The choices, Reroll and the seed wait while it sends, and after a refusal partway, so nothing changes the dungeon on its way (Copy seed still works).
  - Once the dialog closes on a dungeon sent, New scene's form starts over, so its Create makes no second scene.
  - If the connection drops while a dungeon is made, the app opens the new scene and checks it against the preview before it calls the dungeon complete. A refusal partway, or a check that cannot be confirmed, says so and how to take the scene back.
- **Players and a generated dungeon**: players see only what map discovery shows them, with locked doors as closed and traps hidden until found. Where the form's Players see leaves fog off, the dialog warns that every room shows at once.
- On a hex Grid the Generate a dungeon button is off, with "Generated dungeons are squares for now. Pick Squares above to make one."

### Isometric view

Everyone, the DM and every player, picks how their own device shows the map.

- The **View** button in the top bar, before Fit, shows a square grid in Top-down and a diamond in Isometric, turned with the view. It opens the View menu, a pop-up on a wide screen and a sheet on a phone: "Follow the scene", "Top-down" or "Isometric", then "Turn left" and "Turn right".
  - In Top-down the turn buttons stay, disabled, with "Turning works in Isometric." under them.
  - On the narrowest phones at a large Interface size, or on a crowded wide bar, the button folds into Menu as a **View** row that opens the same sheet, so Undo and Redo keep their place in the bar.
- **Isometric** tilts the map and stands what is on it up: creatures as standees with a ring and a shadow on the ground under them, walls in stone, doors in wood stained darker than a wood floor, windows as panes, pillars, map labels, pins and the names of areas and traps.
  - Raised ground stands up with the builder's textures, lighter on the left and darker on the right, and pits sink.
  - On squares a raised floor reads as one surface rather than a stack of squares: its side shows a line only at its ends and where its height or floor changes, and a faint line on top marks each square, grid or no grid.
  - On hex rows and hex columns a raised hex stands as a six-sided block with three sides showing, each side outlined, and a hex pit sinks the same way.
  - A map image's raised ground takes its sides' tone from the art on top, on a hex scene from the art wholly inside a hex the viewer sees whole.
  - **Turn left** and **Turn right** turn the map a quarter at a time, so a wall never hides the creature behind it for good.
- **Depth up close**: from 24 px a square, or 48 px with Low power on, walls stand as stone slabs with a lighter top, and a long wall reads as one wall that meets the next cleanly at a corner.
  - Doors and windows stand in a stone frame. An open door stands upright on its hinge, swung back into the room as Top-down's swing shows, and tapping it opens the door's buttons, as tapping its doorway does.
  - Stairs with a direction climb in steps from the ground below them to the ground above, and their sides show the floor they are on. Creatures stand on the steps. Stairs that turn a corner keep a flat top with their marks.
  - Below that zoom a closed door or a window stands as one panel, an open door lies flat with its swing, and every stair keeps a flat top.
  - On a hex scene doors and windows stand in frames as well, while stairs keep a flat top and walls stand without thickness at every zoom.
- The pick is this device's, for the whole room and every scene, until Follow the scene is picked again. Each scene keeps its own turn. A table display picks its own, apart from a member's pick in the same browser.
- **Suggested view**, in the Size and view group of a scene's settings after Starting view, is the DM's: "Top-down" or "Isometric", with the help "Devices that follow the scene show this view." A device that follows the scene switches once a drag, a pinch or a held ruler in progress ends, so the map never moves under a finger.
- Everything works in Isometric as in Top-down: select, drag (a creature climbs a platform and steps down into a pit under the finger), measure, ping, aim areas, open doors, read heights. A tap again on the selected standee picks the one behind it, and the arrow keys move tokens by the screen: Up goes toward the map's edge that faces up and to the right.
- An animated map shows its still in Isometric.
- Four tools show Top-down while in use, and say so: the map builder, Fog, Line up grid and Traps ("The map builder works top-down. Isometric comes back when you switch tools."). Isometric comes back when another tool is picked.
- Areas stand as their real shapes: a sphere as a sphere, a cone aimed up or down as stored, a cylinder, a cube, a line, an emanation round its creature, each see-through with an outline, down into a pit, so a flier inside one shows inside it, its caught ring round its feet.
  - On a player's device an area stands only where every bit of the ground under it is revealed and in their sight right now (or, without party vision, revealed to them), and lies flat as in Top-down anywhere else.
  - Areas stand nearest the middle of the screen first, and "Building area shapes…" shows while any still lies flat waiting. A DM-only area stands dimmed with a dashed outline on the DM's device.
- Isometric keeps every secret Top-down keeps. On a player's device something stands up only where all the fog under it is revealed to them, and anything else lies flat under the same fog. An open door stands only where all the floor under its leaf is revealed, and stairs climb in steps only where the player has seen every stair of the run and the ground at both its ends. On the DM's device a standee on ground the DM's map shows fogged draws dimmed.
- A screen reader hears each change: "Isometric view.", "Top-down view.", "Following the scene: isometric." and which way the map's top edge faces after a turn.

### What stays square

Hex grids are complete: everything else in this list works on a hex scene, by hexes. Only what follows stays square, and each says so on a hex scene, in plain words, where the DM would reach for it.

- The builder's line on a hex scene, for the modes hexes leave out, reads "On hexes the builder draws wall lines, paints heights and stairs, marks difficult ground, and places lights, stamps and labels. Painted ground needs squares."
- **Square for good**: painted ground and rooms, pillars, automatic walls, the **Square count** row in Map and grid, the Universal VTT import (it makes a square scene) and the export's WxH file name.
- **Square for now**: Generate a dungeon, until it makes hex dungeons too. Its button is off while the form's Grid is a hex shape, and says so.

## Building maps

The Builder tool is the DM's. Its mode picker shows every mode as an even tile with its icon, and the mode chip in the options row shows the picked mode's icon beside its name where the row has room, or the icon alone where the row needs the room for the mode's own controls. A screen reader says Walls and doors and Heights and stairs for Walls/doors and Heights/stairs, on their tiles, the chip and a key's press. Its modes:

- **Brush**, **Rectangle room** and **Shape room** paint floor, and rooms that touch merge into one floor. Brush size goes from 1 to 10 squares across with − and +, for the Brush and Erase. Floors come in stone, wood, grass, dirt and cave. Terrain comes in water, difficult ground, rubble, pits, pillars and stairs.
- Walls go up around rooms on their own. The scene's "Automatic walls" setting picks around every painted cell, around floor only (for terrain painted over a map image), or off (for an imported map that brings its own walls).
- **Walls/doors** draws a Wall, Door, Secret door or Window on a square's edge, marks an edge No wall, or removes it. Doors are open, closed, locked or secret. Players see a locked door as closed, and a hidden secret door as plain wall. Drag along a grid line to draw a run. With Door chosen, a tap on a door steps it through closed, open and locked.
- **Erase** and **Erase area** clear everything in the squares: floor, walls, doors, windows, labels, stamps, lights and heights.
- **Difficult ground** marks squares as difficult terrain over whatever is under them, floor or map art, without changing their terrain: Mark or Clear, with the brush or a dragged Area. The marks draw as a thin ochre hatch that leaves the map showing, players see them with the map, and Erase takes them with the rest. Difficult and Rubble terrain cost double to walk through too, and Water costs double for a creature without a swim speed.
- **Heights/stairs** paints ground from 20 ft down to 100 ft up in 5 ft steps. Hold + or − to step quickly. It also marks stairs, which point up toward the higher side. Raised ground looks raised, lighter and casting a soft shadow, and stairs draw their treads. Past 30 ft the look stays the same, so tap the ground to read its height. Heights go over a map image too, so a cliff in a drawn map can be raised. A token placed, dropped or duplicated on raised ground stands on it.
- While Heights/stairs is open, each raised or lowered area shows its height in a pill, such as "↑10 ft". The pills grow and shrink with the map like token names. They draw under token names, condition chips, elevation badges and HP bars, and keep off them. A pill with no free spot at the current zoom shows again once zooming in gives it room.
- **Label**: type, then tap the map. Tap a label, here or with the Select tool, to change its text and size or delete it. Drag it here to move it.
- **Lights**: a tap places a light (Candle, Torch, Lamp, Hooded Lantern, Light or Daylight), up to 100 a scene. Tap one to change its reach, turn it on or off, choose whether walls cast shadows from it, or delete it. Drag one to move it. Players see only the light it gives, never the light itself.
- **Stamp** places pictures: 46 shipped top-down stamps (trees, stones, foliage, village pieces, furniture and rocks) or any token image in the room's library under the picker's Stamps tab, or the 131 props of its Starter tab: Warlock's Gauntlet ruins, wrecks, bones and trees, Poly Haven furniture and gear rendered from above, and Mark Gosbell's flat greyscale props.
  - A starter prop is placed as a shipped stamp is, with nothing copied into the room.
  - A stamp moves by dragging, turns and resizes by its handles, takes one of 8 tints, flips, comes to the front, duplicates, hides from players, or is deleted.
  - Its tint, flip, front, duplicate, DM only, delete and Done sit in the builder's row, or behind ⋯ where the row has no room, on every screen.
- **On a hex scene** Walls/doors draws **Wall lines**: tap points and tap Done, or drag for one straight run.
  - Each run between two points is a wall, door, secret door or window as the Walls/doors choice says, cut into pieces of at most 8 cells. A tap on the first point closes the line, a tap on the last point again ends it, and Undo point and Cancel sit beside Done.
  - Points snap to hex corners while **Snap** (Snap to hex corners) is pressed, the default, and land anywhere on the 1/64 cell lattice while it is not, for walls on the art that do not follow the hexes.
  - With no line begun, a Door tap on a door steps it through closed, open and locked, and Remove takes a wall, door or window off with a tap.
  - **Difficult ground** marks hexes, with a brush of 1, 7 or 19 hexes or a dragged Area taking the hexes whose middles it holds.
  - **Erase** takes everything in its hexes (the brush of 1 to 10 takes the hexes within that many steps less one), **Erase area** the hexes whose middles lie in the box: difficult ground, the walls, doors and windows whose middle lies in an erased hex, and the labels, stamps and lights there.
  - A hex scene's difficult ground can't move to another grid shape, hex rows to hex columns included, and its walls can.
- **On a hex scene** Heights/stairs paints by hexes: the brush takes 1 hex, a hex and the six around it, or two hexes out, and Area the hexes a dragged box holds.
  - A stair points up toward one of its hex's six sides: Auto points it at its one higher neighbor, and six arrows set a side by hand ("Up to the east" and round, from the south on hex columns).
  - Raised hexes look raised as squares do, each hex's sides rimmed or shaded, and the readout names a hex stair's side ("Stairs, 5 ft up, up to the south-east.").
  - Erase and Erase area take a hex's height and stair with the rest.
- **A generated dungeon is a Builder scene** like any other: every builder mode edits it, Fog reveals it, the Fog tool's Builder room reveals exactly one of its rooms, and Duplicate and Export as image work. Its walls are all automatic, so no drawn wall marks the side of a room players have not found.
- The builder's bar has Undo and Redo buttons, the same undo as everywhere else. "Clear the build" in the scene's settings removes all of the build.
- The builder works top-down: on a device showing Isometric it shows Top-down while open, centered where the selected token is, and Isometric comes back with the next tool.

## Tokens

- Token kinds: player character, NPC, monster, and object or marker.
- Each token has a name (which the DM can hide from players), an image, a size from Tiny to Gargantuan or a custom one, HP, maximum and Temporary HP, AC, Speeds, elevation, facing and conditions.
- The DM and a creature's owners change its size on the fly, for Enlarge or Reduce, a Wild Shape or a polymorph: Size in its action bar, below Conditions and Multi-select, steps it one size larger or smaller, and Size in its Stats picks any, with "Back to Medium" where its character or stat block gives its own size.
  - The creature keeps its middle and its elevation, and its height, reach rings and attached areas follow.
  - Shrunk back on the same device before it moves, it returns to the square it grew from.
  - On a scene where walls stop moves, a player's resize is checked like a move: the creature never crosses a wall, and grows over the squares it filled into the room around them, away from walls the least it must, or keeps its size with "No room to grow here".
  - The DM's changes are never stopped.
  - A size change undoes as one step, keeping damage dealt since, and counts no movement.
  - The DM alone sets and changes a custom size, and a locked token keeps its size for its players.
- On hex scenes, the Size controls name the footprint too: Tiny, Small and Medium take 1 hex, Large 3, Huge 7 and Gargantuan 12. The action bar puts the count below the size name so its buttons stay in place.
- The DM edits every token. Players move and edit the tokens they own. The room setting "Who can move any token" also lets no one (the default), every player, or chosen players move any visible, unlocked token. A drag that is not allowed says why.
- A player's top bar shows their own chip, their name in their color. On a phone the room name gives way to it, down to its first few letters. It opens the You menu, named "You are Pat. Your options": "Thorn's sheet" for each character they own, and "X-card…", which opens the X-card's card in a sheet.
- "Find my token" in a player's top bar jumps to their token. The next press goes to their next one. It also selects the token and opens its action bar, so the next thing to do with it is one tap nearer. In Multi-select it adds the token to the group, never takes one out, and opens the bar.
- HP takes math: `-7`, `+5`, `=20`. Temporary HP is spent first.
- **Typing a number starts an HP change.** With tokens selected, nothing focused and the bar's HP entry showing, the keys 1 to 9 (the numpad too) open the entry with that digit, in the bar's mode, with the cursor after it. Enter applies, and focus goes back to the page so N, H and the next digit work again. A refused entry keeps focus. 0, + and - keep their own jobs.
  - It does not start in a field or a dialog, or in View as a player.
  - A key a device moved to a digit keeps it, and that digit leaves the range here. The shortcut sheet then reads "2 to 9" with "1 is Ruler on this device."
- HP previews use a raised slip with a thin outline and a left stripe: red for damage, green for healing, muted for Temporary HP and set HP.
  - Damage has shared columns for the plus, a text-sized icon, the struck original when needed, the result, and the type in words. Originals and results each line up by their last digit. Untyped damage has a placeholder icon.
  - Changed amounts show the original struck through beside the result, later parts start with an aligned plus, and multiple parts end with a bold total under a rule.
  - Only defenses that affected the hit appear below a separate rule, with small type icons and qualifiers. Defense labels and values share a text baseline. Group saves also name a successful save or Evasion.
  - A multi-selection keeps the incoming parts and adds a short line for each creature whose visible defenses change the hit. Hidden defenses never change a player's preview.
  - The same summary appears in HP entries, typed or multipart rolled damage chips, and group save damage and row overrides. A single untyped damage chip keeps one line. Negative rolled parts count as zero throughout the preview and apply plan.
  - Unrolled formulas wrap inside the slip, between their terms after a + or −, and inside a single term only when it is longer than the line.
  - Override comparisons appear only when the original damage is known.
- **Typed damage** works in the token action bar, the Token panel, character pages, map and tracker multi-selections, rolled damage chips, and the group save and its per-creature overrides.
  - Enter `10 fire` or `10 fire + 4 cold`. An HP field asks for a total per type when a typed expression such as `5 + 3 fire` needs adding first.
  - Each creature takes damage after its own resistances, immunities and vulnerabilities.
  - Players see defense explanations only where they may already read those defenses. Hidden defenses still apply, with HP and log visibility unchanged.
  - Plain numbers, healing and Temporary HP keep their usual behavior.
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
- A token's panel starts with its picture and name, then a line that says what it is and its size, such as "Level 5 character · Medium (5 ft)", "Monster, CR 1/4 · Small (5 ft)" or "Companion of Bree · Small (5 ft)", and under it its quick numbers: AC on its shield, Speed after its footprints, "PP" for Passive Perception, "Init" for Initiative, its elevation off the ground and a link to its sheet, each only where your copy of the room holds it.
  - Where they do not fit on one line, AC and Speed stay on the first and the rest go together onto a line of their own, so no number stands alone. A Speed with several modes stays whole beside AC, wrapping between its modes where it must.
  - Then for a monster or NPC its stat block, whose row says while folded which block it is, such as "Wolf, CR 1/4", then what is grouped by use, each group one fold with a one-line summary while folded: Combat (Hit Points, conditions, Uses, Reaction, range rings and rest), Notes, Position (elevation, facing, attaching and sight) and Image (change, crop or remove the picture, and other images). Stats, token settings, a companion's settings and owners fold away at the foot, then Remove.
  - What the token's action bar and its tracker row offer is in the panel too, in the group of the same name: Uses and Reaction used in Combat, Attach, Get off, Let go and Put down in Position, with the bar's line of what it rides, carries or drags, Duplicate at the end of the DM's token settings, Dismiss in Remove for a companion's player, and for a player lent a character's token, its Size alone in Stats while the token is unlocked.
  - Position shows its attach controls alone to a player who may use them on a creature that is not theirs, such as Let go of their character beside the name of the goblin dragging it.
  - Combat's summary says "Reaction used" while the creature's Reaction is spent, to everyone who sees its row's tag.
  - Combat starts open everywhere, and another creature's Notes starts open, since it shows only with the DM's note for everyone. This device remembers which you opened, your own creatures' apart from others', so folding another creature's Notes never folds your own.
  - Max HP and Temporary HP always sit side by side, with their labels above them on a narrow panel.
- Range rings around a token, such as 30, 60 and 120 ft: preset circles to tap on and off, and a "Custom ft" field for any other distance, up to 4 rings. With 4 on, a line says so, and the other presets and the field stay reachable by keyboard and screen reader, which hear why they do nothing.
- A token can carry a light (Candle, Torch, Lamp, Hooded Lantern, Light, or a custom one), set by the DM and its owners. A scene lights up to 20 token lights. Past that the DM cannot light another, while a player's torch is never refused: the party's own lights light first, and the scene's Light and weather settings tell the DM how many light nothing.
- A character's token can link to its owner's D&D Beyond sheet.

### Several tokens at once

- Select several tokens with Shift or Ctrl and a click (Cmd on a Mac), with "Multi-select" in a token's action bar or the Initiative panel, or with a box drag: Shift or Ctrl and a drag on empty map with a mouse, or any drag on empty map while Multi-select is on. Drag any of them to move them all.
- With Multi-select on, a tap on empty map hides the group's action bar and keeps the group, and "Actions" in the Multi-select bar brings it back. A tap on a token in the group takes it out. Done ends Multi-select and lets go of the group, and so do Escape and Android's Back while the bar is hidden.
- The group's action bar offers one HP entry for all of them, Conditions, and elevation up and down 5 ft.
- The DM also gets Roll, which opens the Dice panel's group rolls, Request a roll, Hidden, Locked, Start a fight or Add to the fight (objects stay out of the fight), Delete, and More: ring color, size, layer, image, how players see HP, hiding names from players, "Always visible, even under fog", and owners.
- Each action shows only when you may use it on every selected token, except Request a roll and Start a fight or Add to the fight, which show when any of them can take part. A player who selected their own creatures gets conditions and elevation.
- **Save**, for the DM, on the group's bar opens the group save for the selected creatures at once, with its own ability picker. A page that already holds rolls asks to replace them first, in the bar.
- **All 4 Goblin Warriors**, for the DM, in a monster's action bar (on a phone, the expanded bar), selects every token of that monster on its scene as a group, hidden ones too, in number order. It shows when there is more than one, and not for a lone or renamed token. The group's HP entry, Conditions, Roll and Save then follow.
- A change to the whole group undoes as one step.

### Riding, carrying and dragging

- Attach, in a token's action bar after Light, lists what it can ride, carry or drag within 5 ft, nearest first, each as what it does: "Ride Warhorse", "Perch on Bree" for a Tiny creature, "Carry Torch", "Get on Cart", "Carry Kobold" for a creature the viewer sees Grappled, and "Drag Goblin 2".
  - The DM's list goes on to tokens up to 30 ft away under "Farther away", for setting up a scene.
  - The list takes the arrow keys and Enter.
  - An empty list says "Nothing within 5 ft to ride, carry or drag.", and tells a player that a grappled creature can be dragged once the DM marks it Grappled.
  - Layout: The list opens as a pop-up from 900 px up and as a sheet from the bottom on a phone.
- Ride asks Controlled (the default) or Independent, two words side by side, with a line under them saying what the chosen one does: "Warhorse moves on Bree's turn." or "Warhorse keeps its own turn." The rider's Token panel shows the same choice under its tags.
- A holder carries what it holds: drag a warhorse and its rider rides along, a cart takes its passengers, a creature the torch in its hand, each with what those carry in turn.
  - What rides takes its holder's change of height.
  - Where its holder stops squeezed in a narrow space, what sits on it sits on the squares or hexes the holder squeezes onto, the one nearest its place, so its light and sight are there with it (a Large mount's rider rides on the mount's one square or hex in a corridor), and it takes its own seat again where the holder stands up.
    - On hexes it does so all along the walk.
    - On squares it keeps its own seat on the way, and where the holder's walk ends squeezed each passenger takes a square of its own while there are enough, the nearest one left to it, so four passengers on a Huge mount squeezed in a corridor two squares wide keep four squares as it walks on and out, from any seats. With more passengers than squares, the rest share their nearest.
    - A rider on a mount half a square off the grid keeps its square of the mount when it moves, and the creature the rider leads stays in tow.
  - On squares, what a holder drags follows it in single file on a walk that ends squeezed: each walks the holder's own line and stops just behind the one ahead, the one nearest the holder first, so a goblin a warhorse drags goes with it into a corridor one square wide.
    - Only those that stay within reach of their own holder there go: a second goblin the warhorse drags would end 10 ft from it, so a player's drag stops before the corridor and names it, and one the players cannot see lets go there instead.
    - A rider every player sees who leads a prisoner can ride into a corridor in single file when the rider's seat there keeps the prisoner in reach.
    - When a trap stops a creature that drags others in single file, each one it drags stops a step back along its own way, clear of the creature ahead and still in tow. Where that is not possible, they stop where the trap caught them. Otherwise what it drags walks beside it, and the drag finds a way they all fit.
  - It holds on all the way, and the walking ruler from a rider runs where the rider sits.
  - A dragged creature follows beside its holder on its own ground, and comes loose once it is out of reach. A teleport leaves dragged creatures behind, and a move to another scene takes everything.
- Dragging the rider of a controlled mount, or a rider that covers its whole mount, moves the mount, which needs the right to move the mount: "Warhorse carries Bree. Tap Get off to step down."
  - The mount goes where it keeps the rider under the finger: full size where it fits there, else squeezed onto the squares or hexes under the rider, so from any seat a drag into a corridor one square or hex wide takes the mount in.
  - A ledge never moves it from there: where the mount would stand across the edge of a rise, the DM's drag lands it there, as a drag of the mount itself does, and a player's walk stops at the ledge and says so.
  - Any other carried token drags alone: dropped on its holder, or within 5 ft of the creature dragging it, it stays attached, and anywhere else it comes loose.
  - One dragged off a holder that stands on the ground walks and lands on the ground, as a Get off does, crossing a step under the holder until it first clears it, but stepping off no cliff at the holder's side and climbing no ledge beyond it, and its line, label and stored cost read that walk.
  - A selection that holds a holder and what it carries moves each once.
- Get off, Put down and Let go show on a carried token's bar.
  - A carried creature keeps Attach beside Get off, offering only Carry and Drag, so a rider can pick up a torch or drag a grappled foe, and changes mounts by getting off first.
  - Get off puts the creature on the first free spot beside its holder, clear of the squares the holder stands on (the ones it squeezes onto while it squeezes, so a rider gets off into the corridor), and with none it is disabled, with "No room to get off." under it.
  - Put down and Let go leave it where it stands.
  - Players take back any of the three, or a Ride, with Undo move.
- A carried token draws right after its holder.
  - A rider that covers its whole mount draws inset so the mount shows around it.
  - A press in a holder's middle takes the holder, so a creature carrying a lamp, an owl and a chest drags by its middle and each of them nearer its edges.
  - A thin dashed line ties a dragged creature to its holder.
  - The bar's group line names the link in the Token panel's words: "Riding Warhorse", "On Bree" or "Dragged by Thorn" on a carried token, and "Carrying Bree, Torch" and "Dragging Goblin 2" on a holder, each name a button that selects that token, with Let go or Put down beside each one a holder carries.
  - The Token panel tags the link the same way: "Riding Warhorse", "On Bree", "Dragged by Thorn", "Carries Bree and Torch".
- Mounted combat, as the 2024 rules have it.
  - Getting on or off a mount on the rider's own turn costs half the rider's Speed, and a player gets on a mount only on their own turn.
  - A controlled mount takes its rider's Initiative and goes right after the rider: it moves and acts on the rider's turn, its moves count against its own Speed, the moved pill sits on the mount with the rider's own movement under it ("Bree: 15 ft"), and its Reaction comes back with the rider's.
    - Its own row that round only marks time, dimmed in the tracker, and a mount that already had its turn this round is passed over until the next.
    - When the mount's own row is acting as it is mounted, its options offer the DM "End turn and move after Bree". That finishes the turn in the original order before moving the mount, so no creature between it and its rider loses a turn.
    - Getting off ends the sharing at once.
  - A rider the DM hides, or one whose initiative row the DM hid, never shares its mount's turn or moves its row, so the tracker gives nothing away. A ride on a scene the players are not on moves no row and shares no turn either, including a rider whose row belongs to its character rather than to a token.
  - A row the order setting keeps from players until its first turn stops only the row move, at a ride taken before that turn. When the turn comes the row shows and the mount shares it, so a mount whose row stayed ahead of its rider's can act on its own turn and on its rider's each round, until the DM's "End turn and move after Bree" on its row puts it right.
- The tracker tags a rider's row "Riding Warhorse", and a controlled mount's "Controlled by Bree: moves and acts on Bree's turn (Dash, Disengage or Dodge)".
- Dragging or carrying a creature every player sees costs 1 extra foot per foot, as difficult terrain does, unless it is Tiny or two sizes smaller than its holder.
- When Prone or Unconscious lands on a rider or on its mount, the DM's device says "Bree may fall off Warhorse: DC 10 Dexterity save.", with "Ask for the save" for a player's rider. Nothing falls off by itself.
- On a scene where walls stop moves, a holder's drag finds a way that fits every creature it drags beside it that every player sees, so a grappled goblin walking beside it comes through a 10 ft gap with it.
  - A drag on squares that ends squeezed takes the holder's own way when each of them can follow it there in single file.
  - With no such way the drag reads "No way through", the group stops where its holder, or one of those creatures, meets a wall, on a spot where no wall passes through the footprint of the holder or of a creature it drags, and the note names the one that cannot follow when the holder alone could go ("Goblin can't follow through there.").
- Hidden stays hidden: a hidden imp on a villain's shoulder never reaches players, and no stop, cost, refusal or undo depends on a token or link they cannot see. A visible torch held by an invisible creature floats along with it, as at the table.
- A token carries at most 8 others, a chain of carried tokens is at most 3 deep, and a group moves at most 20 tokens.
- On a hex scene a link reads hexes.
  - A rider or passenger sits on its holder's hexes, on the one nearest where it stood, and a move that leaves it beside them, off its holder's hexes, lets go.
  - 5 ft is one hex step from the holder's hexes, for the Attach list and a drag alike.
  - A carried creature's leg counts the hexes it was taken, and where walls stop moves a holder's drag finds a way through that fits every creature it drags beside it, as on squares, each at its own full size, so a Large creature is never dragged into a corridor one hex wide. Single file behind a squeezing holder is for squares only. On a player's move, a hidden dragged creature stops at the last reachable full-size stand before the wall, including the mouth of such a corridor.
  - Get off puts the creature on the first free hex beside its holder's hex (the one it squeezes onto while it squeezes, so a rider gets off into the corridor), trying that ring from the east and clockwise on hex rows, or from the south and counterclockwise on hex columns, then out ring by ring.
  - A ride still needs a mount at least one size larger.
  - A switch to or from hexes keeps the scene's links, and one the new grid no longer holds lets go at its next move.

## Images and art

- The image picker gets an image six ways: Icons, Starter, Device (an upload, or the camera roll on a phone), Link (an image's web address), Search the web, and Library. Pasting a copied image works there too, and in New scene's Map image, a scene's Map image and phases, Show a handout and the stamp picker. On a computer, the DM can paste over the map and choose what it is for, and the choice opens New scene or Handouts even when its group is folded.
- **Icons**: 4,180 game-icons.net icons, each on a colored disk, found by name or artist. Picking one needs no upload and no search, so it works when web search is used up, and once the icon list has loaded it works offline too. Each icon names its artist and license where you pick it.
- **Search the web**: type "goblin archer" and tap a result. It searches Google Images, with safe search on, while the server has a Google search key and searches left this month. Otherwise it searches Openverse's openly licensed images, and "Search Openverse instead" asks Openverse on purpose. An Openverse image keeps its credit (title, author, license and what was changed), shown in the library and the token panel.
- **Starter packs**: 501 openly licensed works in 14 packs, each from one artist or project, ready for a DM with no art of their own.
  - They have a selector of their own wherever art is picked, showing only the packs that fit: the image picker's Starter tab (tokens and portraits), "From starter packs" under New scene's Map image (maps) and in Show a handout (pictures to show), and the stamp picker's Starter tab (props).
  - Each lists its works by pack and then by category inside the pack, such as Dragons or Undead, with a search over names, categories and tags across the packs shown. A tap on a work shows its name, pack, author and license, and Use takes it.
  - On a short screen, such as a phone held sideways, that line and Use stay at the foot of the window, as the Icons tab's do.
  - Thumbnails show loading, and Use shows busy until the copy lands or says plainly why it failed.
- **Starter tokens and portraits** (302): the Illustrated Bestiary (60 monsters in color), Cute Heroes and Monsters, Dungeon Crawl Stone Soup monsters (pixel art, scaled up sharp), Lemurs Fantasy Portraits, Fantasy RPG Portraits, Flare Hero Portraits, and Historical art's people and creatures.
  - Use copies the picture into the room's library and opens the crop editor, as a Library pick does.
  - A player gets the Starter tab in the image picker of the creatures they own, such as their character, since a token image is the one kind of art a player may add.
  - A player's pick takes as long, and counts toward the hourly limit the same, whether or not the room already holds the work, so neither shows what the DM has picked.
- A starter pick of a map, token or handout becomes the room's own image, with its credit (title, author, license, the credit line its author asks for, such as "Cartography by Dyson Logos", and what was changed), shown in the library and the token panel.
  - It never counts toward the room's storage, and a backup carries it with its credit.
  - Moved to a server that ships the same work, it stays a starter pick there.
  - Picks have an hourly limit of their own, apart from uploads. The DM picking a work the room already holds costs nothing, and a player's pick always counts.
- Crop to a circle with zoom and pan. The ring takes the disposition color.
- The server checks, resizes and re-encodes every image and strips its metadata. A video is never re-encoded: the server reads only its headers, keeps what playback needs and zeroes the rest in place, location and names included.
- The room's library keeps every image for reuse.
  - The DM's library marks images nothing uses as "Not in use" and deletes them one at a time or all at once ("Delete N not in use", under Cleanup at the foot), on a second tap. An image in use cannot be deleted. Undo cannot bring back a token or anything else whose image was deleted since.
  - Images picked from the starter packs sit after the room's own, in a "Starter packs" fold that starts closed, in the Library panel and the picker's Library tab, so they never crowd the DM's own maps and tokens. New scene's "Or use a map already in this room" and the handout form list them after the DM's own too, apart. A deleted pick can be picked again.
  - If the list of the room's images does not load, the Library and the stamp picker say so in one line with Try again, and still show what the room already uses, such as the images on its tokens and the DM's handouts.
- A tap on an image in the Library opens it large in the same viewer, so the DM can look at any handout, map or token image, and a player at any token image they can see. The viewer's header gives the image's size, its credit where it has one, and for the DM whether it is in use, with Delete for one not in use. The DM's library lists handouts first, and marks each image "In use" or "Not in use" in its corner.
- The DM's Library lists a video among the maps as a film strip with its length, such as "0:42", and In use or Not in use.
  - A tap opens it in the viewer, which plays it muted and looping while the board lets go of its own copy, turned and stretched the way it shows on the map, with its size as it shows, length and stored size, and Delete for one not in use.
  - Where this device shows the still, the viewer shows the still of the first scene or phase that names the video.
  - "Or use a map already in this room" lists stills only.
- The DM's library shows a PDF handout as one item with its page count. A tap opens it with every page, and Delete removes it with its pages.
- A monster's default image: set it once, and every token of that monster placed afterwards starts with it. "Apply to N tokens on this scene" puts it on the ones already there.
- Every SRD monster comes with a default token: a game-icons.net icon on a disk colored by its creature type (a wolf's head on brown for a beast, a skeleton on black for the undead), and dragons in their own color. It applies in existing rooms too, and nothing is stored until the DM changes it. A monster's page shows the default with its credit. "Change image" sets the room's own image for that monster, and "Use the default icon" goes back to it.
- Every piece of art that ships with the app, the starter packs included, is openly licensed and credited on the About page and in CREDITS.md. Each starter pack was checked for signs of AI generation: its page and its dates, and every work in it by eye.

## Conditions and statuses

- The 15 conditions of the 2024 rules, each with its rules text from SRD 5.2.1 behind "Rules text" in the Token panel.
- Exhaustion levels 1 to 6, with a level badge.
- Common statuses: Concentrating (with the spell), Hidden, Flying, Dodging, Raging, Blessed, Baned, Hasted, Hunter's Mark, Hexed, Marked, Surprised, Heroic Inspiration and Readied action. Bloodied shows on its own from HP, Dying (with Death Save pips) and Dead come from HP and Mark dead, and Reaction used is a switch on the Initiative row and in the Reaction section of the creature's Token panel and of a character's page, for the DM and the row's owner while the creature is in the fight. A companion that shares its character's turn has a Reaction of its own there.
- Custom statuses take an emoji or a letter, a color and a label.
- A token's action bar has a quick Conditions grid, each condition named under its icon.
- **C opens the Conditions** of the selected tokens, with the first condition focused. Escape closes the grid and puts focus back on the Conditions button, with the bar still open.
  - On a phone, C grows a resting bar with the grid open, and Escape rests the bar again with focus on its Conditions. Where the resting bar has no room for Conditions, as on the creature's own turn, Escape leaves the bar grown instead, focus on its Conditions.
- **Recent conditions**: the grid, and the Token panel's condition picker, start with a **Recent** row of the three conditions this device added last. The row is the same for every token on this device, and it holds still while the grid is open.
- A status can carry a counter, such as rounds or charges left, that a tap counts up or down. Where its row has no room for its − and + beside its name, they stand under the row.
- Durations: a number of rounds, or until the start or end of a chosen creature's turn. They count down with Initiative, and everyone is told when one ends.
- A concentrating creature that takes damage gets a prompt with the DC (the higher of 10 and half the damage, at most 30). Its player reports pass or fail, or taps Roll. For a creature with no stat block, Roll d20 opens a bonus field on the card, beside Adv and Dis, and rolls with the bonus typed there.
- A condition can end on a save at the end of each of its turns. The DM's reminder rolls it, for a creature with no stat block by Roll d20 and a bonus typed on the card, or asks a player, whose passing answer ends it. A failed one stays open for a corrected total or an allowed reroll. Players see which save ends it, never its DC.
- The DM can hide a condition from players, the creature's owner included. The log hides it too.

## Height and elevation

- Every token has an elevation in feet, negative for burrowing, with +5 and -5 buttons. A badge such as "↑30" shows whenever it is not 0.
- With Select, tap raised or lowered ground to see its height for a few seconds, such as "↑10 ft", or "Stairs" on a stair. Under the fog it shows nothing. Screen readers hear it too.
- Rulers, distances between tokens and areas of effect all count height.
- Creatures have a height from their size, so a fireball can miss one flying above it.
- A flying token's shadow shows from 5 ft up and drifts down and away as it rises, further for a larger creature. For a player, ground still under the fog counts as level, so a shadow never shows a height the fog hides.
- On raised ground from the builder, with "Walls and ledges block players' moves" on, a player's walking token crosses an edge only by a stair, while a flier above it passes. A creature sees over a ledge no higher than its eyes, and one in a pit cannot see out.
- **On a hex scene** heights and stairs work as on squares, by hex: a walking creature crosses a side between two heights only along a stair through it, a flier above the side passes, a walk and the walking ruler count the climb by the room's diagonal rule, and a light stands 5 ft over the ground of the hex under it.
  - A creature on more than one hex, a Large one or a Huge one squeezed onto three, walks a stair at least two hexes wide (stairs side by side facing the same way), standing across the stair's zigzag edge as a square creature stands across a stair's edge. Beside a lone stair a raised side stays a ledge.
  - A rider getting off a mount whose hexes stand at two heights crosses the step under the mount on her way off, as on squares, and still steps down no ledge at its side.
  - In Isometric raised hexes stand and hex pits sink: each hex is a six-sided block showing its three near sides, a stair keeps its marks on its top, a creature stands on the hexes it actually covers, and the same fog and Low power rules hold as on squares, so a hex stands once any part of it is revealed.
  - Taps, drags and placing read the hex whose top or side shows under the finger.
  - Layout: A hex lies flat below 12 px a hex, or below 24 px a hex in Low power.
- A token left inside the ground after a height change says so and offers "Stand on it".
- In Isometric (Scenes and maps) raised ground stands up and pits sink, and a creature stands at its elevation: a flier over its shadow on the ground under it, joined by a thin stem, dashed where a very high flier is drawn lower to stay on screen. Pits side by side show their floors as one hollow, on squares and hexes alike: a floor seen past a neighbor's rim shows its own ground, darkened once, and a creature, wall or area down in it shows wherever any of the hollow's openings shows it.

## Measuring and movement

- Ruler: drag to measure, and tap to add waypoints.
  - It shows the total and each segment's length.
  - Players' rulers show to everyone in their color. The DM's stays private until shared.
  - A double tap keeps a ruler on the map, and the Kept rulers chip lists the kept ones, each removed by its row with the eraser. On a narrow phone, the DM's Clear shows as its eraser alone, so "Kept rulers" stays in the row.
  - A point on raised or lowered ground stands on it, so the distance counts the height. A player's ruler counts only ground they can see, and everyone reads the same numbers.
  - Its readings keep one size at every zoom, grow with the interface size, and stay clear of the top bar and the toolbar at the screen's edge.
- The ruler's Measure chip chooses Straight or Walking, shown as Line or Walk where the row is short of room, and the device remembers it.
  - Walking measures how far the creature the ruler starts on (or a Medium creature, from empty ground) would walk to each point, with difficult terrain and a dragged creature counted. While "Walls and ledges block players' moves" is on, it goes around walls, through doors and up stairs: "Walking 40 ft", with "+10 ft for difficult terrain" under it.
  - Each leg reads what dragging the creature there would, from where the legs before it left it. From a rider of a controlled mount it walks the mount, as a drag from her does, aimed so she stands on each stop, its legs drawn from her seat.
  - A leg with no way through draws in red, held at the wall as a player's drag would be, while the DM's own ruler, before it is shared, walks as the DM's drag does and runs that leg on through the wall.
  - While a long leg is worked out the ruler keeps its last reading, and after a moment shows "Finding the way…".
  - Shared and kept walking rulers read the same on every device, and follow the tokens they start or stop on.
  - On a hex scene Walking steps from hex to hex, round walls and closed doors while the movement setting is on, leaving out other creatures as on squares, every hex 5 ft and a hex walked squeezed 10 ft, and from empty ground it starts on the hex under its first point.
- Dragging a token walks it the cheapest way to where it is dropped.
  - While "Walls and ledges block players' moves" is on, it goes around walls and closed doors, up stairs and around creatures in its way. With that setting off, walks ignore those barriers. Either way, it goes around difficult terrain when that is cheaper.
  - The line bends at each corner, and its label reads what the walk costs, with what cost extra under it ("+10 ft for difficult terrain", "+25 ft for squeezing" through a narrow space, or "+30 ft for difficult terrain and squeezing" where the walk took both). A walk that would end in another creature's space says so, under the label, and the label and its warnings stay together at the screen's edge.
  - A long search shows "Finding the way…", and a drop made meanwhile waits for it and then lands. A walk stopped at a wall still pays for the rubble it crossed on the way.
  - Walking through difficult terrain costs double, as does swimming without a swim speed and crawling while Prone. Another creature's space is difficult terrain unless it is an ally or Tiny.
  - Group drags move in a straight line. An arrow key moves a token one square and never around a wall, and counts what it walks over as a drag would, so a square of difficult terrain costs it double and a climb costs what the walk up does.
- Dragging a token measures as it goes: green within its Speed, yellow within a Dash, red beyond. A creature above 0 ft with a Fly Speed is measured against that. In a fight only the creature whose turn it is gets the colors, and a drag with no colors to show is white. Inside Spirit Guardians or another Half Speed area that affects it, the creature's Speed is halved, rounded down, and the label says "Half Speed in Spirit Guardians".
- Tokens snap to the grid, to a hex on a hex scene.
- Hold Alt (Option on a Mac) while you drag a token, or tap Place freely in its bar first, to drop it between squares.
  - Every rule still counts it in that square, which a dashed outline shows while it is selected, dragged, measured or in an area being aimed.
  - Snap to grid in its bar, or an ordinary drag to another square, puts it back on the grid.
  - The DM can do this for any token, and a player for any token they may drag, on square scenes only: hex scenes keep creatures on a hex.
  - A placed token stays where it was let go through a reload, an arrow key step, a group drag and Undo, and a screen reader hears "Placed between squares." and a bar named "Bree actions, placed between squares".
  - Players see a token placed this way where it was let go. Nothing about a hidden token reaches their devices.
  - Layout: It is drawn within 3/8 of a square of its square. Snap to grid and Place freely share one line when both show, each taking half, and each takes a line of its own where the bar is too narrow for both.
- Distance between two tokens counts from edge to edge, right for their sizes, and includes height. On a hex scene it is the fewest hex steps between any hex of one and any hex of the other.
- Diagonals follow the room's rule: every square 5 ft (the 2024 rule, and the default), alternating 5 ft and 10 ft, or true distance. Feet per square can change too.
  - On a hex scene every hex is one step, so the rule counts only height there (5-10-5 alternates the vertical feet, true distance reads true height), and the ruler's line says "every hex 5 ft".
  - The Straight ruler stops at a hex's center, a drag's label and speed colors count hex steps, range rings outline the hexes within reach, and the arrow keys move a token one hex, zigzagging Up and Down on hex rows and Left and Right on hex columns.
- On a creature's turn its path is tracked. Each drop or change of elevation adds a leg, and the trail draws on the map with a ring where the turn began, bending where the walk went around something. "Moved" totals the whole path walked, which helps the table judge Opportunity Attacks. Nothing detects them for you. When difficult terrain made the turn cost more, the DM and the creature's owners read both: "Moved 15 ft, used 20 ft".
- A player's "Undo move" takes back their newest drag, elevation change or turn of facing. "Doesn't count" leaves a shove, Misty Step or a teleport out of the total.
- Players undo their own moves, newest first. An undo is refused when someone else has moved that token since.

## Walls and doors

- The scene setting "Walls and ledges block players' moves" decides whether walls, closed doors and ledges stop a player's drag.
  - With the setting on, a player's drag goes around walls, closed doors and ledges the party has seen, and stops only where there is no way around, holding at the last free spot with a note saying what stopped it ("There is no way around it that you have seen").
  - A creature Large or bigger that holds half a square off the grid, as one that came out of a squeeze can, holds where no wall passes through its footprint, unless it stands in a narrow space it could squeeze through.
  - Outside such a space, the server refuses a player's move that would leave it standing there full size across a wall, and one dragged along that some player cannot see stops a step back instead, where no wall passes through it.
  - New scenes have it on. A secret door not yet found is a wall to everyone's route, the DM's included.
- "Teleport here" on that note lands the token where it was dropped, for Misty Step and the like. It doesn't count against Speed, and the DM's log notes it.
- On a scene with fog, a stop names what stopped the move only when the player can see it right now.
  - A wall or closed door beside a square they can see is named whatever lies unseen behind it, so a door in their light still reads "A door is in the way. Tap it to open.", and a ledge is named when they can see the ground on both sides of it.
  - Anything else, a wall in the dark, a ledge up to ground they cannot see, or a wall the party only remembers, names nothing: the token holds at its last free spot and the note reads "Something blocks the way." (without party vision, the same goes for ground not revealed to them).
  - Players' moves into ground they have not seen still go, and the server stops them at the last free spot. Teleport here gets past, and past something unnamed the DM's log reads "teleported past something they could not see".
  - A wall the party remembers keeps stopping their moves, a one-square step into it as much as a longer drag, until they see that spot again or teleport past it.
  - On square grids, an imported door just inside the next square can also be named from the visible square beside it when it matches the door the player holds. A hidden addition or change keeps the generic words.
- A player's device sends every move, door press, attach walk and companion placement the walls it holds allow, even one that ends a hair's breadth from a wall or starts overlapping one. A move a wall stops at its very first step sends nothing, so the token never leaves its square.
- A creature squeezes through an opening one size too small, as the rules allow. A Large creature fits a 5 ft door or corridor. Each foot it moves squeezed costs 1 extra foot, which the label and the walking ruler name as squeezing. On squares, a walk counts squeezing only while "Walls and ledges block players' moves" is on. Hexes still count a squeezed walk with the setting off.
- **On a hex scene** walls, closed doors and windows stop players' moves as on squares, while "Walls and ledges block players' moves" is on.
  - A step from one hex to the next is stopped where the line between the two hexes' centers meets a wall, for every hex the creature takes, and a creature stands only where no wall runs between two of its hexes, so a Large creature walks a corridor two hexes wide. One a wall runs through may step off it to either side.
  - A drag walks the cheapest way from hex to hex, round walls, creatures in its way and difficult ground when that is cheaper.
  - Where the creature's full size cannot fit, a Large, Huge or Gargantuan creature squeezes onto the hexes of the size one smaller (a Large one onto 1 hex, a Huge one onto 3), paying 5 ft more for each hex it moves squeezed, and stands up again where it stops in room enough. It squeezes only in a real narrow space: beside one wall in open ground a squeeze is refused.
  - A resize reads the walls too: a creature that would grow across a wall takes another spot covering its hex, or has no room to grow.
- The DM's moves are never stopped.
- With the Select tool, a tap on a door offers the DM Open or Close and Lock or Unlock, and Mark found or Hide on a secret door.
- Players open and close unlocked doors that their own token can reach, with a tap on the door or "Open door" in the token's action bar. A locked door answers "It's locked." On a hex scene a door is reached from the hexes beside it, 5 ft or one hex away, and a player sees it while either hex beside it holds ground out of the fog.
- The creature that opens a door, which sets off a trap on it: the token whose action bar opened it, else for a tap the token selected when the door was tapped (any on the scene for the DM, the player's own that reaches it for a player), else the player's nearest own token that reaches it. The DM with nothing selected opens it from afar and sets off nothing.
- Walls block areas of effect. Walls, closed doors and pillars block sight.
- Walls, doors and windows are drawn in Isometric.
  - In Isometric walls stand in stone, doors in stained wood and windows as panes, and zoomed in, doors and windows stand in stone frames and walls on squares as slabs (Depth up close, under Scenes and maps).
  - An automatic wall keeps the height of the room's other walls: beside raised ground only the part above it shows, and none stands beside ground as tall as a wall. A wall the DM draws stands on top of raised ground. On a hex scene it stands on the ground of each hex it runs through, and along a hex side on the higher of the two.
  - A tap on a door reaches it by its standing piece, by its line on the ground or, zoomed in, by its open door standing on its hinge. Zoomed out, an open door lies flat.

## Fog and vision

- **Players see**: each scene's Fog and vision settings start with one choice of what players get.
  - **Explore**: players see what their characters see, ground they have not seen stays dark, walls and all, and what they explored stays as they last saw it (party vision with fog).
  - **Reveal by hand**: players see what the DM reveals with the fog tool.
  - **Everything**: the whole scene.
  - The light and Sight keep their own settings. The Fog and Party vision switches sit in the Switches fold under them, and party vision with fog off reads Custom, with the fold open: players see the whole map, dimmed outside what their characters see.
- Leaving Explore on a scene players explored, from Players see or the fold's switches, asks first, since players then see the build as it is now on everything they explored, and undo does not bring back what they remembered. Per player back to Whole party asks too where players hold maps of their own, since those join the party's for good.
- Explore on a map image with nothing that blocks sight warns that party vision shows players all of it at once. Moving players to a map image scene with party vision says it may, since the DM's device cannot count another scene's walls.
- A scene with fog off and nothing built that gets its first map image turns fog on, so Everything moves to Reveal by hand. On the players' scene the DM can untick "Start it under fog" to keep Everything.
- **New scenes**: "Players see on new scenes" in Room settings sets what every new scene starts on: Explore in a new room.
  - A map image or a starter map starts on Reveal by hand under Explore, and the form says why.
  - A room from before it reads "As before" until the DM picks one: map images, imports and builder scenes under fog, battle mats without. A new room's first Battle mat starts on Everything, so joining players see the mat.
  - The new scene form and the Universal VTT import offer the choice for one scene, and "Like <scene>", which copies the scene on screen's fog, party vision with its light and Sight, and whether walls stop players' moves. The new scene keeps its own kind's automatic walls, and a per-player copy starts with nobody seeing for themselves yet.
  - Like copies the scene as it is once an upload or a starter copy is done, and if that scene was deleted meanwhile, the new scene takes the room's choice and a toast says so.
- **Copy to other scenes…**, at the end of Fog and vision, copies Players see, Light and Sight to the scenes the DM ticks, listed by folder, in one Setup history step.
  - Each scene's line says what players see there now, where the players are, where remembered maps reset and where each player's own map joins the party's. Movement and walls stay.
  - The sheet says how it went, naming any scene that refused and why, and clears its ticks once every scene took the copy. Undo setup, in Setup history, puts the settings back, not players' maps.
- The Fog tool clears or adds fog with a rectangle, a polygon, a brush, or a whole builder room in one tap (the "Builder room" shape). On a hex scene Builder room takes every hex a tap reaches without crossing a wall line, window, closed door or secret door not yet found, up to the map's edge where nothing walls it in. The DM sees the fog as translucent.
- The DM edits fog privately and publishes it when ready. A live mode shows each edit at once.
- Fog never flashes the map. A player's map stays hidden until the fog has loaded, and missing fog reads as all fogged. At the scene's edge no hairline of map shows through the fog at any zoom, in Top-down or Isometric, and the DM's fog stays one even tint there.
- On a hex scene fog keeps its map-wide shapes and a creature is read on the fog inside its hexes: it stays hidden while all of them are under fog and shows once any part of one is revealed.
  - Walls block sight there as on squares, and a creature with a wall through its hexes shows only by the part on its middle's side of the wall, for any wall the viewer's own map has, so ground revealed beyond the wall never shows it, and a wall a player has never seen never hides it.
  - Party vision and per-player sight work as on squares. A room revealed with Builder room shows its hexes by the fog inside them, so a creature standing in one of them shows.
- Monsters and labels standing fully under the fog never reach players. Player characters always stay visible to the party.
- A creature a player drags under the fog vanishes for them, with a note saying so.
- "View as a player" shows the DM the scene as a chosen player can see it, their own sight and map included, only what they may see, and no whispers between players. It is drawn on the DM's device, not a mirror of the player's screen.
- In Isometric nothing stands up over a player's fog: something stands only where all the fog under it is revealed to that player, and lies flat under the fog otherwise.
  - On a scene where each player sees for themselves, that is the player's own map. The DM's standees on ground the DM's map shows fogged, the party's explored ground counting as revealed, draw dimmed.
  - On a hex scene a hex's height stands once any part of it is revealed, its top keeping the fog and sight drawn on it, and a hex wholly under fog lies at 0. The Fog tool shows Top-down while in use.
- **Party vision.** Explore, or the "Party vision" switch in a scene's Fog and vision settings, makes players see only what their characters see. Light and weather sets the light to Bright, Dim or Dark. Every player then sees what any party creature sees.
  - Walls, closed doors, secret doors not yet found, pillars, and raised ground above a creature's eyes block sight. Windows do not.
  - Darkvision, Blindsight and Truesight come from the creature's senses. Darkvision shows darkness in gray.
  - Lights from the builder and on tokens light the scene.
  - Ground the party has seen stays drawn, dimmed and without creatures, as the party last saw it. A wall added, a door taken away or opened while the party is elsewhere shows on their map only once they see the place again. Ground never seen stays fogged.
  - Creatures appear when they come into sight and vanish when they leave it, Initiative rows included.
  - The DM can mark a creature, such as an allied NPC, to share its sight with the party.
  - The DM's own map stays fully lit. The "Party sight" switch shades what the party cannot see.
  - Moving players to a scene where no party creature can see warns first.
  - A creature a player drags out of the party's sight vanishes for them too, with a note saying so once the server answers the move, since a light it carries can keep it in sight.
- **Discovering the map.** On a scene with fog, players' devices hold the build only where the party has seen it or the DM revealed it. A room nobody has seen never reaches them, not its floor, walls, doors, heights, labels or stamps, and a corridor running on into the dark ends on their map with no wall across it. On a fog-only scene revealed ground always shows as it is now.
  - What the DM builds where the party can see shows to them as it is built, and the inside of a room built around them stays empty on their map until someone looks in. While a builder stroke touches ground the party sees, the builder's row says "The party can see where you are building, so they see it as you build. Build before players come here, or tap Fog all when done."
  - Each player's map keeps only so much that changed out of their sight.
    - A change that would run past it asks the DM first ("Players' remembered map here will be forgotten. Go ahead?"), and Go ahead puts that ground back under their fog, as if never seen.
    - A big rectangle or shape asks before any of it is built, with the builder saying it is checking players' remembered map while it waits and taking no other change until the answer (Undo drops the waiting change, and Redo does nothing meanwhile), so Cancel leaves it all unmade, and a stroke asked about partway builds nothing past that point.
    - If the connection drops before the server answers Go ahead, the DM is told to check the map.
    - Undo and Redo ask in their own message, with "Forget and undo" or "Forget and redo". Those messages keep their remaining time while they wait on the builder or show expanded, including when both happen at once.
  - While another builder change waits for its check, the forget question disables Go ahead and says "Checking players' remembered map…". Cancel stays available.
  - Fog all forgets what the players' maps remembered of the scene too. Deleting a library image that only players' remembered maps still show drops it from their maps.
  - The player view of Export as image on a scene with fog draws what players' maps hold, asked from the server, even after the DM clears the build, and says so when players have seen none of it.
- **Sight per player.** Under Party vision, a scene's "Sight" is "Whole party" (the default) or "Per player".
  - Per player, each player sees only what the creatures they own see, plus the creatures marked to share sight with the party, and keeps their own map of where they have been. Party members stay visible to everyone.
  - Rules every player shares read only what every player sees, so a stopping trap that a creature walks into on ground only its own player sees stops it as on unseen ground (see Traps, Going off).
  - On a hex scene a creature the whole party can see shows on every player's screen, and a player whose own map has a wall near it may also see a creature behind that wall which the others see anyway.
  - A creature only another player's character sees, its Initiative row, and labels, pins and stamps on ground only another player remembers never reach a player. They see "Another creature's turn" while it acts.
  - "Who sees for themselves" lists the room's players. Up to 6 a scene see for themselves: a player joins, ticked, the first time they own a creature that sees there, while fewer than 6 are.
    - The DM ticks and unticks them, and an untick asks first, since that player forgets their map of the scene. Places stay until the DM changes them.
    - A choice made from an older list asks the DM to try again, so it cannot remove a player who just joined the list.
    - Players not ticked, and the table display, see only what creatures that share sight see.
  - **Sight sources** says whose sight each creature adds to: "Lends its sight to Ana", or "to every player" for one that shares sight.
  - The DM's reveals, hides and Fog all apply to every player's map. Switching to Whole party pools every player's map into the party's, and it stays pooled when the scene goes back to Per player. A map phase or a light change keeps the choice.
  - A door is open or closed for everyone at once.
    - A door a party member opens or closes shows its new state on that player's map and on the party's shared map.
    - Another player who sees for themselves, where their own map remembers the door, keeps its old state until one of their creatures sees it.
    - A door the DM changes shows the change on a player's map only once one of their creatures sees the door. A player's map shows no door they never explored.

## Weather

A scene can have weather over its map: rain, snow, fog, falling leaves, ash or sand, each light or heavy, with a wind that blows toward one of eight directions. It is a look first. It never changes what anyone can see, because sight, fog and light work as they do without it.

- **The DM sets it** in the scene's settings, **Light and weather**, under Light. The folded group names the light and the weather ("Dim · Heavy rain · Strong wind", "Clear"). Weather is set only there and shows on the map itself: no other panel has a row for it.
  - **Weather** picks Clear, Rain, Snow, Fog, Falling leaves, Ash or Sand. **Strength** is Light and Heavy, Patchy and Heavy for fog, or Blowing and Sandstorm for sand. **Wind** is Calm, Moderate or Strong, and a wind can blow on a clear day.
  - **Direction** is a compass of eight buttons around a small square that stands for the map, turned as Top-down shows the map's edges. Its help says where it blows toward, by the map's edges as Top-down shows them, and the compass itself is named "Wind blows toward". A wind starts toward the bottom right.
  - Strong wind disperses fog, so Fog refuses a Strong wind (picking Fog in a Strong wind lowers it to Moderate and says so). A sandstorm is a strong wind, so Sandstorm needs it (picking Sandstorm raises the wind to Strong).
  - **Weather rules on rolls** is on at first.
    - Its help says what rolls here do in one sentence, such as "Perception checks here roll with Disadvantage.", and under it one line for each part of the weather says what the SRD says, such as "Heavy rain: Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks. Puts out open flames." Heavy fog's line is in the warning color.
    - Turn it off where the party is indoors: the weather and its lines still show, and the help says "Rolls here ignore these rules."
  - Every change applies at once, is one step in Play history ("changing the weather of the scene Forest road") and can be undone. Co-DMs have the same rows, and players have no control. Duplicating a scene copies its weather. "Copy to other scenes…" and "Like" do not, and a new scene starts clear.
- **Players see it** on the scene they are on, drawn over the ground and under every token's name, chips and HP bar in Top-down, and in the air in front of the ground and standees in Isometric.
  - A screen reader hears "Weather here: Heavy rain, Strong wind." in the polite status when they arrive on a scene with weather or its weather changes, and "The weather here is clear now." when it clears.
  - The DM's device, View as a player and the table display draw it too, and the table display's polite status says it as well.
- **Weather moves with the map.** A pan or a zoom carries every drop, flake, leaf and bank of fog with the ground under it, at the same size on screen. Zoomed in, the drops spread out and more fill in between them.
- **Rolls follow the SRD's rules** where they need no judgment, for creatures whose token stands on the weathered scene (a character with no token there is not in it):
  - Heavy rain, heavy snow and a sandstorm give Disadvantage on Wisdom (Perception) checks, named for the weather on the roll's option and in its reading. The roller can change it as with a condition's.
  - Strong wind gives Disadvantage on an attack the app knows is made with a ranged weapon: a stat block's bow, crossbow or sling, or a character's, by its name (D&D Beyond's "Crossbow, Light" included) or, for a weapon imported from D&D Beyond, by D&D Beyond's own word, so a magic bow named for itself counts.
    - A re-sync brings that word to a weapon imported before the app read it, unless the roll was changed here.
    - Any other ranged or thrown attack gets a note, "Strong wind: Disadvantage on ranged attack rolls with weapons.", and no preset, and so does a character's weapon whose name is none of the SRD's ranged or thrown weapons, such as a Longsword, since the app cannot tell how it was used. A stat block's melee attacks, spell attacks and the bare d20 get nothing.
  - On the Dice panel a bow's Attack shows "Dis", the weapons' group line names it ("Longbow Dis: Strong wind") with each note once, and every other note shows under the name of the group it bears on, as a condition's reminder does: patchy fog's under Skills. A shared attack for several creatures says the same under it.
  - Patchy fog and heavy fog remind on Perception checks (heavy fog on attack rolls too) and never preset, since "that rely on sight" and "trying to see something" need a call only the table can make.
  - The rules and the notes are the SRD 5.2.1's words (Environmental Effects, Obscured Areas), and a request's card lists them with the creature's conditions.
- **Each device chooses how it looks** in This device, Weather (below), and the table display's menu has the same three choices. The drawing is made in code, with no image files, and stops whenever nobody can see it.
- While the DM uses the Builder, Fog, Line up grid or Traps tool, weather hides on the DM's device, and comes back with the next tool.

## Areas of effect

- Shapes: Sphere, Cylinder, Cone, Cube, Line and Emanation.
- Place an area freely, or cast it from a token: Cones, Lines and Cubes start at the caster's edge, and Emanations surround the caster. Aim by dragging or with a handle, in 15° or 45° steps or freely. Cones and Lines can aim up or down.
- A player's area tool always shows who the next area comes from, such as "From Thorn".
  - It starts on when Thorn is your only character on the scene, and a tap turns it off or on. With a companion or a second character it lists them, and No caster. With none of your creatures on the scene it stays, greyed out, and says why.
  - It stays as you left it until you reload, and selecting your creature before opening the tool still casts from it. While an area comes from your creature, a tap on another creature aims it there.
  - Set caster in More options casts from someone else. The DM's areas start with no caster, and once one is cast from a token the same button drops or restores it.
- Spell presets from SRD 5.2.1: search "fireball" and get a 20 ft Sphere.
- A private preview shades the squares and lists who is in it ("In area (3): Goblin 1, Goblin 2, Thorn (ally)") before you place it. A Cone, Cube, Line or Emanation leaves its caster out unless you include it. A Sphere or Cylinder catches a caster inside it.
- Auras stick to a token and move with it, such as Spirit Guardians or a Paladin's aura. The list of who is inside updates live.
- Placed areas stay until removed. They move, turn and resize, and show to everyone or to the DM only. Only the DM and the area's owner change one.
- An area's name keeps clear of tokens and their names, and on a player's screen of fogged ground.
- On a hex scene an area keeps its true shape and is graded per hex by the same rule (at least half the hex by default, "Which squares or hexes an area covers"), and the board shades the hexes it catches.
  - An Emanation is counted in hex steps from its creature's hexes instead (a 15 ft one on a Medium creature covers 37 hexes), so it agrees with the ruler.
  - Free points snap to a hex corner or center, a placed area moves by whole hex steps, the rotation snap is 30°, and a Cone, Line or Cube cast from a token starts where the aim leaves the outline of its hexes.
  - An area that slows movement inside slows each hex it covers, for a drag and the walking ruler.
- Room settings choose which squares an area covers (at least half the square, which is the 2024 rule, any part of it, or its center) and which creatures it catches (any of their squares, their center, or most of their space). On squares, a creature whose center is off the scene is left out by the center rule, including after the scene shrinks.
- Height counts: every shape measures in 3D. An area put down on a platform starts at the platform's height, and one moved before it is placed keeps its height above the ground. In Isometric each area stands as the shape it measures, cut by the ground where it meets it, along the raised hexes' own sides on a hex scene.
- Walls block an area.
- On a player's screen an area being aimed, their own or one another member shares, shades only the ground their fog reveals, in Top-down and Isometric, as a placed area does.
  - Its outline still shows whole. On a scene with fog, every area on a player's screen, aimed or placed, moving with its creature or still, shades, rings and lists who is in it by only the walls beside ground the player's fog reveals, so where walls lie under the fog it can differ from what the area catches.
  - It rings and lists a creature only where every line it reads to it lies on ground the player sees right now (or, without party vision, ground revealed to them), as the area's reminders do. The DM's screen reads every wall.
- **Save and damage** (DM): from a placed area, the group save for everyone it catches, filled from the spell and its caster, or No save for damage everyone takes. Temporary HP and Concentration saves follow, and one undo takes it all back. A player's own area offers **Ask for saves** in its place, which asks the DM for that group save (Dice, Roll options). While the ask waits, the area reads "Saves asked" and its player can't move, resize or delete it until the DM resolves it or the player withdraws. The DM still can.
- **Movement inside**: an area can make walking through it cost more, as Difficult terrain, Plant Growth's 4 ft per foot, or Spirit Guardians' Half Speed, for everyone or, with a caster, only the caster's enemies. An area on a creature, or on a token that rides or is carried with it, such as a lamp it holds, moves with it and never slows that creature. Presets set it where the spell says, such as Web, Spike Growth, Grease and Spirit Guardians.
- **Reminders**: an area can remind when a creature enters it, or starts or ends its turn in it, as Spirit Guardians, Moonbeam and Web need. Presets turn them on where the spell says. During a fight's turns, each reminder goes in the log, and reaches players only for what they can see.
- A room setting decides whether players see each other's areas.

## Traps

- **The Trap tool** (DM), a setup tool after Pin, picked with X.
  - Its options start a new trap from Blank, from Alarm (a note for the DM only, nothing players can see), or from one of the SRD's example traps, credited in [shared/srd/NOTICE.md](shared/srd/NOTICE.md): Collapsing Roof, Falling Net, Fire-Casting Statue, Hidden Pit, Poisoned Darts, Poisoned Needle, Rolling Stone and Spiked Pit, each at a party level of 1–4, 5–10, 11–16 or 17–20 with the SRD's DCs and damage for it.
  - Its zone is Squares (drag a rectangle snapped to whole squares, or tap to place the preset's own size, such as a Hidden Pit's 2 by 2 squares, or one square), a Trip wire (drag from one end to the other, ends on square corners and edge midpoints, at most 20 squares long) or a Door (tap one). A preset picks its zone's kind.
- A tap on a trap with the tool opens its pane.
  - Its first line says where it started ("From Hidden Pit, levels 1–4").
  - Its sections fold to one line each:
    - **Name**
    - **Trigger**: a creature steps onto it, starts or ends its turn on it, or steps off it, crosses the wire or opens the door, with Add squares for up to 8 rectangles, and who: Party, Others or Any, with a line under it saying who that is, Small or larger only, and only creatures on the floor, which leaves out fliers, burrowers and riders.
    - **Aftermath**: a switch that arms it again at the start of the next turn, off for a trap that goes off once, its uses left, stops the creature where it goes off, marks itself found when players see it go off, and for squares opens a pit so many feet deep, which reads Opened with its floor once it has opened.
    - **Targets**: the creature that set it off, everyone on the trap, everyone in squares drawn on the map, or everyone in an area placed with the Area tool's shapes and saved into the trap.
    - **Save and damage**: the group save's fields, a dice formula that does not read saying why under it once you stop typing, or on Enter, and going back to the last good dice when you leave it first.
    - **Message**: a line of up to 200 characters and a sound (click, rumble, crash, whoosh or hiss), with Play to hear it.
    - **Map effects**: up to 8 things, each added with Add an effect and a tap on the map: close, open or lock a door, put out or light a light, show a hidden creature or a hidden stamp.
    - **Finding and disarming**: up to two checks to find it, the Passive Perception hint, and how it is disarmed, with a check or not.
    - **DM note**
  - Each change saves as you make it. The sections are the panel's own switches, choices and removes, the last way a trap goes off keeps its tick and says why, and a cleared name goes back to the trap's name, saying why once you stop typing. No note comes as you leave a field, so a press below it always lands.
  - A trap that lies past the scene's edge because the scene was made smaller can still be renamed, marked found and edited. Only a new zone or new squares it hits must lie inside the scene.
  - Layout: the pane is a bottom sheet where the map is under 600 px wide, as on a phone held upright, and otherwise a card over the map beside the trap.
- The pane's foot holds **Armed** and **Found**, **Ask to search** and **Ask to disarm**, which open a roll request filled with the trap's checks for the selected creatures or the party, **Set it off**, which sets it off by the selected creatures or else those standing on it, and Delete on a second tap. Arming a trap with no uses left asks for its uses first.
- On the DM's map an armed trap is hatched in red with the wolf-trap icon and its name over it, a sprung one is grey, a disarmed one a grey dashed outline, and a found one shows an eye. A wire is a dashed line with a pin at each end, and a door trap a badge on its door. While its pane is open, what it hits draws faintly. Zoomed out as far as a creature's name hides, a trap's name hides too and its icon stays, on players' maps as well.
- **Going off**: a trap goes off for the creatures it is set for as they walk onto it or across it, open its door, land on it from the height controls, or start or end a turn on it, in the order the SRD's rules give, each trap at most once a move.
  - Only traps on the players' scene go off by themselves, and never while their screens are blacked out, so a DM can build ahead safely.
  - A trap that stops creatures stops the creature, and the group it leads, where it set the trap off, or on the first spot after that where it may stand, which is never a spot where a move would refuse to leave it, such as a Large creature half a square off the grid with a wall through its space.
  - A stopping trap catches a creature as the table expects where every player can see the ground right now or the DM has revealed it, a creature squeezing through a narrow corridor included.
    - That ground must hold the creature's whole space at the stop and the line its walk took since its route's last corner: a space that so much as touches other ground counts as unseen, so a creature walking at a slant along the last revealed column, its space touching the dark column beside it, walks on.
    - On a scene where each player sees for themselves, ground that only some players see counts as unseen here.
    - Elsewhere, explored ground included, a trap stops a creature on squares only where its move passes exactly through a square's middle or at a turn of its route, and a Large or larger creature half a square off the grid nowhere before its move's end, since nothing there shows its space clear of the walls, so a large creature dragged into the dark walks on over an opened pit, and a creature squeezing through a narrow space may stand there only where its walk ends. On hexes most creatures still stop there, a hex or two past the trap.
  - A pit that opens stops a creature that fits in it at the first spot after that where it lies wholly over the opening, so a Large creature that steps half a square onto a 10 ft pit falls to the bottom, taking down what it carries. One too big for the opening, or whose walk never covers it whole, stops at the first spot where it may stand and stays at the rim.
  - Where the party cannot see the ground right now and the DM has not revealed it, a creature squeezing through a corridor narrower than it does not fall into a pit it only passes over, since it cannot stop partway along the corridor: it walks on over the open pit to where it stands at full size again. It does fall when its move ends with its squeezed shape wholly over the opening, and where the party can see the ground or the DM has revealed it, it falls in as any creature that fits would.
- The DM gets a toast, "Hidden Pit went off: Thorn.", with **Save and damage** (or **Apply** for conditions with no save) and the trap's sound where sound is on, and a card in the alerts with who set it off, who it hits, what it did and could not do, and the DM note, with **Save and damage** and **Dismiss**.
  - Save and damage opens the group save on the creatures it hits, as they stood when it went off, filled from the trap, and its Apply settles it. When everyone passes and nothing would change, as against Falling Net, the button reads "Settle: it changes no one" and settles it all the same.
  - A trap set off out of the players' sight during a player's move stays armed for them: the toast adds "The players saw nothing.", and the card offers **Do its effects** and **Mark sprung**.
- A trap that goes off while the DM views another scene still toasts, with its sound: "Hidden Pit went off on Crypt." Its **Show** switches to that scene and toasts again with the creatures' names and **Save and damage**, and the card waits there. The Passive Perception hint does the same, with **Mark found** once there.
- Players read the trap's line in the log, "Thorn: The floor gives way!", and the player whose creature set it off gets it as a toast, with its sound where sound is on. The DM's Log shows the DM's own trap lines among the rest.
- A request for a save against a trap names it "Trap" until it is found, and by its name after, while the DM's page keeps its real name.
- Undo move is refused for a move a trap cut short, or whose trap changed anything its player sees (a line, its outline, a door, a reveal, a pit, or a light within the party's sight): "Could not undo moving Thorn: something happened on the way. Ask the DM."
  - A silent trap nobody found that stops a token where it was going leaves Undo move as it is.
  - The token's bar stops offering it, for that move and the moves before it, once the server's answer says so. The DM's Undo takes a stopped move back, the trap's doors, lights and pit included.
- **Found traps**: players see a found trap's name and outline, hatched in a warning color, and "Disarmed" once the DM disarms it, never whether it is armed, its DC or what it does. Dragging a token across a found trap that is not disarmed says "Crosses Hidden Pit" on the drag label, on a hex scene by the hexes the creature occupies along its walk, starting at its actual full or squeezed size. The DM's drags say it for every armed trap.
- **The Passive Perception hint**: when a party creature ends a walk within 10 ft of a trap nobody found and its Passive Perception would notice it, the DM gets a toast, "Thorn's Passive Perception (16) would notice the pressure plate of Poisoned Darts (DC 15).", with **Mark found**. The app never marks the trap found by itself.
- Hidden stays hidden: no player's device holds a trap nobody found or what any trap does, and no stop, refusal or room limit depends on a trap players cannot see. A scene holds at most 50 traps.
- **On a hex scene** a trap's zone is rectangles of hexes: the zone choice reads Hexes, a drag takes whole hexes and a tap one, and the pane, the hints and Add hexes say hexes.
  - A Trip wire's ends snap to hex corners, and a door trap takes the hex on each side of its door.
  - A trap goes off by the hexes a creature stands on as it walks, and Targets and the Passive Perception hint count hexes too.
  - A found trap reaches a player only once part of one of its hexes is revealed to them, so revealing other ground never shows it.
  - A pit opens on hexes too, its hexes dropping to the pit's floor, and a Hidden Pit started on hexes has its pit.

## Combat and Initiative

- The DM starts a fight with the selected tokens, every token on the scene, or only the visible ones. Players add their own character under "Your creatures".
- Players type in their own Initiative, or tap Roll in their row's Initiative box.
  - With "Players may type their roll totals" off, they roll it, and the server refuses a typed one, whether set on their row or given as the row joins the fight.
  - The DM types in the monsters', taps Roll in a row's box, or uses **Auto Initiative**: by creature (identical monsters share a roll), one each, or all at once.
  - A row's Roll shows while it has no value and the row has room for it, and otherwise its options hold "Initiative, sets its row". The DM's Roll shows on rows no player plays. Once set, its options hold "Roll again, replaces 17", so a stray tap never reorders the fight.
  - Each roll is a d20 plus the creature's modifier, with Advantage or Disadvantage from its conditions. Its dice roll on the server and show in the DM's Recent rolls. Players see the totals, never the dice. It sits right after the order, with what it rolled.
  - A row's Roll has the one-roll options. Auto Initiative and a monster's Roll Initiative have them too, for Advantage, Disadvantage or Normal, their dice always the DM's alone, and Auto Initiative applies a pick before it groups the monsters.
- "Use Initiative scores for monsters" in Room settings, or "Monsters use Initiative scores" in the Initiative panel, gives them 10 + their Dexterity modifier instead of a roll.
- **Roll monsters' Initiative** (DM, Initiative panel): a switch under Start a fight with, on by default and kept on this device for each room. Help: "Auto Initiative rolls for every monster as the fight starts."
  - With it on, Everyone here, Visible to players and Selected token start the fight and then roll for the monster rows that have no value, by the tracker's sharing mode. The pressed button reads "Rolling…" and every roll button waits until the totals land.
  - A fight of any size starts as one Undo step. Undo takes back the totals first, then the start.
  - Offline, the start waits with the rest and the result card says "Rolling needs a connection."
  - With "Monsters use Initiative scores" on, the switch rolls only the monster rows still without a score, such as a custom monster, and with every row valued it rolls nothing.
- The order runs high to low.
  - Dragging rows settles ties.
  - A round counter, Start, Next and Previous run the fight.
  - The round counter and its buttons, or End turn, stay at the top while the order scrolls under them, and scroll away once the order has passed.
    - They stay put only while there is room for them and two rows under them, shrinking to one line where the full ones would not leave that much.
    - The one line never cuts the round or its timer short, and only the words after them end in "…": where it has no room for the round and its timer beside the buttons, they show in full and scroll away with the order, and the one line comes back once a shorter timer or round leaves it room, as when Next starts a turn whose time is not yet up.
    - Where a narrow panel has no room for the round or its timer beside its buttons, the buttons go under them.
    - So they stay put in a panel opened over the whole of a very short screen when its body has that room, and otherwise scroll with the order.
- Previous takes back the last Next: whose turn it is and the round, the durations it counted or ended, the save-ends saves it asked, a Reaction it gave back, the Legendary Action pips it refilled and a hidden creature it revealed.
  - A row the DM added or removed during the turn, a value set, In lair and the conditions and effects added, removed or changed stay as the DM left them, and a save made during the turn stays made.
  - A creature that a new value or a ride moves past the turn Previous goes back to waits for the next round.
  - When the turn it would go back to belongs to a creature that has left the fight, a companion that was dismissed included, Previous goes back past that turn too.
- The active token gets a turn marker. With "Camera follows the turn" on, the DM's map pans to whoever acts. Players' maps stay where they are, unless the DM uses Follow me or Look here.
- Players see the turn order, names and conditions.
  - Turning a token's Hidden off, by its action bar, a group's bar, the H key or its panel's switch, shows its row too, in one undo step, as far as "Initiative order players see" allows: in a new room a monster's row still waits for its first turn.
  - A row's own "Row hidden from players" still hides the row alone, though the creature's owners learn its turn once it moves on it, whoever moves it.
  - With "Reveal hidden combatants on their turn" on, a hidden creature appears when its first turn comes, but only where players could see it: on revealed ground, and with party vision only while the party can see it. While it acts out of their view, they see "Another creature's turn".
- "Initiative order players see" (Room settings, Combat) keeps monsters' places in the order secret until their turn: Player characters, the rest on their turn (the default for new rooms), Player characters and allies, the rest on their turn, or Everyone (what rooms made before the setting keep).
  - Players see the creatures players play from the start, and with allies those with the Ally ring too. A monster or NPC lent to a player shows from the start to that player alone.
  - Every other creature, the DM's NPCs included, joins their order when its first turn comes and keeps its place for the rest of the fight. Before then nothing of it reaches them: no row, value, place or count, and no Initiative roll for it, even one the DM rolls in the open. Previous takes back the turn that showed it.
  - The DM sees every row, and View as a player shows what players see. The DM's row says "Secret until its turn", after the eye struck through that means hidden from players, while players do not see it.
  - The DM's log and Recent rolls mark an Initiative roll kept from players as hidden from players, or hidden from other players for a monster or NPC lent to a player, who still gets the roll.
- A strip across the top of a phone shows whose turn it is. On a phone held sideways it sits in the top bar when the bar has room for it, and on a computer it is a chip in the top bar. Only the DM's strip shows who comes next. On their own turn a player gets "Your turn" in the strip, a vibration on Android or a chime, and an "End turn" button.
- **Next** (DM): the turn chip, and the end of a phone's band, carries an outlined **Next** pill, named "Next turn" with the tooltip "Next turn (N)", or **Start** before the first turn. One press sends one Next and shows busy until the server answers. It is disabled with an empty fight, and it shares its wait with End turn.
  - The band keeps its height and its next faces where they fit.
- **End turn on a phone's own bar**: on your turn, End turn also stands at the right end of your own token's action bar, resting or expanded, where the thumb just acted. The strip's End turn stays. It shows only on your turn, and goes once the turn moves on.
  - At 320 x 568 at 130% the quick row has no room past the HP entry, so End turn is in the expanded bar's play row.
- Rows show AC, HP and conditions. The DM sees every creature's AC, and a player their own creatures'. AC and HP wrap onto a new line together, as do a row's tags, such as Readied, Reaction used and Lair, and a legendary creature's LA and LR, so none stands alone on a line where two fit. Tapping a row opens the same menu as tapping the token.
- Damage and healing take math, and typed damage such as `10 fire + 4 cold` applies each selected creature's defenses separately. Two tokens of one character count once. "Players can apply damage and healing" lets players do it too.
- At 0 HP, monsters die ("Monsters die at 0 HP") and characters get Death Save pips that their player fills in, or rolls with the Death Save row's Roll. "Skip defeated creatures" passes over the dead. The Death Save Roll, in HP and on the turn's death save card, has the one-roll options for Advantage, Disadvantage or Normal, its visibility the creature's.
- Healing a dead creature brings it back with the HP healed ("Healing brings back the dead", on by default). Off, healing does nothing to the dead, and the HP entry says so. The DM's Revive is in a dead creature's action bar and its tracker row's options, and brings it back with 1 HP.
- Per-turn resources: Reaction used clears at the start of the creature's turn, and Legendary Action pips refill.
- **Uses**, in a creature's tracker row options, its action bar, and the Combat group of its Token panel and of a character's page, lists what it can spend, read from its stat block, 2014 blocks included.
  - Each row opens with a title line: its name in bold, and at the line's right end its count as pips, filled for each use left and only to read (a screen reader hears "Legendary Actions, 2 of 3 left"), or a recharge's state ("Used"). A count of more than 6 reads in words there ("7 of 10"), and so does a class resource's pool at any size.
  - A long name wraps beside the pips, and they move to the next line, still at its right end, only where the name's longest word and the pips can't share a line. The row's buttons stand on their own line under it.
  - Legendary Actions are one block: the title with its pips, then a button for each action by name, such as Fiery Rays, or "Wing Attack (2)" for an older block's cost of 2, then Restore. One is off on the creature's own turn ("After another creature's turn"), once spent where the block says it can't be taken again until its next turn ("Until the start of its next turn"), and with too few left ("Needs 2").
  - Then come Legendary Resistance with Use and Restore, a recharge ability (Use while ready, Roll recharge and Mark ready once used), an X/Day ability ("Dominate Mind, 2/Day") with Use and Restore, one a rest brings back, Regeneration's amount, and a character's class resources.
  - Restore is the hand correction: on Legendary Actions, Legendary Resistance and X/Day it is always there, off while the count is full and saying so on a tap ("Legendary Resistance is full."), and it works on the creature's own turn too. On Legendary Actions it frees a spent once-a-turn action first, as Fiery Rays, so Undo is the exact way back from a mis-tap.
  - A use the block no longer lists shows as used with Restore.
  - A button is busy until the server answers, and a refusal says why under the list, as does the list's newest Roll recharge that was refused or lost, while the turn it was rolled on lasts and until the list's next tap. Opened again, the list never repeats one it showed, and an answer that comes after its turn ended shows as a toast.
  - A recharge's words follow its mark: a roll's "Rolled 6: ready" gives way to "Used" once it is spent again, and "Rolled 2: used" to "Ready" after Mark ready.
  - Uses shows only where its list has something in it, but for a character, whose DM and players always find it on the panel and the page, with "Add a class resource". Everyone who sees the list sees the same rows and pips. Stats keeps the counts per round and per day.
  - The DM's rows and companion rows show chips for what is spent, on a line of their own under LA and LR: "Fire Breath used", or "Dominate Mind 1/2" for an X/Day ability, at most three, then "+2 more". Players see the uses of their own creatures and no chips.
  - Everyone who sees a creature reads its uses in the log by name ("Adult Red Dragon used Fiery Rays, a Legendary Action."). Only the DM and its owners read the counts and the line for a use restored ("Adult Red Dragon regains a Legendary Resistance (3 of 4 left).").
- **In lair**, in the row options of a monster whose stat block has a lair (lair counts, lair XP or lair actions), and of no other creature unless its row is already in its lair, gives it its lair's Legendary Action and Legendary Resistance counts and XP, and back to its own when turned off, waiting for the stat block while it loads, and staying off beside a reload where it did not load.
  - What was used stays used.
  - A monster placed in its lair, or added from a saved encounter's lair line, joins the fight with In lair on, whichever way it joins and however long after it was placed: the tracker's New fight or More creatures, or Start a fight or Add to the fight for a selected group. This holds for a stat block with lair actions alone too, whose counts and XP never change.
  - A monster taken out of a fight joins the next one in or out of its lair as In lair last stood. Where its stat block's lair changes its counts or XP, its counts decide, so a monster whose counts the DM set back by hand joins out of its lair.
  - Attaching another stat block, or detaching it, clears the monster's remembered lair tick, and so does a room monster edited to have no lair. Counts that tell a lair still decide the next join, so a red dragon relinked to a blue one keeps 4/4 and joins in its lair until its counts are set back.
  - Those buttons wait while a stat block they need loads, and stay off beside a reload where it did not load.
  - The mark itself never reaches players. A monster's own players still see its lair's legendary counts and XP.
- Recharge is room state: an ability marked used, from Uses, the Dice panel or its damage or group save, shows as used on every device and after a reload. Old builds' marks kept in one browser tab are dropped.
- **Turn-start cards**: at the start of a creature's turn, whoever answers for it, its player or the DM for a creature no player plays, gets a card for each thing the turn asks.
  - A recharge: "Fire Breath can recharge (5–6)." with Roll, Mark ready and Dismiss.
  - Regeneration: "Troll regenerates 15 HP." with Apply, Skip and Dismiss, or "Troll is at 0 HP and regenerates 15 HP." for a dying troll, with "Recorded Fire damage may stop Regeneration." when the damage it took since its last turn was Fire or Acid, from a damage roll's Use chip or a group save whose damage names its type, a typed "28 Fire" or a row's amount typed over included (a plain number typed into the HP entry carries no type, so it is not counted).
  - A death save for a dying creature: "Thorn is dying. Death save: 1 success, 2 failures." with Roll, Skip and Dismiss, which reads "Waiting for Regeneration" while that card is open. A monster gets one only with "Monsters die at 0 HP" off, and the DM also gets a player's character's death save card.
  - The first roll from any device, card, bar or Dice panel settles it, its result stays through a reload ("Rolled 5: Fire Breath is ready."), and a second roll, one after Next or one for a creature healed meanwhile is refused before its die. A settled death save card shows its result alone, without the dying line and the pips.
  - Dismiss hides a card on this device for the turn, and Skip answers it for everyone, with Reopen on the turn card and in the creature's Uses, in its tracker row's options and its action bar, until Next. So Reopen stays in reach after the turn card is dismissed, and a skipped card alone is enough to show Uses. Next ends the cards, and Previous brings back the turn's cards as they were left, with their results.
  - The Roll on a death save, Concentration or save-ends card has the one-roll options for Advantage, Disadvantage or Normal, its visibility set by the creature, and a recharge card's Roll has none, nor has Uses' Roll recharge.
- **The turn card**: from a creature's turn start to its end, whoever answers for it gets its menu, "Adult Red Dragon's turn": Use Legendary Resistance, Legendary Actions with their pips and "After other creatures' turns" with no button on its own turn, its recharge and X/Day abilities, a character's class resources, and a block for each other creature of the turn they answer for, such as a controlled mount.
  - Its x, Dismiss, hides it on this device for the turn, and the chevron before its title, Collapse, folds it back where it was folded, to one line of its name and its count that opens again on a tap.
  - It stands last among the alerts, under the time-up line and notices, so on a phone held sideways those stay whole above a docked action bar.
- **A creature's attacks on its turn card**: the card lists them as the Dice panel's rows (Attack, Damage, Critical and the rest), with this turn's results under each, the card's title counting "2 attacks, 3 uses". It says "Loading attacks…" while they load. Tapping Attack or Damage there rolls as in the Dice panel. A player's own turn card lists their creature's weapons. If the rolls table fails to load, an attacks-only turn card stays and says "The attacks did not load. Reload to try again."
- A Ready marker (Hold is the same thing) records the trigger and shows on the row and the token until the creature's next turn. Players learn only that a monster readied, not its trigger.
- The combat log keeps each HP change ("Goblin 2 takes 7 damage, 3/7 left"). The DM can take any one back while the creature is still as that change left it.
- An HP change whose take-back record is very large, such as one that removed many effects at once, can't be taken back.
- An optional turn timer, from 30 seconds to 10 minutes. It never ends a turn.
- "End the fight" ends it, with a second tap to confirm.
- When a room has a clock, ending a fight adds 6 seconds to it for each round, the round it ended in counted whole (see Date and time).

### Encounter builder

- The Encounters panel (DM) builds an encounter from SRD monsters and the room's own, with a count for each, and In its lair on the line of a monster whose stat block has a lair (lair counts, lair XP or lair actions), as on the Monsters place card, or whose line is in its lair already, so it can be taken out.
  - For lair actions alone it says the monster joins a fight with In lair on, a reminder that its lair acts.
  - A line ticked before its stat block lost its lair says its stat block changes nothing in its lair, and its monsters are placed out of it.
- It shows the 2024 XP budgets (Low, Moderate, High) for the party, from each character's level, and which budget the encounter fits. The DM can change the party for one encounter.
- Saved encounters drop onto any map, hidden from players if the DM asks. In a running fight their creatures can join the tracker. One undo takes it all back.
- With unsaved changes, the editor's back button asks "Discard changes?" first, and a second tap leaves.

### Companions

- A companion is a token that belongs to a character: a creature such as a familiar or a summoned spirit, or an effect with no HP such as Spiritual Weapon. Whoever plays the character controls it: moves it, changes its HP, conditions and stats, renames it and dismisses it.
- Each companion takes its own turn with its own Initiative, acts on its character's turn listed under it in the order, or acts on its character's turn and stays out of the order. Only a creature takes its own turn. A new creature starts listed under its character and a new effect out of the order, unless its maker picks another turn. One made with its own turn while its character is in a fight joins that fight at once, in a row of its own with its Initiative still to roll.
- A player adds a companion from their character in the Characters panel. It goes right next to the character's token, up to 10 per character on a scene, and the DM's log says so. The DM can make any token a companion in its panel.
- A creature companion can have a full stat block: an SRD 5.2.1 creature, such as an owl for Find Familiar or a wolf, text pasted from a book with "Paste a stat block", or one typed in the editor.
  - Its players and the DM read it in its panel, and its action bar shows its saves, resistances and immunities. Other players see its token, name and HP as before.
  - An SRD creature picked for a new companion with no picture of its own gives it the monster's default icon, even where the DM picked another image for that monster's tokens. Picking another creature swaps that icon, and the name the first one filled in, for the new one's, so an owl changed to a wolf is named Wolf. A picture or name you chose yourself stays.
- A character keeps up to 100 stat blocks for its companions, so a familiar summoned again starts from the same block. Its players and the DM add, edit and delete them from the character's page, under Stat blocks, a page of its own with Back to the character. "Add a companion" can start from one, which fills in the form.
- Attaching a block can set the companion's AC, max HP (the block's average, a typed number, or the maximum it has), Speed, size, senses, Passive Perception and Initiative. An unhurt companion stays at full HP, and a hurt, dying or dead one stays so. Conditions, effects and Temporary HP stay.
- A block's size goes through the same resize as any token's.
  - A companion its player grows near a wall grows into the space around it, still covering where it stood, and moves just enough to stand where a move could end, never across the wall, or keeps its size with "No room to grow here", while the block and its other numbers still apply.
  - Ctrl+Z right after attaching takes back the size change alone, and the block and its numbers stay. Detach takes the block off.
- A summon cast at a higher level takes its AC and HP as you type them when you add it.
- A companion listed under its character keeps its own Reaction and Ready action in the order.
- A companion's token panel says whose it is under its name ("Companion of Bree"), as its own row in the order does, and its picture carries its character's portrait at the corner. For the DM and the character's players, "Companion of Bree" opens Bree's page in the Characters panel. With a form open in Characters, the link leaves it for the page, asking "Discard changes?" first if something is typed.
- Other players see a party member's companions, under the character in the order, with HP as "Players see the party's HP" allows. A creature companion lends the party its sight, an effect does not.
- Effects on a companion that acts on its character's turn count that character's turns.
- A companion stays on its scene when the party moves on. The DM finds the ones left behind by searching "companion" in that scene's outliner.

## Dice

Every roll happens on the server, with a secure random source, so everyone sees the same result and nobody can fake one.

- The Dice panel is for everyone, after Initiative among the tabs.
  - Type any formula and tap Roll, or press Enter: "10d4+1d8", "4d6kh3" (keep the three highest), "4d6dl1" (drop the lowest), "d%", "2d6+3 fire" (the words after the formula are its label) or "1d20+5 Stealth adv".
  - A roll holds up to 100 dice and 20 parts.
  - The line under the field reads the roll and its range before you roll it, such as "2d6+3, fire: 5 to 15". Where the field is too narrow for its hint, the hint shortens to "1d20+5".
  - Quick dice, the d20 first, then d4 to d100, add a die to the field, and line up with its edge.
- **Next roll** sits under the quick dice: Adv and Dis joined as one choice of two, and Secret beside them, since it answers who sees the roll rather than how it rolls.
  - Where the row has no room, as on a phone at 130%, Secret wraps under them and fills its line.
  - All three are for the next roll only: the tap that rolls takes them, and they go back to their start, so a second roll never shares the first one's Advantage.
  - Advantage and Disadvantage cancel to a normal roll however many of each a roll has, the words "adv" and "dis" typed in the field included.
- **One-roll options**: hold a roll button for half a second, right-click it, or press ContextMenu or Shift+F10 with it focused, for Roll with Advantage, Roll with Disadvantage or Roll secretly, for that roll alone.
  - Roll normally shows too where a tap would roll otherwise: on Again, which repeats its recorded mode, and while Adv, Dis or Secret is pressed under Next roll or a mode word is typed in the formula, for any roll that takes them. Elsewhere a tap already rolls normally, so the menu leaves it out.
  - Nothing rolls until a pick, and the pick rolls once.
  - The menu names its roll at its top in the button's own words, such as "Perception +4" or "Again: 1d20+5", or the roll's name where the button says only "Roll", and the button wears an accent ring while its menu is open. The menu shows its choices and nothing more: why Roll secretly is off, and what Roll normally keeps, are each choice's description for screen readers.
  - A pick neither consumes nor changes Next roll's Adv, Dis and Secret: they stay pressed for the next ordinary roll and stay the visible way to do the same, and a plain tap or Enter rolls as before.
  - Each pick overrides only its own part of what is pressed, for this roll. Advantage or Disadvantage replaces a pressed or typed Adv or Dis and keeps a pressed Secret, and still cancels against the creature's own, such as Restrained. Roll secretly keeps a pressed Adv or Dis. Roll normally drops what was pressed or typed and keeps the creature's effects and the roll's usual visibility, so a DM's monster roll stays secret.
  - Roll secretly is Secret as it always was: the DMs and the roller read the dice, and other players read only that it was rolled in secret.
  - A roll with no d20, such as damage or healing, offers Roll secretly only, and Roll normally beside it while Secret is pressed.
  - Where the route sets who sees a roll, as for a request's answer, a death save, a fight card, Auto Initiative and Again, Roll secretly shows off, and a screen reader hears its reason.
  - A press, hold or right-click on the open menu's button closes it without rolling, and so do Escape and a scroll that takes the button out of view. A finger scrolling the panel keeps the menu open beside its button, and a tap elsewhere closes it as the finger lifts. Any pop-up does the same: a touch that scrolls the page under it leaves it open, and it closes once its button scrolls out of view.
  - A screen reader's double-tap and hold opens it, and a plain double-tap still rolls.
  - Under Next roll: "Hold or right-click a roll button for one-roll options. Keyboard: Shift+F10."
  - The result shows where it always does. The newest roll's description and announcement name the mode the server rolled and Secret. Elsewhere, a result keeps the words it always showed, and a mode or Secret the menu adds shows on its line only where that costs no line, else only to screen readers. No plain "Normal" is added, and Auto Initiative keeps its Adv or Dis badge and its cancel note.
  - Layout: It stands over every panel and sheet, never cut off by the one that holds its button, above the button, or below it near the screen's top where it fits there and not above. Where it fits on neither side but fits the screen, as on a small phone at a larger interface size with the button mid-screen, it slides back over its button until every choice shows. A press that starts within 350 ms of its opening, such as a quick second tap on the button, neither picks nor closes it.
- **Rolls from a stat block** are the newest roll too, with its Again, but take none of the Next roll choices, so Adv, Dis and Secret pressed in the Dice panel stay pressed. Their dice throw from the ability box into the stat block's own panel, never the Dice panel's tray, and the Dice panel's line shows the roll as they land.
- Secret: a DM's rolls for monsters start secret.
  - The Secret chip follows the selection, so a formula the DM types with a monster selected starts secret too, and one typed with no creature selected, or only creatures players play, starts public.
  - One tap changes it. A press holds for the creatures it was made for, and selecting another creature starts Secret again, so a monster's roll starts secret even after the last monster's was shown.
  - A player can send one roll to the DM only. The DMs and the roller read it in full. Other players read "Mara rolled in secret." only when the same roll made public would have reached them, so a roll for a creature they cannot see leaves no trace.
- The newest roll stays at the top of the panel, with its dice as chips, a dropped die struck through and a natural 20 or 1 marked, and Again rolls it once more.
  - An answer to the DM's request and a Death Saving Throw show there too, with no Again, since neither can go again as it went. A refusal shows there with its reason.
  - On a narrow screen it keeps the total, a Critical Hit's sum and Again whole, shows the dice that fit whole with "+2" for the rest, and ends a long name in "…".
  - A tap on it opens the roll in Recent rolls.
  - It is the one place a roll's result shows in the panel: no row repeats it, so the panel never grows under a button as rolls land.
- Recent rolls lists every roll in the log, newest first, a roll of several dice groups as one row, with Again on your own.
  - Again rolls it as it went, so a creature's save rolled again is that save again and a condition that fails it, such as Stunned on a Dexterity save, still records the fail.
  - A row of one line is one touch target tall, its words level with Again.
  - Older rolls are in the Log.
  - Recent rolls folds like the panel's other groups, open at first, and stays folded or open on this device whoever you roll for. Folded, its row shows the newest roll, such as "Thorn 20 Longsword".
  - A tap on the newest roll at the top opens it for the page without changing what is kept, and brings the roll into view.
  - Again's one-roll options, on the newest roll and in Recent rolls, repeat a d20 roll's recorded formula with the mode picked, rebuild none of the creature's effects, and keep its visibility, a public repeat labelled "Repeated roll". A roll with no d20 has none.
- Others' rolls show as toasts while your Dice panel is not on screen, one for each roll ("Bree rolled 19 for Stealth.", or a damage of two types as its sum, "Bree rolled 14 for Flame Tongue damage."), and a roll of your own whose panel closed before it landed shows as one too.
  - The same holds when the panel or pane was only hidden before the roll landed, whichever panel it came from (a group save, a shared attack, a cast's damage, Auto Initiative or the Dice field).
  - This device can turn the others' off.
  - A toast of one d20 roll (an attack, a save, a check or Initiative) leads with a flat d20 showing the die that counted. A Natural 20, or a Critical Hit against an AC, rings once in your accent, and a Natural 1 is outlined in red. A screen reader hears the verdict after the toast's words.
- **Apply to**: under a damage roll on the turn card and under the Dice panel's newest roll, and on the DM's toast of someone else's damage roll, up to four creature chips ("Apply 6 Slashing damage to Thorn"), the roller's enemies nearest first, then the others by distance. A toast's chip pressed while another chip of the roll is busy says "Already applying this roll." and the toast stays. A roll whose toast reads the same as one still shown gets its own toast and chips.
  - The DM's chip applies the damage at once, through the creature's defenses, as one Play step. The chip shows busy until the server answers, then leaves the row, which reads "Applied to Thorn." A refusal shows its words in the row, such as "That creature is no longer on the map." or "That could not be sent." Undo takes the damage back and the row keeps "Applied to Thorn."
  - A toast with chips stays open while a chip is busy and closes once the change lands.
  - With "Players can apply damage and healing" on, a player's chip under their own roll fills that creature's HP entry ("Fill 6 Slashing damage for Goblin 2") and does not send it, since a player has no Undo. Apply sends it. A player sees no chips under anyone else's roll.
- **Roll animation**: a roll you make in the Dice panel throws 3D dice into a band under the newest roll, from the button or field that rolled.
  - They tumble and land on the server's faces 1 second after the answer arrives, and the total, its chips and the Recent rolls row show then.
  - The deciding d20 of a Natural 20 or a Critical Hit rings once, and a Natural 1 is ringed in red.
  - Up to two rows of dice show, the rest counted on a "+N" disc, and percentile dice throw as a tens die and a units die.
  - Any tap or key in the panel during the throw, a newer roll, closing or resizing the panel, or leaving the page shows the result at once, and the tap or key still does its own job. A screen reader hears the result as it arrives.
  - Only your own rolls from the Dice panel and from a stat block throw: others' rolls, the tracker's Roll, rolls for several creatures, the group save and Auto Initiative show at once, as before.
  - The dice load in the background after the room opens, so a roll before they are ready shows at once.
  - With reduced motion, the dice appear already at rest and the result shows at once. With Low power, the switch off, or a device that cannot draw them, every result shows at once.
  - The dice are drawn in code, with no image files.
- Rolling very fast pauses you for a few seconds ("You are going too fast. Wait a few seconds."). A room's day holds 10,000 rolls and applied changes, a player's 2,000, and the players together leave the DMs 2,000 of them.
- A roll needs a connection: while the room is offline, Roll is off and says "Rolling needs a connection." A roll sent just before the connection dropped is sent again and still rolls once. If its answer was lost, the device asks the server what became of it, and never rolls it again by itself: "This may have happened. Check the log."
- **Roll options**: the DM taps a token, a player picks a character, a companion or another creature they own, and the Dice panel lists its saves, checks, skills, Initiative, Death Saves, attacks with riders and Critical Hits, save actions, healing and recharge, from its stat block, 2014 text included.
  - They sit in a card under a line that parts them from the roller: the creature's picture, its name and a line such as "Level 5 character · Medium (5 ft)", then the Ask switch, Death Save while it is dying, a typed bonus where the app knows none, and Initiative, whose tag says what the tap does ("replaces 12 · −4").
  - A player with two or more creatures, such as a character, its companion and a lent NPC, picks one from tabs across the card's top, the picked one underlined.
  - Under the card the options fold into groups in the stat block's order: Saves and checks, Skills, Traits, Actions, Bonus Actions, Reactions, Legendary Actions and Spells, the spells under Cantrips, Level 1 and so on where they span levels.
  - On a computer Saves and checks start open and on a phone folded, Skills and Traits start folded everywhere, and the rest open. A group you fold or open stays that way on this device, kept apart for characters, companions and monsters, and viewing as a player never stores one.
  - A folded group shows a one-line summary, such as "Str +4, Dex +1, Con +3…" or "DC 14 · +6 to hit · 13 spells". A new ask for a save or check, or a new ask for saves you cast, opens its group once, and while one waits in a group you folded again, its summary leads with it: "Asked: DEX save".
  - A token's Roll lands the panel on Next roll, whole under the newest roll, with the card after it. Roll in a token's action bar opens them.
  - A named roll is one line of text as a stat block reads ("Longsword +6 to hit, 1d8+3 Slashing, +2d8 Divine Smite", or "Sacred Flame DC 14 DEX, 1d8 Radiant" for a save spell, which names its DC) over one line of its controls, Attack, Damage, Critical and its riders by name, and a slot level between a minus and a plus.
  - Conditions such as Restrained, Poisoned or Bless set Advantage, Disadvantage or a die on every d20 roll, and an effect every roll of a group shares is named once in the group's label ("Saves: +1d4: Blessed") rather than on each button.
  - A reminder that needs the table's call, such as Frightened's or patchy fog's, shows before you roll, once under the name of each group it bears on (Saves and checks, Skills or an attacks group), and Initiative's and the death save's under their buttons on the card. A group of attacks also says under its label what only some of its weapons bring. Each reminder joins its roll's name for a screen reader too.
  - A roll the DM asked for answers the request, Initiative goes into the tracker, and the newest damage, a player's included, shows in every HP entry as "Use 9".
  - For a creature a player plays, the DM's "Ask Bree to roll" switch starts on and asks its player for saves and checks.
  - A creature with no stat block, or a character whose numbers go only to the DM and its own players, still lists its saves, checks, skills and Initiative, with no bonus shown: a tap that asks its player needs nothing, and a roll made here takes a bonus typed above them ("STR d20", then "STR d20+3"), never an unknown +0.
  - A player's save spell or save action has **Ask for saves**, which opens a short block under its row: the save and DC, who it hits (the creatures selected, or everyone the player sees in an area placed from it, such as "In area (2): Goblin 1, Bree (ally)"), the casting level, and **Roll 9d6 Fire and ask**, which rolls the damage on the player's own dice in the same tap, or **Ask, the DM rolls**.
  - The ask waits on the row, "Asked the DM for saves. Waiting.", with Withdraw, until the DM resolves it ("The DM resolved Fireball.") or sets it aside. A player has at most 3 asks waiting, and a room 20. Other players never learn of an ask, and a creature the player can't see never enters one.
  - Every roll there has the one-roll options, except Recharge and a save or check that asks the player.
  - Layout: A button's words wrap inside it, and a row's buttons share each line. Saves and checks are three across.
- Skill check buttons keep each name and bonus on one line, including Animal Handling. Their equal columns widen or fall to one column as the panel narrows or the interface size grows.
- **Recharge and X/Day in the Dice panel**: a recharge action's row has **Used**, the same mark as the creature's Uses, and **Recharge**, which rolls 1d6 on the server and settles the turn's recharge card.
  - Its Damage, Group save, a group save's Apply and a player's Ask for saves mark it used, and only while it shows ready, so they never draw a refusal.
  - An X/Day action's row reads "2/Day, 1 left" with **Use**, the only thing that spends a use, so a reroll never does. A Legendary Action rolled there spends none. A Use that fails says why on its row, and a tap on Use with none left says "No uses left" there and spends nothing.
  - Damage rolls keep each amount with its type through the HP entry's Use chip and the group save. Only types that deal damage after defenses count for Regeneration. Editing a chip's total clears its typed breakdown.
  - Recharge has no one-roll options, since its one roll has nothing to choose.
- **Critical Hits**: an attack's Critical, which a natural 20 (or a wider critical range) presses on its own, rolls every damage die of the hit, riders such as Sneak Attack included, by the room setting "Critical Hit damage" (Room settings, Combat): Roll the dice twice (2d6+3 crits as 4d6+3, the 2024 rule and the default), Max plus a roll (12 + 2d6 + 3), Double the dice rolled ((2d6 × 2) + 3) or Double the total ((2d6 + 3) × 2).
  - One rule for monsters and characters alike, applied by the server.
  - The roll shows how it was reached: in the log and Recent rolls ("12 max + 2d6+3 (4, 6) = 25"), and at the top of the Dice panel and in its toast ("25 (12 max + 13)").
  - Saves never crit.
- **Several creatures** (DM): a card with up to three of their pictures, "3 selected" and their names, holding a DC, Initiative for the ones in the fight and Set up a group save.
  - Under it, Saves and checks, Skills and Shared attacks fold as a creature's groups do, each kept on this device.
  - A save's button reads "DEX" under the label "Saves for 3", one line at every size, and is still named "DEX save for 3". One tap rolls a save or check for all.
  - A shared attack rolls with each creature's own bonus against an AC, then "Roll damage for 2 hits" rolls the hits' damage. A line under it names what bears on its rolls, such as "Dis: Strong wind" for three Shortbows, and their reminders.
  - Folding Shared attacks, or selecting other creatures while two or more stay selected and still share the attack, keeps the hits and the damage button, and a folded group names the hits that wait ("Scimitar: 2 hits"). Fewer than two selected clears them, and so does a selection that no longer shares the attack, even one made with the Dice sheet closed.
  - A group save left open shows as a notice above the card, "Fire Breath's save: set up.", with Open.
  - A save, a check or a shared attack's one-roll options apply to the dice the server rolls in that tap, never to an asked player's later answer, and say so. Roll damage's one-roll options offer Roll secretly, as any roll with no d20 does.
  - Initiative for the ones in the fight keeps its dice secret.
- **The group save** (DM): starting one while another is open asks "Discard the Dexterity save for 6?" (or "Discard Fireball's save?" once the page has a name, or "Discard the damage for 1?" for a damage-only page), which scrolls into view with **Keep it** focused so a second Enter never discards.
  - Monsters rolled at once, players' creatures asked with the DM's roll one tap away (with a bonus the DM types for one with no stat block), a creature with no stat block rolled on the server with a bonus the DM types ("Server d20+3") or typed, pass or fail against a DC, damage rolled once and kept by type, full or half, conditions on a fail with their end, resistances, immunities, Evasion, Magic and Legendary Resistance on each row, every row changeable, with typed damage or a final plain number as its damage override, one Apply and one undo, which opens the page again for a new DC or fresh rolls (see Undo and Redo under DM tools).
  - A typed row override applies defenses without applying the save or Evasion again. Back to the worked-out amount restores the shared damage and save choices.
  - Until the roll its creatures follow the selection, so a save action's Group save fills with the creatures selected after it.
  - Monsters' rolls the DM shows to players carry the DC only with "Players see the DC" on, and a save-ends or Concentration roll in the open never shows its DC. Those switches fold into one "Player view" line that says what they are, as on the request sheet, and the damage field is labelled Damage.
  - It stays on the DM's device through a reload, and an Apply whose answer was lost is never sent again unless the DM says so.
  - While the room is offline or the DM is on another scene, its rows stay as they are, with their rolls and Ask again waiting and saying why, and a total being typed as it drops is kept for Apply.
  - A player's ask for saves comes as a card above the live cards, "Thorn asks for saves: Fireball, level 4", with the player's roll ("Thorn rolled 31 Fire") and the area's count, hidden creatures included, or the targets, with Open and Dismiss. It counts among the newest two on a phone and leads the alerts summary over a sheet.
  - Open fills the group save from the caster's stat block as the DM sees it, at the asked level, whose Slot level stepper changes it, with the player's roll as the page's damage, and an ask on another scene reads "Go to Crypt and open". Apply resolves the ask in the same step, and where nothing would change it reads Close the ask. Discard leaves the ask waiting, and Dismiss sets it aside for good.
  - An ask withdrawn or set aside while the page is open leaves a plain group save, and one resolved on another device stops Apply, so a spell never lands twice.
  - Its Roll and its damage's Roll have the one-roll options. While the page waits for a check, or is offline, every control on it and in its open roll menus draws off, as a disabled control does, and the menu's choices do nothing. A pick never moves the page's Secret switch, except on a page the pick opened from Several creatures, whose switch starts as the dice it sent.
  - A player's spell's damage stays public, with no options.
- **Roll saves and damage**: with dice in the group save's Damage field, one press rolls the saves and the damage ("Roll 3 saves and damage", "Roll 3 saves, ask 2 players and roll damage", or "Ask 2 players and roll damage"). A refused one keeps the DC.

## Rolls

The DM asks players for a saving throw or an ability check, and each player rolls it in the app or types the total they rolled.

- "Request a roll" is in the action bar of several selected creatures that players play. For one creature, the bar's Roll opens its options, whose "Ask Bree to roll" switch asks its player. "Ask the party" is in the party bar, shortened to "Ask" while the bar is folded.
- **Recent DCs** (DM): for a save, the DCs this device sent last stand beside the DC field under **Recent**, as "DC 15", and a tap fills the field. They are kept for each room, lowest first, and never offered for a check, which keeps the typical DCs. The group save offers the same ones, on a line of their own under its DC field.
- One tap picks the roll: a save or a check by ability, or a skill from a list, which starts at its usual ability and can go with another. Nothing is picked until the DM picks it, and a later tap replaces the whole roll. "Or a second choice" lets the creature pick between two, such as "Strength (Athletics) or Dexterity (Acrobatics)". Either can be removed.
- The DC, or none, on one row with the typical DCs for a check as chips from 5 (Very easy) to 30 (Nearly impossible).
- Creatures, as chips. "Ask the party" starts with the characters on the players' scene picked, or every character when the DM is looking at another scene.
- Player view (the DC, and pass or fail), "Against a spell" for a save, and a note such as "against the poison" fold into one line that says what they are. Both switches start as the DM's last request from that device had them, else on. With the DC hidden and pass or fail shown, a typed answer is final once it passes or fails, so changing the total cannot find the DC. The DM can reopen it.
- The last three requests from that device are one tap each, with their DC, switches and note. Enter in the DC field or the note sends. If the server refuses the request, the sheet stays open with everything set and the reason. Closing the sheet while the request is sending does not stop it, and a refusal that comes after shows as a message.
- The player's device shows a card, with a vibration on Android or the turn chime. It asks the question with its DC or "DC hidden", and shows reminders from the creature's conditions and statuses, such as Restrained's Disadvantage on Dexterity saves or an Exhaustion penalty. With two choices each names its bonus where the app knows it, and the higher one starts picked.
- While the creature waits, Roll rolls on the server with its bonus ("Roll +3"), or with a bonus the player types when the app knows none ("Roll d20", then "Roll d20+5"), with "Add a stat block" for a character that has none, shown only to the DM and the character's own players.
  - Conditions such as Restrained, Bless or Magic Resistance against a spell apply as in the Dice panel, the player can add Advantage, Disadvantage or extra dice such as +1d4, and a line under Roll says how it will roll, or that they cancel.
  - A condition that fails the save, such as Stunned on a Dexterity save, offers "Fail (Stunned)" first, and a roll made anyway records Fail with its total.
  - Rolling needs a connection.
  - Its one-roll options roll with Advantage or Disadvantage, with the choice, the bonus typed and the extra dice, and keep the request's visibility. They never offer Roll normally, even with the card's own Advantage or Disadvantage pressed, since that chip is the way back.
- A rolled result shows in the card, with its dice, a dropped die struck through, and a natural 20 or 1, until Done, then in the chip: "DEX save: rolled 17 (1d20+5: 12). Pass. Final."
  - A rolled answer is final. The player can ask the DM, from the card or its chip, to reroll one die (Heroic Inspiration, the d20 or any other die such as Bless's d4, or Halfling Luck on a 1), to add Advantage (Lucky) or to add a Bardic Inspiration die, and can withdraw the ask.
  - A typed total that is final, with the DC hidden, can be fixed the same way with "Fix my total", whose Allow lets the player type it again but not roll.
- Or the player types the total and taps Send, and once a total is sent, Roll is gone.
  - A save also offers "Fail without rolling".
  - With "Players may type their roll totals" off in Room settings, under Players (on by default, rooms from before it included), every card a player answers offers Roll alone, with "Fail without rolling" on a save, no Total and no "Fix my total", and the server refuses a typed answer. Their Initiative is rolled too, never typed. A typed answer already in stands, and the DM's own rolls and totals are unaffected.
  - A refusal, such as rolling too fast, shows under the card's rows in the server's words.
  - A typed total folds the card into a chip, such as "DEX save: sent 17. Pass." (with two choices it names the one rolled: "STR or DEX save: sent DEX 15. Pass."), which opens again to change the answer while the request is open. A card can also fold away to answer later.
  - On a phone the chips fold into one button while a sheet covers the map, and otherwise only the newest two show, with a "Rolls" button that counts the answers (such as "Rolls 1/3"), shows the rest and folds them again.
  - A card that would cover an open sheet on a phone folds too, into a "Roll asked" button that closes the sheet and opens the card again, with any total typed into it kept. A card at a phone's foot folds the same way while a popover of the tool's options is open, such as Shape or the spell results, and comes back when the popover closes.
  - Where the screen is too short for the card's question, Later and total, or for both it and the bar, the card folds, and a "Roll asked" row at the top of the map stands for it. Its tap, like a chip's, hides the bar, keeping the token or group selected, and opens the card over the tool's options, rising to the screen's top where it needs the room, with its question, Later, total and Send in reach at once, until it is answered or put off with Later.
  - Layout: On a phone a card at the screen's foot stands on the tool's options, such as the Multi-select bar, and the token's action bar keeps above it.
- The DM's live card counts passes and fails ("2 of 3 answered: 1 pass, 1 fail") and shows each creature waiting, or how it answered: "rolled 17 (1d20+5: 12)" with its dice, a natural 20 or 1 and a condition that failed it, or "typed 17", with the choice first when there were two, and an answer it replaced.
  - A waiting creature whose bonus the DM's view knows has a Roll, such as "Roll +5, Disadvantage (Restrained)", and one with no stat block a Roll with a bonus the DM types beside it ("Roll d20+3"), which never replaces an answer that came first: "Thorn answered before your roll." A waiting creature's Roll has the same one-roll options, and still never replaces an answer that came first.
  - Pass and Fail mark a roll with no DC, or overrule one, and the mark is kept apart from what the DC says.
  - A player's ask shows on its row, "Asks to reroll (Heroic Inspiration)", with Allow, which rolls the change on the server, and Keep, one tap each. A card with an ask opens on a computer, names the ask on its folded line on a phone, and leads the alerts summary over a sheet.
  - A request a save-ends card sent stays folded to its one line while that card is up, so its Allow and Keep show once, on the save-ends card.
  - Closing a request keeps any ask, and "Close all answered" leaves a request with an ask open. "Reopen for one more answer", Close, and "Close all answered", which shows while two or more cards are up, finish it.
  - On a phone the DM's cards start folded to one line, only the newest two show, with a "Rolls" button (such as "Rolls 1/3") for the rest, and all of them fold into one button while a sheet covers the map.
- Only the DM and the creature's player see an answer, and its log line. With pass or fail hidden, a Pass or Fail mark from the DM adds no line to the player's log, unless it only repeats what the answer already said.
- No card shows on a player's screen while the game is paused.

## Characters and monsters

- Proficiency shows as a border only where dice are rolled, in the words' own color, never the accent's, and nothing for neither.
  - The Dice panel's option buttons draw it on their own border: heavier for proficient, double for expertise.
  - In text that rolls, a roll such as "DEX +5" or "Perception check" gets a thin rounded frame, tinted inside for expertise, and the sticky result's frame is double for expertise.
  - A tooltip and a screen reader say "Proficient" or "Expertise", and a button, chip or card that holds a marked name says it in its name too.
  - It marks the test's name in the Dice panel's options, the sticky result, roll cards and chips, the DM's requests and answers, group saves and Recent rolls.
  - A line that names a test for several creatures, such as a request to two characters, stays plain, and each creature's own row or name carries its mark.
  - Folded Saves and Skills lines only preview, so they draw no frame, tint or border, and a screen reader still hears "proficient" or "expertise" after each name. They stay one line and cut between whole names with "…".
  - A character's Skills line lists the skills it is proficient or expert in, so Jack of All Trades doesn't make it list all 18. A monster's lists the skills its block trains.
  - Results already rolled use the creature's current visible stats. Missing or private stats never produce a guessed mark.
  - Everywhere else, text that is not a roll carries no mark: the text of monster and character stat blocks, a token panel's saves line (in the action bar too), a shape's numbers, the Log and roll toasts.
  - In a monster's or character's stat block, the six ability boxes show a proficient save instead (the rolls they open mark proficient rows with the Dice panel's border, and the block's text stays unmarked): the whole box of that ability is outlined, name, score, modifier and save together, in the same thin rounded line in the text's color, taking no room, and the save's number is not bold. A screen reader hears that save as proficient.
  - A monster's proficient save is any save that is not its bare modifier, as the Dice panel reads it.
  - Skills show through the Skills line's bonuses, with no list of proficiencies, and the character sheet's Skills line doesn't say "(expertise)". Jack of All Trades keeps its wording and no mark.
  - In Wild Shape, the creature's block outlines its own saves, and "Rolls now" gives the numbers the character rolls with.
  - Layout: The border takes no room, so no line, row or grid changes for it. The sticky result is the one exception: its label holds its frame inside, so its words sit 4 px in and its "…" comes a little sooner, in the same row.
- Every token has a light stat card: HP, AC, Speeds (Walk, Fly, Swim, Climb, Burrow), Initiative bonus, Passive Perception, senses, size, creature type and notes. It is not a full character sheet. In Stats, Walk and any other speed that is set have a row each, and for whoever may change the speeds, the rest fold under "Other speeds" with Hovers.
- A player character can have a stat block: level, ability scores, saving throw and skill proficiencies with expertise, Jack of All Trades, Alert, a spellcasting ability, resistances, immunities and vulnerabilities, a critical range for Improved Critical, Evasion, and its weapons, spells and other rolls, with riders such as Sneak Attack or Hunter's Mark on an attack. Modifiers, saves, skills, Initiative, Passive Perception, spell save DC and spell attack follow the scores and the level. Type a total to keep a difference, such as a Cloak of Protection's.
- The DM and the character's players read and edit it. Only they get Add a stat block, Edit, Take a shape and End the shape, so a player lent a token of another character rolls for it but never changes its block. Its numbers stay theirs too: the lent token's player rolls its saves, checks, skills and Initiative as a d20 with a bonus they type, and its row's Roll in the tracker opens the Dice panel for that. Other players and the table display never see it.
- Fill it from pasted text, read as a stat block, or from D&D Beyond with a public character's share link or its JSON.
  - It reads numbers, proficiencies, weapons, spells and class resources, never their text, and lists what to check before anything is saved.
  - Jack of All Trades comes in as its flag when the bard has reached the feature, whatever condition text D&D Beyond gives it, or when any other source gives it with no condition. Class modifiers of features not yet reached are ignored. When the classes are not read whole the flag stays as synced, and a re-sync that turns it on or off says so. Other half proficiencies, such as the Champion's Remarkable Athlete, are not read.
  - Re-sync from D&D Beyond, beside Edit, brings in what changed there since the last sync and keeps what you changed here, such as a Spellcasting ability or a renamed weapon. It lists each kept change with Overwrite, and Overwrite all, and Undo takes a re-sync back (for the DM it is also a step in Setup history).
  - It changes the maximum HP but never brings a character back or puts one down, and never changes the size. It is best effort, since D&D Beyond can change its format.
- A character with a stat block shows it in its token's panel and on its page, right under the name and quick numbers, its six abilities three across with their saves, each proficient save's ability box outlined, its saves in the action bar, and "Stat block" in its tracker row's options.
  - Its Initiative and Passive Perception come from the stat block.
  - Folded, its row says what it holds: "Level 5, PB +3" (or "Level not set"), or the shape it is in, such as "Wild Shape: Brown Bear", and never a count of known forms.
  - A character with none has the same fold, reading "None yet", and, opened, offering "Add a stat block" and "Take a shape".
  - Once the character has known forms, Take a shape reads "4 shapes" ("1 shape") on the fold's row and inside it, named "4 shapes, take a shape" to a screen reader.
- **Roll from a stat block**: where you may roll for its creature, tap one of a stat block's six ability boxes for its rolls: the check, the save, each of its skills, and Initiative under Dexterity, each with the bonus it rolls, a proficient one bordered as in the Dice panel.
  - Tap one to roll it. Hold one, right-click it, or press ContextMenu or Shift+F10 on it for Roll with Advantage, Roll with Disadvantage or Roll secretly, and Escape or Back goes back to the list. A DM's roll for a monster is secret already, so its choices are Advantage and Disadvantage only. A small mark in a box's corner shows it opens.
  - The result shows at the top of the panel, in the Dice panel's result line under the panel's title, with "with Advantage", "with Disadvantage" or "secret" where a choice added one and the line has room. Where the line is short, those words go first, then the dice, and then the roll's name ends in "…", so the total, the name and a verdict such as "Natural 20, Pass" stay.
  - It has no Again and is not a button. It stays, folded block and all, until the panel closes or shows another creature. Later rolls replace it in place.
  - The dice fly from the box into a tray under that line and land on the total 1 s after the answer, as in the Dice panel: any tap or key in the panel shows the result at once, and selecting another token, closing the panel or hiding it mid-throw shows the roll in a toast instead, unless the Dice panel beside it still shows the roll.
  - A screen reader hears the roll once, at the answer, and neither that toast nor the Dice panel's line says it again. Folding the stat block mid-throw shows the result in the line, which stays.
  - Reduced motion draws the dice already landed, and Low power, the Roll animation switch off or no WebGL show the total at once with no dice.
  - An answer to a request names its roll on the line and to a screen reader, as the Dice panel's newest roll does. A roll answers a request that asks for it, writes Initiative into the tracker, and for the DM asks a player's creature while its Ask switch is on. It uses none of the Dice panel's Next roll choices.
  - In Wild Shape the boxes show the creature's block and roll the numbers under "Rolls now". The Skills line, the Initiative line and weapons stay text, and so does a block with no creature behind it, as in the Monsters panel.
  - Layout: The line goes in without moving anything: the panel scrolls by the line's height as it appears, so the box you tapped stays where it was. Its row keeps one height: words such as "This may have happened. Check the log." take at most two lines and end in "…".
- Take a shape on a character's own token: an SRD creature as Wild Shape, where the druid keeps Intelligence, Wisdom, Charisma and proficiencies and each save and skill takes the higher of the two, or as Polymorph, with all of the creature's numbers.
  - A character with no stat block takes all of the creature's numbers in Wild Shape too, and the shape's words point at adding one.
  - The token takes the creature's AC and Speeds, and HP stays the character's.
  - The picker's Druid level (Any, then 2 to 20) keeps only the forms a Druid of that level may take: up to CR 1/4 at levels 2 and 3, CR 1/2 at 4 to 7 and CR 1 from 8, and no Fly Speed before 8.
  - Each device remembers the level or Any last picked for each character. Until one is picked there, it starts at the character's level once the character has known forms and is level 2 or more, and at Any otherwise.
  - Choosing a level turns Beasts only on, a line under the controls states the limit, and the list runs from the highest CR down.
  - One checkbox, on by default, gives the 2024 Temporary HP, the Druid level for Wild Shape and the creature's HP for Polymorph, only where they are more than the character holds. That Druid level is the one picked in Take a shape, or the character's level while none is picked or Any is.
  - End the shape to go back: the character's AC and Speeds return, and what is left of Polymorph's Temporary HP goes, unless Temporary HP from another source replaced them.
- A Druid's known forms: up to 8 Beast forms the character knows for Wild Shape.
  - "Choose known forms" in Take a shape (then "Change") opens a step with the same search, Beasts only and Druid level, where one tap adds or takes out a form, and the known ones stay listed first whatever the filters.
  - They come first in Take a shape, where one tap takes the form as Wild Shape with its Temporary HP, or changes to it in Wild Shape.
  - The Stat block group draws no list of them: the Take a shape button on its row reads the count ("4 shapes", "1 shape") and stays in Wild Shape, so a druid in Wild Shape changes form, or opens Change ("Choose known forms" with none), without ending the shape.
  - In Wild Shape the form the druid is in shows pressed and unavailable, and while shaped the picker offers only Wild Shape. Polymorph or another shape hides the button until End the shape.
  - With a Druid level picked, the count reads against the Beast Shapes table (4 forms at level 2, 6 at 4, 8 at 8), and a form over the level's CR or with a Fly Speed before level 8 is marked but still taken. The rule is shown, never enforced, and replacing a form after a Long Rest is left to the table.
  - The DM and the character's players see the list, and no one else. Choosing known forms is a sheet change, so the DM takes it back in Setup history.
- The DM sees every character's page. A player sees and edits their own character's page. Other players see only the name, conditions and whatever HP the DM allows.
- Player characters belong to the room, so their HP and conditions follow their tokens to every scene. Monster tokens are independent copies.
- "Players see the party's HP" shows every player the exact HP of the other player characters. Off, they see only Healthy, Bloodied or Dying.
- The Characters panel lists the party.
  - With "Players can create their own characters" on, each player can make up to 3 and place their tokens on the players' scene. New rooms start with it on. A room made earlier keeps its own setting, and one stored before the setting existed reads it as off. The DM can still edit, take over or delete the characters players make.
  - A character's row opens its page, named in the panel's header with Back to Characters: its picture, name, level and size and quick numbers, Place a token (or a player's Place my token), then its stat block, then Combat (Hit Points, conditions, Uses, Reaction used while it is in the fight, and rests) and Companions (the list, Add a companion and Stat blocks) open, then Notes, Image, Stats and, for the DM, Players folded, each as this device left it, and Delete at the foot.
  - A player who plays one character opens straight onto its page, until they go back to the list, which then stays until they leave the room or reload the page.
  - New character, Add a companion and a character's stat blocks open as pages too, with Back in the header. The two forms have Cancel at their foot, and a form with something typed in asks "Discard changes?" before Back or Cancel throws it away.
- A player can delete a character only they play, whoever made it and whether or not players can create characters, at any time, mid-fight included.
  - Every token of it on every map, its companions and its place in the fight go with it, as when the DM deletes it.
  - It cannot be undone, so the page says first what goes, counting only what the player can see and naming the rest in general words, and Delete asks for a second tap. A screen reader hears the same as Delete's description.
  - The DM's log says who deleted what, such as "Pat deleted Bree, with 2 tokens and its place in the fight."
  - A character the player shares with someone else stays the DM's to delete, and its page says so.
- **Class resources**: a character's counted features, such as Rage, Channel Divinity or Lay on Hands, at most 12.
  - Add picks them by class and class level from the 29 SRD 5.2.1 presets, with their counts filled (Natural Recovery is two, its free spell and its spell slots, each back on a Long Rest of its own), a subclass's left unticked, and a count from a modifier read from the stat block or typed, or takes one of your own, with a count or an amount and the rest that brings it back.
  - They are listed in Uses, in the Combat group of the character's page and its tokens' panels, where each also has Edit (its pencil) and "Add a class resource" follows them, and used and restored there, on the turn card, in the tracker row's Uses and in the action bar's Uses, a pool such as Lay on Hands by an amount you type.
  - A counted resource whose most is 6 or fewer shows its count as the monster rows' pips, at the right end of its name's line, filled for each use left. A larger one, and a pool spent by an amount at any size, such as Lay on Hands, Focus Points or Sorcery Points, shows its words ("25 of 25") at the same place, the right end of its name's line, where pips would stand.
  - When the character's level rises, Uses asks once per class to update the counts, and Edit and Remove change one.
  - Re-sync from D&D Beyond, and the stat block's D&D Beyond import, bring in the class's, species' and feats' limited uses with their counts and rests. A resource added this way takes the uses spent there. For one you already have, the count spent here stays unless you tick D&D Beyond's in the review. Items' charges and spells stay out.
  - The resource name field fits the sheet even on a narrow phone at a larger interface size. Only the DM and the character's players see them.
  - Layout: Like pips, the words drop as one part to the right end of the next line when the line is too narrow, and never break inside the count.
- Short Rest and Long Rest follow the SRD.
  - A Short Rest adds the HP the player rolled on Hit Point Dice, restores one use of each class resource that returns one at a time, such as Rage, all of each that returns on a Short Rest, and the abilities a Short Rest restores.
  - A Long Rest restores all HP, ends Temporary HP, removes one Exhaustion level, and restores legendary uses, spent abilities and every class resource.
  - A chosen rest names the class resources it restores. The DM can rest the whole party at once, and when any of the party has a class resource spent, the rest's card says it also restores every class resource.
- With a clock running, a Long Rest stamps the character with the in-game time it ended, for the DM only, and the DM's Long Rest cards give the earliest next start. Long Rest for the party has a checkbox, Move the clock on 8 hours, ticked each time (see Date and time).
- The Monsters panel (DM) holds all 330 SRD 5.2.1 stat blocks. Search, then drop one on the map with average HP (or a typed number), AC, Speed, size, Initiative and senses. Its place card offers In its lair for a monster whose stat block has a lair (lair counts, lair XP or lair actions).
- Filters like D&D Beyond's: challenge rating, creature type, legendary, has a lair (lair counts, lair XP or lair actions), size, condition and damage immunities, resistances, vulnerabilities, movement, senses and alignment. Or type it in the search: "cr 5", "cr 1-5", "cr 1/2-3", "cr 10-".
- Custom monsters: the DM enters a full stat block from a book the group owns, or uses "Paste a stat block" to read pasted text into the editor. They stay in that room only.
- Full stat blocks on tokens: a monster or NPC token's panel has its stat block right under its name for the DM, with its abilities three across as a character's are, saves, skills, senses, languages, CR, traits, actions, Bonus Actions, Reactions and Legendary Actions, and folds. "Stat block" in the token's action bar or a tracker row's options opens it. Edit opens a room monster in the editor, and an SRD monster offers "Copy to this room's monsters and edit". "Attach a stat block" links a token that has none, and Detach unlinks it.
- A player whose token is an SRD monster, such as a druid's Wild Shape, can read its SRD block, and a companion's players read its block. A room monster's block never reaches players, a companion's included.

## DM tools

- "View as a player" shows the scene as a chosen player can see it, only what they may see, whichever scene the DM is on.
  - It shows "Loading what Ana sees…" until it arrives, also through a wait the server asks for after many loads in a minute, or "Could not load what Ana sees." with Try again, which opens it again, when it cannot load.
  - Besides the DM panel's picker, which reaches a player with no token on the scene, a token a player owns, directly, through its character or as a character's companion, offers it to the DM in its action bar, beside Stat block and Details, and in a row of its own under its token panel's header, after the quick numbers, where a character's page has Place a token, as "View as Ana" with an eye in a frame, or "View as a player" with a list of its owners when several players own it.
  - A player's name too long for its button, up to 80 letters with no space, wraps inside it.
  - In the token panel's Owners group the same eye stands beside each player. Monsters and NPCs no player owns have none, players never see these, only one preview opens at a time, and Exit puts focus back on the button that opened it.
  - Layout: The list of owners opens on the side of the button with more room and stands over the map's notices. Attach and View as each keep their open list above the notices when the other control appears or disappears.
- "Follow me" makes players' maps follow the DM's as they pan and zoom. "Bring everyone here" moves them once. A ping with "Look here" on moves every player's view to that spot.
- "Black out players' screens" for a break or a reveal. Players see only a black screen that says "The DM has paused the game." Meanwhile their devices receive nothing from the game but the X-card. When the game resumes, each player's selected token, its action bar and any HP typed into it and not applied come back as they were.
- **The DM menu**: the DM chip in the top bar opens it, named "DM options", on a computer and a phone alike. The side panel keeps its tab while it works.
  - **Handouts**: "Hide <title>" for each handout showing ("Showing"), then "Show <title>" for this device's last three showings that are not showing now, each with its audience ("to everyone", "to Pat"), then "Show a handout…".
  - A handout shown again goes to the same players it went to, less any who have left the room. One with no one left, or whose image or document was deleted, is not offered, and nothing ever widens an audience.
  - **Show a handout…** opens the same form as the DM panel's Handouts in a dialog, with "From starter packs" under the tiles. A library image comes with the title this device last showed it with, under "This device keeps the title for the next time you show this image."
  - **Players' screens**: "Black out players' screens", "Follow me", then "Bring everyone here", or "Move players here" with "on <scene>" while you look at a scene the players are not on. Follow me stays on another scene, with "only on <scene>", and says it moves nobody there.
  - **Map phase** lists the scene's phases when it has two or more, the showing one checked. **Preview** has "View as <player>" for each player.
  - **Time** and **Now playing** appear in it while their chips are off the bar.
  - A move that warns (fog off, or no party creature that can see) asks first. The item becomes "Move players anyway" or "Show players anyway" with the warning under it, and Cancel puts it back.
  - While the server answers, the item reads "Moving players…" and refuses a second press.
    - A refusal shows in place as "Players not moved." with its reason, and as a toast if the menu has closed.
    - A scene deleted meanwhile says "That scene was deleted."
    - The same words come when the server's answer is lost, as when the room reconnects or a co-DM deletes the scene you look at: a move that did not happen says "Players not moved." with "That scene was deleted." or "They are on <scene>."
- **Players see black** opens the Blackout menu: "End the blackout" ("Players see the map again."), and while you look at a scene the players are not on, "Show players <scene>" ("Moves the players here and ends the blackout in one step.").
  - The reveal is one Undo step. If a co-DM moved the players between its move and its end, the blackout stays on and Undo is refused with "it was changed since".
  - If the move is refused or the players move elsewhere first, the blackout stays on and the menu says "Not shown: the players are on another scene now. The blackout stays on."
  - While the end of the blackout is on its way, Players see black stays on the bar.
- **Undo and Redo, in two histories** ([design](docs/design/design-v1-undo-scope.md)). The DM's changes split by what they do, and each history has its own Undo and Redo, each saying what it took back. A restart of the server clears both, and each keeps 50 steps in each direction, shared by that DM's devices.
  - **Play** is the top bar's **Undo** and **Redo**, with Builder's and Draw's own, and Ctrl+Z and Ctrl+Shift+Z.
    - It takes back what happens at the table and direct edits of the board: damage, healing, death saves, rests, conditions, turns and the fight, moves, facing, size and carrying, taking or ending a shape, doors, fog, drawings, areas, everything the builder paints, placing or removing a token (a saved encounter dropped on the map too), a group save's whole Apply, handouts and secrets shown, switching a scene's prepared phase, moving or setting the clock, and the live controls (moving the table, Follow me and blackout).
    - Disarming or finding a trap is Play, and so is a trap going off.
    - A button's tooltip names its next step, "Undo your last play or board change: moving Goblin 2", and a success says "Undid moving Goblin 2." or "Redid moving Goblin 2."
    - An empty Play history never falls back to Setup, and starting a fight does not change which history a change belongs to.
  - **Setup history** is in the Menu, for the DM only.
    - It takes back saved definitions and configuration: stat blocks and character sheets (known forms, resources and level too), companion stat blocks, library monsters, saved encounters, a scene's settings, map, grid and sight, room settings, journal pages and pins, the handout library, and a trap's name, area and rig, the clock's start, stop, calendar and sharing switch, and creating or deleting any of them.
    - Its sheet shows the next step beside **Undo setup**, then the next redo beside **Redo setup**.
    - After a DM saves in one of these editors the app says "Saved. Undo in Setup history." and a success says "Undid setup: changing Bree's stat block." or "Redid setup: changing Bree's stat block."
    - Each history sheet shows only the result of its own last Undo or Redo. It is not a backup or a list of past versions, and a server restart clears it.
  - **The boundary has two exceptions.** Painting a floor or erasing a wall is Play, though a map is configuration, so a stray stroke is undone at once. The HP section's **Set maximum HP** is Play too, for Aid and Life Drain, while a maximum HP saved inside a character sheet or a stat block is Setup.
    - A change that mixes the two, such as a patch to a token that renames it and moves it, or a grid found with its new shape, is one Setup step whole.
    - Moving a token back restores only its place, facing and size, so an AC or a name fixed since stays fixed.
  - **A recorded change clears only its own history's Redo.** A move leaves Setup's Redo alone, and a Setup save leaves Play's. A change that records no step, such as chat, a roll, a member's name or color, a player's sheet save or one that changed nothing, clears neither. A roll, a chat line and Dismiss, Withdraw or Close the ask stay final.
  - **A step that cannot be taken stays when this DM's own step in the other history is in the way, in both directions.**
    - The sentence names the step to take first: "Undo the play step first: damaging Bree.", "Undo the setup step first: changing Goblin 2's AC." or "Redo the setup step first: changing Bree's stat block.", and when it is buried, "Undo the play steps through damaging Bree first."
    - The step offers **Review step**, which opens that history's sheet (Setup history, or "Play history" for a Play step) with **Retry** and **Discard this step**.
    - Discard asks "Discard this undo step? The game stays as it is.", removes only that step and says "Discarded this step. The game stays as it is."
    - Anything else changed it (a co-DM, a player's answer, an unrecorded change) and the step is dropped with the changed-since reason.
    - A refusal for read-only, quota, replay or rate reasons changes neither history and offers no Discard.
  - **Each press takes the step it showed.** "Play history changed. Check the next change." or "Setup history changed. Check the next change." means another device or DM replaced it, and nothing was taken. A press waits with "Loading undo history…" until the app knows the next step, and the sheet says "Connect to use history." offline. A second tap in one double-click sequence and a held key never take the following step. A page that has not reloaded since the update gets "Reload to use Undo".
  - **Each result is announced once.** The device whose own Undo or Redo wrote a correction says only "Undid moving Goblin 2." and not also "The DM undid moving Goblin 2." Other devices and co-DMs hear the DM's line. A change too large to keep as a step tells only the DM who made it "This change is too large to undo." and never "Saved. Undo in Setup history."
  - **A DM is told once about the split.** Each device shows "Undo now separates play from setup. Earlier undo history was cleared. Setup history is in the menu." once, as a toast with a Setup history button that passes on its own like other toasts, and only within 14 days of the update. Where the browser keeps no site data, the notice shows once for the life of the page.
  - **Forgotten memory does not come back.** An Undo or Redo of either history that would make a player's map forget ground asks first ("Players' remembered map here will be forgotten. Go ahead?", with Forget and undo or Forget and redo, and Cancel), and Cancel or a stale answer keeps the step. Neither history restores what a player already saw, read or forgot.
  - **Players are told what changed for them.** A DM's Undo or Redo writes at most one line to the Log of each player it affected, only for gameplay state they may see (HP, death saves, conditions, shapes, uses, an ability, save or skill, a defense, level, known forms, resources, a companion's stat block) or their own token's place: "The DM undid a play change." or "The DM undid a setup change to Bree."
    - It never carries the DM's own words, a hidden target or a number, a wall, fog, drawing or another token's place sends none, and the DM's Log keeps the exact label.
    - A correction too large for one 8 KiB Log line keeps, in each player's own copy, only the permission checks that fit. If every check kept in a player's copy stops allowing that player to read it, that copy disappears from their Log, even where a check left out would still allow it. Other players' copies are not affected. The DM's own line stays.
  - **Re-sync** stays whole: the DM's re-sync and the dialog's **Undo the re-sync** are Setup, and **Undo setup** after the dialog's Undo puts the sync back, which the top bar's Undo never does. A player's re-sync keeps only the dialog's Undo.
  - **HP Log**: the Undo on an HP line in the Log or the tracker's HP changes takes back that one change, whoever made it, while the creature is still as that change left it. It works when a whole Undo is stale, creates no Redo and no second notice, and does not reverse a condition or another target of the same hit or erase a damage type's note.
  - **An undone group save opens again** (DM, [design](docs/design/design-v1-undo-scope.md) section 5). Only a whole Undo of its Apply does it, from the top bar, Ctrl+Z or the same DM's other device.
    - The page comes back with the rows, results, DC, marks and damage it had just before Apply, says "Outcome undone. Change the DC, roll again, or apply again." and rolls or sends nothing on its own. A new DC judges the kept totals again and leaves the DM's own marks.
    - **Roll saves again**, a row's **Roll again** or **Ask again** (passed rows too) and the damage's **Roll again** roll fresh dice or send a fresh request, "Fireball: save again", and the first results stay in the Log with their DC.
    - **Start over** (it asks first) is for a different test, targets or source: the page keeps the creatures its Apply named, so a token that now stands for another creature is left out. Apply again makes a new Apply with its own Undo, which reopens that version.
    - **Partial corrections leave it locked.** Taking back one HP line from the Log, a refused whole Undo or setting HP back by hand never reopens the page. Correct what is left yourself, or start a new group save.
    - **An Apply that changes no HP still counts.** When 2 fire, halved on a pass and resisted, comes to 0, the button keeps its words "Nothing to apply", yet pressing it applies the save: it writes the HP line, records one Undo step and can be reopened like any other. Undo and Redo of it change no creature and tell players nothing.
    - **Redo locks it again** on the choices it applied: "Outcome restored. Undo it before changing this save." Edits made while it was open, or while its status was being checked, are kept apart, and after the next Undo **Resume your edits** brings them back. Once a server restart has cleared Undo, or nothing is left to undo, the page says "Applied. Start a new group save to change it." instead.
    - **Ask again replaces the old request in one step.** If the player answered that request in the meantime, nothing changes: "Not saved. The roll request changed. Check its answers and ask again.", and the page shows the new answer, on a request another Undo brought back too. The page's own asks and closes record no Undo step and leave both Redos alone. An Apply from a recharge ability spends it in the same step, and Undo gives back only a use that Apply spent.
    - **The page lives on the device that applied it**, through a reload, and "This save can reopen here until this tab closes." says when the browser cannot keep it.
      - Another device sees the HP and any ask or trap card come back, but never invents the page.
      - The server tracks each Apply's state for up to 24 hours, at most 200 per room and 100 KiB, dropping the oldest first.
      - Past that, or with the page's choices lost, Undo can still take the HP back, but the page says "This save's outcome cannot be checked. Start a new group save to continue." and stays locked, even before the server tidies the record away.
      - An Apply this device lost before the server answered, as a reload in between can, says the same and offers **Start over** and **Discard**. A server restart clears Undo history but keeps those states.
      - A device whose clock runs ahead takes the server's time for a new save's record once it has heard from the server, and until then a first Apply more than five minutes ahead says "This device's clock is ahead of the server's. Correct it and apply again."
- **Docs page**: the app lists every written doc at /docs, each with its title and a line on what it covers, for anyone, signed in or not. Home has a quiet "Docs" button after its cards, and the DM guide has an "All docs" button beside Home. For now the list holds the DM guide.
- **DM guide**: the app serves the [DM guide](docs/dm-guide.md) at /docs/dm-guide, for anyone, signed in or not, laid out like a printed guide.
  - Its contents shows Start here cards for the opening sections and a card per numbered part with its numbered sections, and each part opens like a chapter.
  - Procedures read as numbered steps, keys as keycaps, tips and notes as callouts, and screenshots as framed figures with captions.
  - On a wide screen an outline beside the text marks the section you're reading, and on a phone the Contents button opens the same outline as a sheet.
  - A link such as /docs/dm-guide#areas opens on that section. Menu, DM guide opens it in a new tab for the DM and the players.
  - For the DM, the panels it covers (Token, Initiative, Dice, Areas, DM, Scenes, Monsters, Encounters, Characters and Outliner) end in a small Guide link to their section, and the empty Token and Initiative panels link to its quick start.
- The DM panel leads with Handouts, then Players' screens (Follow me, Bring everyone here and Black out), then Preview (View as a player and Party sight), then the player link and the table display.
  - Its sections fold. Handouts and Players' screens start open, and Preview, Player link and Table display start folded on a phone and open from 900 px up. Folded, each says what it holds ("2 showing", "Players on Crypt · Follow me off", "1 display"), and this device remembers each.
  - Join requests stays first and never folds.
  - A PDF upload that waits on the DM opens Handouts until the panel closes, and badges it while folded.
- **Outliner**: a panel listing everything on the scene in view, in groups that fold: Creatures and objects, Map (stamps, labels, pins and lights), Areas, Drawings, Doors, and Traps.
  - Each row says what players get, such as Hidden, Under fog, Out of the party's sight, DM only, or a secret door hidden or found.
  - The search filters as you type.
  - A tap frames the item on the map and picks it: a token opens its action bar, a label or pin its pane, an area the Area tool, a stamp or light the builder in its mode, and a trap its pane with the Trap tool. A drawing, door or window flashes.
- **Party bar**: each player character's portrait, HP with Temporary HP and a bar, AC on the same shield as the tokens', hidden while dead as theirs is, Passive Perception as "PP 13", and up to three conditions. Dying, Stable or Dead replace the HP bar.
  - On a phone it is the Party panel.
  - A long name ends in "…" and its HP stays in view.
  - A tap jumps to that character's token and opens its action bar, and a character with no token on the scene in view reads "Not on this scene" and draws off, its HP and AC still shown.
  - Layout: On a wide screen it sits above the side panel's tabs, hides with the panel, draws with the panel once the room has loaded, so the panel never moves down under it, and folds to one line: the names and HP, which scroll sideways when they don't all fit (with a mouse the wheel scrolls them, and Tab reaches each one), and Ask, short for Ask the party.

## Date and time ([design](docs/design/design-v1-calendar.md))

- **Time** and **Sound** are panels of their own under Run the table, in this order: DM, Scenes, Sound, Time.
  - Sound comes first so it stays among the side panel's tabs at 640 px, with Time in More.
  - Players get Time while the DM shares the clock and Sound while something plays that they hear, and one left open stays listed until they close it, saying "The DM isn't sharing the date and time now." or "Nothing is playing.".
  - An older stored or reopened Ambiance opens Sound, and Time over Sound, or Sound over Time, opens as it was.
- **Time** is the panel for the in-game date and time.
  - Everyone sees it, with the part of the day (Dawn, Morning, Afternoon, Dusk or Night), while the DM shares it.
  - The clock is off until the DM starts it, and it never runs on its own: it moves when the DM moves it, when the party takes a Long Rest with the clock box ticked, and when a fight ends.
  - Time's step buttons, 10 minutes, 1 hour, 8 hours, To dawn and Other amount…, are one size.
  - After you start the clock, focus moves to the new date and the panel scrolls to show it.
- **Start the clock**: the DM picks a calendar, the date it is now and whether players see it, then presses Start the clock. Nothing is sent before that, so a hidden clock never reaches a player, its start line included.
- The DM starts the clock from Time (Day count or their own Months calendar), moves it on 10 minutes, 1 hour, 8 hours, to dawn or any amount (Other amount, in minutes, hours or days, up to 100 years), sets the date and time, and chooses whether players see it.
  - There is no negative step: **Set the date and time** sets it back.
  - Set sends nothing unless the DM changed a field, and a date changed alone keeps the clock's seconds, such as a fight's.
  - A month moved elsewhere while Set is open stays picked, and one removed or renamed while Set or Today names it reads "Pick a month", which Set says under the field.
  - Cancel or Escape with changes asks "Discard changes?", and a screen reader hears "Throw away your changes?".
  - A step that would take the clock past about 317,000 years is refused with "The clock can't go that far."
- **Calendars**: **Day count** reads "Day 4" and on.
  - **Months** has up to 24 named months of 1 to 400 days (a year of at most 1,000 days), an optional week of up to 14 named days and words after the year, such as an era's initials. It reads "Tuesday, Deepwinter 3, 1204 AF", and a 1-day month, such as a festival day, reads by its name alone.
  - The app ships no calendar. There are no leap days.
  - Day count names days from 1 ("Pick a day from 1.").
  - Changing the calendar writes no line unless the date changes. The Calendar dialog's Today fields read the clock's moment through the new calendar, and Save moves the clock only when the DM edited Today or changed the kind. Changing the kind starts Today again from the first day.
  - A calendar picked before the clock starts is kept as a draft on the start form, and saving it again keeps the date chosen there.
- **Stop the clock** takes a second tap. It removes the date and time for everyone, and Undo setup in Setup history brings them back. A new clock forgets every Long Rest stamp of the old one.
- A chip in the top bar shows the date and time ("Day 4, 6:00 AM") from 900 px up. Tap it to open Time. It leaves the bar first when the bar runs out of room, and comes back when the window widens or the date gets shorter.
- **The clock chip opens its steps** for the DM, from 900 px up: the date line, "10 minutes", "1 hour", "8 hours", "To dawn" and "Open Time". It stays open for another step, and the side panel keeps its tab. A player's clock chip still opens Time. On a phone, the DM menu's Time item opens the same steps as a sheet.
- **The Log**: each change writes a line, such as "8 hours pass. It is now Day 4, 6:00 AM.", "8 hours pass in a Long Rest. It is now Day 4, 6:00 AM.", "The DM starts the clock: Day 1, 8:00 AM." or "The DM sets the date and time: Tuesday, Deepwinter 3, 1204 AF, 6:00 AM." Each line keeps the date as it read then, so renaming a month later changes no old line. A fight's seconds, a calendar save that kept the date, the sharing switch and Stop write no line.
- **Undo and Redo**: a step is a Play step, and Set too. Starting, stopping, the calendar and the sharing switch are Setup. The DM's Undo or Redo of a clock change writes a line, such as "The DM undid a clock change. It is now Day 3, 10:00 PM." Undoing the end of a fight writes none, and so does undoing a change that left the clock's own time alone, such as a round's Next or a month's new name.
- If the DM changes the calendar and then moves the clock, Undo setup refuses to take the calendar back ("Undo the play step first"), since one guard covers the whole clock. Undoing the step first lets it, or the DM opens Calendar and changes it back by hand. The other way round, a calendar save keeps an earlier step from being undone, and Set puts the time right.
- **Fights**: a fight adds 6 seconds a round to the clock when it ends, the round it ended in counted whole.
  - While it runs, the panel, the chip and every line read the time with the rounds so far added, so a minute shows after 10 rounds.
  - A fight that never started (no Start, still round 1) adds nothing.
  - A clock started or set mid-fight reads the time the DM typed.
  - A fight that would take the clock past its limit stops it there and ends anyway.
- **Rests**: Long Rest for the party has a checkbox, Move the clock on 8 hours, ticked each time.
  - It moves the clock first, then rests everyone, and one Undo takes it all back while it stays one step (another change between its parts splits it). A Long Rest of one character never moves the clock.
  - Each character's last Long Rest is stamped with the in-game time it ended, which only the DM sees.
  - The DM's Long Rest cards, the party's and one character's, say when each character last finished one and the earliest next start the rules give, 16 hours later: "Bree finished a Long Rest at Day 4, 6:00 AM. The next can start from Day 4, 10:00 PM."
    - Characters with the same stamp share one sentence ("Bree and Thorn finished a Long Rest at Midwinter, 5:00 PM. The next can start from Thaw 1, 9:00 AM."), and a date drops its weekday and year when its year is the clock's current one.
  - The note shows until that start, or 8 hours past it for a rest that does not move the clock, which began about 8 hours before it was recorded. It is a note, never a block.
- **Players**: while the DM shares the clock, players get the Time panel (date, time and part of the day, nothing else), the chip from 900 px up, the lines in the Log and a toast for each clock change while neither the Log nor Time is on screen, except on the device that made it.
  - With **Players see the date and time** off, or no clock, players receive no date, time, clock lines or rest times, and Time is not listed for them. Lines they already got stay in their Log, after a reload too.
  - A player whose Time is open when sharing stops keeps it, reading "The DM isn't sharing the date and time now.", until they close it.
  - Behind a blackout players and the table display get no clock and no clock lines either, as with the fight, and get both back when it ends, with the fight's seconds counted.
  - A line written while shared reaches them then even if sharing went off in between.
- **Journal**: **Add the date**, beside Add a secret while a clock runs, adds a heading with the date and time, such as `### Day 4, 6:00 AM`.
- A clock and its stamps are carried by a room's export, its backup and its import.
- The table display shows no date or time yet. Spells that run out as the clock moves, and scene light that follows the time of day, are not built yet.

## Journal and map pins

- The Journal panel holds pages in folders. The DM writes them, and picks who can read each one: DM only, Everyone, or one player.
- Pages use Markdown: bold, italic, headings, lists, numbered lists, quotes and https links.
- A page is made of blocks, and any block can be a secret. Players don't see a secret until the DM taps Reveal on it, and Hide takes it back. Revealed secrets read as ordinary text.
- **Add the date**, beside Add a secret while the room has a clock, adds a heading with the date and time (see Date and time).
- When a page a player can read is new or changes, the Journal button shows a dot and the page reads "New" or "Updated".
- **Map pins**: the Pin tool (DM) places a pin with a tap. Its pane sets a label, a linked page, a color and "DM only", and says who will see the pin. If the server refuses a change, the pane keeps it and says why. Tap a pin to open its pane, or drag it to move it. A page's "Pin to the map" places a pin linked to that page.
- Players see a pin only on their scene, out of the fog, and when they can read its linked page. Deleting a page makes its pins DM only.
- With the Select tool, a tap on a pin opens its page, or shows its label when it links none, until a few seconds pass or the next tap elsewhere on the map.
- A room holds up to 200 pages, and a scene up to 200 pins.

## Log, chat and handouts

- The Log holds chat and the important events: HP changes, conditions and turns. Turn-end area reminders and save-ends lines show before the next creature's turn line, including reminders only the DM sees.
- Whisper to the DM or to one player. Only the sender and the recipients see a whisper.
- While the Log is closed, its button counts new messages, and a whisper to you shows a short notice.
- The Log shows its newest lines, and Show older brings back the rest, a room brought in from a backup included, which keeps its log in the order it was played, the DM's lines and each player's among the rest.
  - The room keeps every line of its log for as long as the room exists. A room that lost its oldest lines to the old limit of 10,000 keeps what was left.
  - Each person's whispers, the lines only some players read, such as a roll's answer, and the DM's own notes keep a count of their own, so a whisper between others, or a line someone else's creature or only the DM gets, never pushes a line out of anyone else's Log.
  - A line written while the table is paused that no player could see stays the DM's when play resumes.
  - Older HP lines offer Undo while the room still keeps what is needed to take them back. An older page left open loses Undo as those records expire.
- Paging back, the Log holds at most 500 lines at once, so a phone stays quick.
  - Past that its newest lines give way, and **Show newer** and **Back to latest** under the list bring them back. A message sent from there goes back to the latest too.
  - A page the server is busy with for a moment is asked for again once before the Log says "Could not load older messages."
  - For players and View as a player, pausing or resuming clears loaded history and drops pages still on their way. The DM's own history stays.
- **Export** in the Log saves it as a Markdown file, one evening or all of it.
  - A gap of more than 4 hours starts a new evening. The newest 25 evenings show first, and **Older sessions** lists 25 more.
  - Everyone can export, and the file holds only what that person's Log shows.
  - On a phone or tablet that can share files, the made file offers **Save or share**, which opens the share sheet, beside **Download**: the share sheet needs that tap of its own.
  - A file over 8 MiB says "This file is large. Use Download to save it.", and **Download** saves it through the browser instead, which counts as another export.
  - Listing the evenings, each Older sessions and each export or download count toward 10 an hour per person.
- **Handouts** (DM panel): show an image to everyone or to chosen players as a popup.
  - It pops up for the players in the room when the DM shows it, or shows it again. A player who joins, or opens the room in a new tab, finds the handouts already showing in the Library instead.
  - A handout can also be a PDF: Upload a file in Show a handout takes an image or a PDF, and "From starter packs" there offers 200 openly licensed pictures to show: the Illustrated Bestiary's monsters, the portrait packs, and Historical art's people, creatures, places, items and documents, each copied into the room with its credit.
  - The DM chooses which pages, up to 100, and the DM's browser turns them into pages, showing its progress in the DM panel, and names the handout after the PDF's title or file name.
  - A PDF with a password or an XFA form is refused, and nothing inside a PDF runs.
  - Players scroll it like a PDF, page with the Previous page and Next page buttons or Page Up, Page Down, Space, Home and End, and zoom over the whole document, down to a whole page. Download saves a handout of several pages as a PDF.
  - A tap on a handout's picture under Showing now opens it for the DM as the players see it.
  - Players can zoom in with a pinch, a double tap, the wheel, the zoom buttons or the + and − keys. On a handout of several pages the wheel scrolls through them, and Ctrl with the wheel, or a trackpad's pinch, zooms. Zooming uses the whole popup.
  - On a tablet or a computer the popup starts as a card, and zooming in opens it to the whole window, at once with a button, a key or the wheel, or when a pinch ends.
    - A small pinch then settles with the whole picture fitted to the window.
    - Zoom out or Reset zoom, the turning arrow left of the zoom buttons, brings the card back, and Expand opens it to the window without zooming.
  - On a phone it fills the screen from the start.
  - Anyone shown a handout can download it with the popup's Download button, saved under the handout's title. On a phone that can share files, Download opens the share sheet instead, to save the image to Photos or Files or send it on.
  - A closed handout stays closed after a reload, and a reload of the same tab brings back the one that was open. Any handout showing opens again from the Library. Its picture there opens it too, at the page it was left on, and closing it comes back to the Library.
- **Recent handouts** (DM panel, Handouts): under **Recent**, the list "Recent handouts" holds the last five handouts this device showed in this room, newest first, with one button each that names its audience: "Show to everyone", "Show to Pat", "Show to Pat and Ana" or "Show to Pat, Ana and Lee". A document reads "Document" and is shown with its pages as they are now, in their current order.
  - A handout showing now is left out, since the Showing list has it with Hide. A member who left is dropped from the audience, and an entry with no one left, a deleted image or a deleted document is not offered.
  - A re-show is busy until the server answers. A refusal says "It may not have shown. Try again." or "That handout could not be shown." in the row.
  - The list is kept on this device alone, never in the room.

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
- The display shows the players' scene as players see it: the map, the fog, party vision (on a scene where each player sees for themselves, only what creatures that share sight see), tokens, shared areas, drawings, pins (except those linked to a page not every player can read), and pings and rulers. It shows no bars, panels, chat or log, roll requests or Initiative strip, and the room sends it no log lines at all.
- It also shows the pause screen during a blackout, handouts shown to everyone, the X-card, and "Waiting for the DM to choose a scene" when there is none.
- A handout of several pages shows one page at a time, with its page number. The arrow and page keys step through it, and a tap shows Previous page, Next page and Close.
- A tap, a click or any key shows a menu for 5 seconds: Follow the DM, Fit the map, "Show whose turn it is" (off at first), Text size (85% to 130% for the names, chips and badges on the map), Weather (Moving, Still or Off, for this display only), Animated maps (Moving or Still, for this display only), Sound (On or Off, for this display only, and a display waiting for a tap says "Tap or press a key for sound."), View (Follow the scene, Top-down or Isometric, and Turn left and Turn right in Isometric), Full screen, and Leave.
  - The display remembers these choices, its view apart from a member's in the same browser.
  - While the X-card or a one-page handout is open, a tap closes it instead.
- Full screen works on the display as in the room: in Chrome and Edge, Escape still closes the menu or a handout, and holding Escape leaves full screen.
- **Follow the DM** shows the part of the map a DM device shows, scaled to the TV, in whichever view the display shows. A DM in Isometric is followed by the ground under their view, raised ground included. Turn on "Show my view on the table display" on that DM device. It follows only while the DM views the players' scene. Follow me, Bring everyone here and Look here move it too.
- **Fit the map** fits what players can see, the revealed ground and the party's tokens, and fits again when a reveal adds more.
- A display can't move or change anything, and it is not on the player list. A room can have up to 4.
- The DM devices list shows each display with Sign out. Changing the player password signs every display out. Leave, pressed twice on the display, signs it out for good. A display that has not connected for 30 days is signed out. A display shows one room: pairing it with another room, in another tab or window, signs it out of the first, which then says it now shows another room.

## Sound ([design](docs/design/design-v1-music.md), [music player](docs/design/design-v1-music-player.md), [Sound and Time as panels](docs/design/design-v1-sound-layout.md))

Music, background sounds and effects the DM plays for the room, starting within a second or two of each other on every device that plays them, or as soon as a slow connection has loaded them. Once a track or background sound starts, each device plays it straight through, so a slow connection never makes it stutter, and a pause and a resume start every device again from the DM's place. Sound files need the server's switch (Running the server). The five built-in effects work without it.

- **Sound** is a panel under Run the table, after Scenes.
  - The DM and co-DMs always have it. A player has it while the room plays something they hear, and one left open stays until they close it.
  - It has two views, picked by a row at its top named Sound: **Now playing** and **Library**. It opens on Now playing at its top with no search each time it is opened. While it stays open the view and the search stay, through a track's page and a turn across 900 px.
  - With the server's switch off there is no view row, only its line, Effects and On this device.
  - The panel's Guide link, at its foot, serves both views.
- **Now playing** is the player: the music's tile and name, "Tavern night · 3 of 12" (or "One track"), a seek bar (a drag is sent once you let go, and nothing is sent if another DM changes the track while you hold it, a key moves it a second, sent once you stop, and under Repeat one with a crossfade it spans one pass), Shuffle, Previous (the track's start once 3 seconds have played, else the one before), Play or Pause, Skip ("Skip past" the incoming track during a crossfade), Repeat, which steps Repeat all, Repeat one and Repeat off, a Crossfade menu and **Stop the music**.
  - **Stop all sound**, which stops effects too, has its own centered row under them. It shows while music plays or is paused, a background sound plays, or an effect of 10 seconds or more sounds, so a short effect does not move the rows.
  - A line under it says when this device plays no sound. With nothing playing it says "No music is playing. Pick a playlist or a track in Library.", and Library is a link that opens the Library view with focus on its search. With only background sounds playing it still says no music plays.
  - Under the player come Up next, Effects, Table sound, Background, On this device and the storage line.
  - The stop icons are a circle with a square.
- **The Now playing chip** (DM): while music or a background sound plays, the top bar shows a chip with **Pause** or **Play** beside the track's name, or the count of background sounds ("2 background sounds"). It shows only while the room's sound switch is on, and never for a player or in View as a player.
  - The name opens the Sound panel's player with the **Next** line, the music's volume ("Music volume for everyone"), each background sound with its own Stop ("Stop Rain on the cobblestones"), Stop all sound, Crossfade and **Open Sound**, which shows the Sound panel at its top.
  - On a computer the player opens under the chip and the map keeps working, with Crossfade as a row of its four choices (Off, 2 s, 5 s, 10 s). A window under 900 px opens it as a card, and a phone as a sheet over the panel already open. The card and the sheet say "Opening the player…" and "Couldn't open the player." as they load.
  - If playback ends while the player is open, the chip stays as "Now playing, stopped" until the player closes. With nothing playing the chip is not on the bar, and the player says "No music is playing."
  - As the bar fills the chip shrinks to its music icon and then moves into the DM menu, whose **Now playing** opens the same player.
  - Layout: the chip is one 28 px pill with two 44 px tall targets and the name cut past 180 px. The popover's body is 340 px wide and the card 440 px.
- **Effects**: a board of buttons, five built in (Click, Rumble, Crash, Whoosh, Hiss), then the room's effects, each a tap that plays it for everyone and stays pressed while it sounds. Edit, on Background or Effects, turns them into rows that open each sound's page.
- **Table sound** follows Effects: its help says it is what everyone at the table hears, set here for every device, then the volumes (Music, each background sound with its Stop, and Effects, which keep "volume for everyone" in their accessible names), the scene's line as help text ("Goblin cave's sound: Tavern night.", "… has no sound of its own." or "… is silent.", or "Play something first." while nothing plays) over **Use what's playing**, and Players see what is playing. Room sound, under On this device, starts "This device only:".
- **A scene's sound** is set in the scene's settings, **Scene sound**, for the scene in view: Use what's playing saves the music's playlist or track with its repeat, shuffle and crossfade, and the background sounds at their volumes.
  - Use what's playing saves the playlist, never the changes made in Up next.
  - Use silence saves silence, Clear forgets it, and Play it plays it now.
  - Sound keeps Use what's playing, and nothing in Sound only opens another panel: Play it, Use silence and Clear stay in Scenes.
  - Move players there plays it while the players are still there, so another DM's later move wins. A playlist or track already playing keeps playing, at the scene's volumes.
  - Duplicate copies a scene's sound.
- **Players see what is playing**, off at first: players see the names of the music and background sounds playing now. Off, a player's Now playing card shows its tile in one fixed tint and says "Music is playing", over "2 background sounds are playing." Named, the card shows the track's name in a tint from it. Background sounds alone show only their line, with no card.
- **Up next** is a fold under the player, folded at first on every width and remembered on this device after a tap. Folded, it shows the Next line alone ("Next: Road", "Next: this track again" or "Last track"). Open, its summary is the count ("9 tracks · 26 min"). Its content stays mounted while folded, so a drag or a key keeps working across a fold.
- **Up next's list** shows what follows, then, under Repeat all and one, the rest of the cycle ("Then Tavern night plays again from the top:"), and under Repeat off "Then the music ends." and the tracks heard under **Played**.
  - A track moves by its handle, dragged (a tap moves nothing) or with Up, Down, Home and End, and its More plays it now, plays it next or removes it from the queue.
  - An edit applies at once for everyone and records no step. One made during a crossfade acts on the incoming track and ends the outgoing one at once.
  - If another DM plays, skips, jumps or starts a scene before an edit lands, it is refused with "The music changed. Try again.", and a drag the music moves on under ends with nothing moved.
  - The queue holds up to 100 tracks.
- **Library**, the panel's second view, searches music by name, whatever the case and accents, in a row that sticks to the top of the panel while the lists scroll, sorts tracks by Name, Longest first or Shortest first, kept on this device, and lists the playlists, with New playlist, and every track, then Add music… and the storage line.
  - The search stays through a view switch, a track's page and a turn across 900 px.
  - Each row has Play and a More: Play next, Add to queue ("Playing" or "In the queue" where it is), Add to playlist… ("Already in it", full, or a new playlist with the track), Edit playlist or Rename or delete…, which opens the track's page.
  - The row of the track playing, in a playlist or alone, and the row of the playlist playing show Pause instead, which pauses the music as Now playing's Pause does. While it is paused they show Play, which resumes it from where it paused. The button turns the moment it is pressed.
- **The playlist maker** is a pop-up over the panel, a wide dialog on a computer and a tall sheet on a phone, opened from New playlist, a playlist's row, Edit playlist or a track's Add to playlist… with a new playlist, and focus returns to what opened it.
  - It holds a name, Shuffle, Repeat (All, One or Off), Crossfade (Off, 2 s, 5 s or 10 s, 5 s at first), Play, its tracks in order with handles, and a search to add from, beside them on a computer and under Add tracks on a phone. A playlist holds up to 100 tracks.
  - Nothing is saved until Create playlist or Save, which sends only what changed (a track deleted elsewhere is no change), and Play saves first, then plays the playlist as it stands, another DM's changes to the rest included. Save and Create playlist close it.
  - Cancel, the close button, Escape and Android's Back close it at once with no changes, and with changes ask "Throw away your changes?" first and close on a second press.
  - A swipe down and Put away sheet close it with no changes, and with changes spring back and keep the draft, never asking.
  - Delete playlist, at its foot, takes a second tap.
  - A change to a playlist that plays takes effect from its next start.
- **Background**: up to four sounds loop at once, each a toggle starting at 70%. The fifth says to stop one first.
- **Fades**: music fades in over 2 seconds whenever it starts, from a Play, a resume, a Skip or a jump in the player, and fades out over 2 seconds whenever it stops: Stop, Pause, and the end of the last track when nothing follows it (Repeat off). Between tracks the playlist's Crossfade decides, and Off plays them back to back. A background sound fades in over 2 seconds when it starts and out over 2 seconds when it stops. Effects play as they are.
- **A sound's page**: its name, Used as (Music, Background or Effect, each off with its reason when the length does not fit), its length, Listen here, which plays it on this device alone, and Delete on a second tap, which removes its file too.
  - A music track's page is a Sound subpage, Back to Sound, which returns to the view it left with its search.
  - A track that plays or plays next, and a background sound that plays, can't be deleted until stopped or taken out of Up next. A track in the queue can't change use until taken out under Up next. A played or queued track deletes, leaves the queue, and the music plays on.
  - A changed use says which playlists and scenes the sound leaves.
- **Adding sounds**: Add music… (in Library), Add background sounds… and Add effects… each take up to 20 audio files at a time, in any format the browser plays.
  - The DM's browser reads each file, evens its loudness and stores an MP3: a constant bitrate MP3 of 64 to 192 kbps at 44.1 or 48 kHz is copied without its tags, anything else is converted to 128 kbps stereo or 64 kbps mono. Files with 4 or 6 channels are mixed to stereo, other channel counts are refused.
  - Music runs 30 seconds to 15 minutes, background sounds 2 seconds and up, effects up to 30 seconds, 24 MB a file.
  - Each file shows its step and percent with Cancel, and a refusal stays on its row with the reason.
  - A file over 200 MB is refused. Constant bitrate MP3s of 64 to 192 kbps and plain WAVs, each at 44.1 or 48 kHz, are read in pieces at any length. Other files are decoded whole, a 320 kbps, variable bitrate or 32 kHz MP3 included: about 3 minutes of stereo FLAC on a phone or tablet, about 16 on a computer, so a long file of another kind may be too big for a phone and is best added from a computer.
  - The server checks each MP3 frame by frame and never decodes it.
  - Sounds share the room's storage with images, and the storage line, in the panel and in Library, says how much they use.
- Players get only what plays now, the next track 10 to 20 seconds before it starts, and the effects fired, and never the library, the playlists, the order, a scene's sound or an effect's name. Behind a blackout players and displays hear nothing, and an effect fired then stays the DM's.
- Uploading, deleting and playback record no step, and nor do Up next's edits, a seek or Previous. Library edits, playlists, Add to playlist, scene sounds and the names switch are Setup history, and a playlist made or saved in the maker is one step. A change of use that would undo while the sound plays says so ("Stop Rain first. It is playing as background.").
- Room volumes start at 100%. Skip while paused plays the next track, and Skip under Repeat one goes on to the next track.
- Music moves on by itself: the server starts each next track on time for everyone, even when the DM's device is asleep. When no player or DM device has been in the room for 15 minutes, its sound stops. A table display alone does not keep it going.
- A room at its storage limit can still stop, pause and delete sounds and turn volumes down.
- **Media controls**: the lock screen and headset buttons show RaccoonVTT and the room's name, never a track. Pause turns Room sound off on that device, and play turns it on.

## Safety: the X-card

- "X-card" sits at the top of the Menu, for the DM and every player. A tap opens a small card, and a tap on its large X sends it, so a stray tap never does. Once it goes out, the sender's Menu closes, so their screen looks like everyone else's.
- Every device in the room then shows the same calm card, the sender's included: "Someone tapped the X-card. Edit out what just happened, with no questions asked." It shows on table displays too.
- Nothing covers the card. On a member's device, a handout the DM shows while it is up, or one that comes back when a pause ends, waits until the card is dismissed. On a table display the handout opens under the card, and a tap closes the card first.
- A player behind the pause screen still has the X-card there, and the card shows to them as to everyone.
- The DM's card adds "Pause the game", which blacks out the players' screens, and while sound plays "Stop the sound", which stops music, background sounds and effects. It shows for an effect of any length, since it is the DM's safety stop.
- Nothing about a tap is saved, not even in the log, so nobody at the table, the DM included, can tell who sent it.
- A tap within 10 seconds of a card joins that card instead of showing another. Each device can send the X-card up to 6 times an hour.
- The X-card is John Stavropoulos's safety tool, credited on the About page.

## This device

Menu, This device holds settings kept on this device alone. Its sections fold, folded on a phone and open from 900 px up, each showing its value while folded ("100%", "Dark", "Low power off"), and this device remembers each:

- **Interface size**: 85%, 100%, 115% or 130%. It scales the bars, the panels, the names and marks on tokens, and the readings of rulers and drags on the map, and dialogs and panels still fit the screen at every size. The map keeps its own zoom.
- **Theme**: Dark (the default), Light, or Auto, which follows this device's own setting. The map, the fog, the dice tray and the table display stay dark in Light too. A change shows at once, in every page of the app open on this device, the DM guide in another tab included.
- **Full screen**: the room fills the whole screen, where the browser allows it. The switch is not there on an iPhone.
- **Low power**: draws the map at a lower resolution, loads the phone size map, skips small animations, keeps weather and animated maps still, shows rolls without dice and waits for 48 px a square, not 24, to draw Isometric's slabs, frames and steps, to save battery on long sessions. Text on the map looks softer.
- **Weather**: Moving (rain falls, snow drifts and fog rolls, using more battery), Still (shows the weather without moving it) or Off (no weather on this device, though rolls still follow it). Moving at first. Reduced motion and Low power keep it still, and a device that cannot keep up halves the particles, then holds them still until the page reloads, and says so here.
- **Map detail**: Phone size (up to 4096 pixels across, loads faster) or Full size (sharper on a large screen). Folded, it reads "Phone size · Moving · Held still" while something holds animated maps still, as Weather's line does.
- **Animated maps**: Moving (the default, which downloads each map's video) or Still (shows the first frame and downloads no video), shown while the server takes videos. Low power, reduced motion or a video that slowed the device keeps them still, and the help under the row says so.
- **Sounds**: **Room sound** plays the music, background sounds and effects the DM plays, with, while it is on, **Music**, **Background** and **Effects** volumes (80% at first).
  - DM devices and table displays start on. A player's device asks once, the first time there is something to hear: Play here or Not on this device.
  - Only one page of a room plays in each browser. A display wins, and the others say "Another window on this device plays the sound." When the page that plays closes, another page of the room takes the sound over within a second or two, a background tab too.
  - **Turn sound** and **Ping sound** follow.
- **Show others' rolls as they happen**: a toast for each roll someone else makes while the Dice panel is not on screen. On at first.
- **Roll animation**: your own rolls in the Dice panel and from stat blocks throw dice that land on the result in about a second. On at first. Its help says so where Low power or the device keeps the dice from showing.
- **Dice**: eight dice sets for your throws, Ivory (the default), Obsidian, Ruby, Sapphire, Emerald, Amethyst, Gold and Steel, each a d20 showing 20 in its colors and finish. The choice is kept on this device, and nobody else sees it. Off with the Roll animation switch.
- "Show the shortcuts": the keys, and what a key or another mouse button does with a click, a drag or the wheel. With a keyboard, each single key can be changed there for this device.
- **Sheet handle**: the grabber at the top of a phone's sheets that swipe, Ringed tail (the default, a raccoon's banded tail), Bandit mask, Paw beans, Scroll rod, Rune divider or Plain pill, with a preview of the choice under it. Every open sheet takes it at once, and each keeps the room above its header that the design needs. It fills with your color and stretches as you pull, fully at the slow-release point. Reduced motion keeps the color and drops the stretch.
- **Tab row** (a computer, from 900 px): under **Panels that may be tabs**, untick a panel to keep it in More. Every panel starts ticked, so the row is as it was until a panel is unticked. The row holds the ticked panels, as many as fit, and More lists the rest first. The help reads "Pick the panels that may be tabs. The rest stay in More." and folded the section reads "Every panel" or "3 only in More". The DM and a player each have a list for their own panels.
- The view this device shows the map in, Top-down or Isometric, is picked from the top bar's View button (Scenes and maps) and kept on this device for each room.

## Search

Search finds a panel, a setting, an action, a key, or a thing in the room, and either goes there or does it. It is for everyone, and what it finds depends on the role.

- **Opening**: Ctrl+K (Cmd+K on a Mac) opens it from anywhere, also while you type in a one-line field. A Mac's field keeps Ctrl+K for itself, and Cmd+K opens the search.
  - The top bar's **Search** sits after the chips: a field-like button with a magnifier, "Search" and the key, then a 44 px icon as the bar fills. It is named "Search (Ctrl+K)".
  - Below 900 px, and on a phone, the field at the top of the Panels list opens it, reading "Search panels, settings and the room". A phone's top bar shows the icon while it has room.
  - There is no search in View as a player or on a table display.
- **The sheet**: a dialog under the top bar on a computer, and on a phone a sheet over the whole screen with **Cancel**. Escape, Ctrl+K again, a click outside or Cancel close it, and focus goes back where it was. The field says "Search panels, settings, actions, tokens…" for the DM and "Search panels, settings, your character…" for a player.
- **An empty field** lists **Recent**, this device's last five picks for this room and member, then **Suggested**. Suggested follows the moment: in a fight Next turn comes first, else Start a fight, then Show a handout, Black out players' screens, Long Rest for the party and Sound. A player's list starts with their character's page, then Dice and the X-card.
  - A recent pick shows only while it is still there. A token hidden since is not shown.
- **Typed words** give one ranked list of at most 40 rows, the first highlighted. Each row has the kind's icon, the title with the start of each typed word in bold, a second line with the kind and where it lives ("Setting · Menu · Room settings · Combat"), the value where there is one ("Field · Bree: Darkvision 60 ft."), and the key where a key does the same. A DM's hidden token says "Hidden" after its name.
  - Every typed word must match, in any order, so "rest long" finds Long Rest. Case, accents and apostrophes do not matter, and "longrest" finds Long Rest.
  - A word matches a title's words, their starts, the inside of a word from 3 letters, a plural's singular, and a small typo: one slip from 5 typed letters, two from 8. A typo shows only when nothing better matched.
  - Short forms stand for the app's own words: "hp", "init", "conc", "dv", "lr" and about 80 more. Some entries also come first for the words they are meant by, such as "music" for Sound's Now playing and "rest" for Long Rest for the party.
  - Ties go by kind, then by the shorter title, then A to Z. How often you picked a result never reorders a list.
  - "No match for “xyz”." says the same whatever was typed.
- **Going and doing**: a verb does it and a noun goes to it. Up and Down move, **Enter** (or a tap) goes there or does it, and **Shift+Enter** only goes there. The list's keys act from the search field, so Enter on Cancel, Close, Try again or Reload presses that button.
  - A panel, section, setting or field opens at its place, unfolds what holds it for now, focuses the control and rings it for 1.5 seconds. A fold opened this way folds again when its panel closes, and nothing is saved.
  - An action presses the real control, so its confirm, its disabled state and its Undo are the control's own. A control that is off is focused instead, and its help says why.
  - A DM menu item does what the menu does, with its warning, "Moving players…" and refusal shown in the row. An item that opens a dialog closes the search first. The same action found in a panel is the item's twin, and Shift+Enter goes to it.
  - A key runs as the key would. A token is selected, framed on the map and its action bar opened, and Shift+Enter opens its panel. A condition is added to, or taken off, the selected token, and Shift+Enter opens its Conditions.
  - A formula such as 2d6+3 shows a **Roll** row that rolls it as the Dice panel does and opens Dice. Shift+Enter puts it in the Dice field without rolling.
  - A scene, playlist, track, monster, page or handout opens at its place and never moves the map or the players.
- **What it finds**: panels, every key, settings (the room's, the scene's, this device's), actions (Start a fight, Long Rest for the party, Roll dice, Secret roll, Send a message, Whisper to someone, Roll monsters' Initiative and more), the tokens on the scene in view, characters and their fields with their values, the selection's conditions, scenes, monsters, playlists and tracks, journal pages and handouts, and the DM menu's items, with a recent showing as "Show Belak's letter to Pat".
  - A creature's field is listed only where its panel or page shows it, so a player lent a character's token finds its HP and conditions and none of its card.
  - The digits that start an HP change are the row "Change HP", with this device's digits, and it goes to the selected token's HP field.
  - A token's and a character's groups are found too, and land on the group's heading: Position (with Elevation, Facing and Shares sight), Image, Stat block and Companions for anyone who sees them, and Owners and Players for the DM.
  - Row words: Action, Key, Panel, Dice, Field, Token, Character, Condition, Section, Scene, Playlist, Track, Page, Handout, Setting and Monster. A setting's row says "On" or "Off", and a value reads "<n> ft.".
- **What a player can reach**: only what their own screen already holds and what they may do. The DM's settings, actions, scenes, monsters, music and notes are not in a player's list, a token whose name is hidden is found by the name the player sees, and the list shows no count of what is left out.
- **Loading**: everything is on the device, so it works offline. The DM's part loads with the DM's panels. While monsters or the DM's results are not in yet, the list shows the rest and, after about 200 ms, "Loading monsters…" or "Loading the DM's results…". A part that failed says "Some results could not load." with **Try again**, then **Reload**.
  - A polite status reads "No match", "1 result" or "<n> results".
  - Layout: the dialog is 640 px wide, the phone sheet is used below 600 px, and the top bar's field is 240 px.

## Shortcuts

`?` shows the list for your role, and so does Menu, This device, "Show the shortcuts". It lists the keys, then what a key or another mouse button does with a click, a drag or the wheel (on a device with a mouse or trackpad), then the keys that work inside one part of the room. A plain click, tap, drag or pinch is described with its feature above. The tables below list the default keys. On a device with a keyboard, Change in the list gives any single key of the Keys table another letter, digit or symbol, kept on that device alone, and Reset all keys brings the defaults back. A key you gave a shortcut stays yours when a new shortcut comes with that key as its default: the new one shows "No key" until you change it or press its Reset, which takes the key back and returns yours to its default. Each button that does what a key does names its key, as this device has it, on a device with a mouse, a trackpad or a keyboard: in its tooltip, as "Fog (F)", "Undo your last play or board change (Ctrl+Z)", "Change the view (I)", a token's "Hidden (H)" or the handout viewer's "Zoom in (+)", "Zoom out (-)" and "Reset zoom (0)", and in its words where they already name what it does and the key fits, as the View menu's "Turn left (Q)" and "Turn right (E)", This device's "Show the shortcuts (?)" and the outliner's "Search the scene (/)". Where the View button folds into the Menu, its View row names I. A screen reader hears the key apart from the name. A touch screen names no keys until a key is pressed on a keyboard joined to it, and then names them all at once. "View as a player" names none of the room's keys, which it does not answer.

### Keys

On any device with a keyboard. They do nothing while you type in a field or a dialog is open. On a Mac, Cmd works where Ctrl is written.

| Key | Does | Who |
| --- | --- | --- |
| Ctrl+Z | Undo your last play or board change | everyone |
| Ctrl+Shift+Z | Redo your last play or board change | everyone |
| Ctrl+K | Search the room: panels, settings, actions and what is on the map | everyone, also while you type in a field |
| V, R, A, D, P | Select, Ruler, Area, Draw, Ping | everyone (Draw only for players who may draw) |
| T, M, X, F, B, G | Add token, Pin, Trap, Fog, Builder, Grid | DM |
| Arrow keys | Move the selected tokens one square, or one hex on a hex scene. Each press is a move, so walls stop it and it adds to the turn's path | anyone, on tokens they may move |
| Page Up, Page Down | Raise or lower the selected tokens 5 ft | anyone, on tokens they may change |
| H | Hide or show the selected tokens | DM |
| L | Lock or unlock the selected tokens | DM |
| Delete, Backspace | Delete the selected tokens. Ctrl+Z brings them back | DM |
| 1 to 9 | Start an HP change of the selected tokens with that number. Enter applies it | DM, and anyone on tokens whose HP they may change |
| C | Open the Conditions of the selected tokens | DM, and anyone on tokens they may change |
| N | Next turn, or End turn on your own turn | DM, and players on their turn |
| +, - | Zoom in, zoom out | everyone |
| 0 | Fit the map | everyone |
| I | Switch between top-down and isometric | everyone |
| Q, E | Turn the isometric view left, right | everyone |
| / | Search the scene in the outliner | DM |
| S | Hide or show the side panel, on a screen 900 px or wider | everyone |
| O | Go to the other panel, with two in the side panel | everyone |
| W | Enter or leave full screen, where the browser can | everyone |
| ? | Show the shortcuts | everyone |
| Escape | Close an open pop-up first, then a sheet, else the token's action bar, else let go of the selection and end Multi-select. With focus in the bar's Conditions, close them first, back on their button. While the token's panel shows one token, the bar closes and keeps it. While the panel is open, a group whose bar is hidden stays until Done. A field outside the pop-up keeps its Escape | everyone |
| Ctrl+V (Cmd+V on a Mac) | Use a copied image as a new scene, the selected token's picture, a stamp or a handout | DM, with nothing open that takes it |
| ContextMenu, Shift+F10 | Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before | everyone, on a fight card's focused Roll |
| Up, Down, Home, End | Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on | everyone, in a fight card's roll options |

### Mouse with keys

| Mouse | Does | Who |
| --- | --- | --- |
| Shift or Ctrl+click a token (Cmd on a Mac) | Add it to the selection, or take it out, as Multi-select does | everyone, with the Select tool |
| Shift or Ctrl+drag on empty map (Cmd on a Mac) | Draw a box that adds the tokens in it to the selection | everyone, with the Select tool |
| Right-click a token | Select it alone, whatever the tool. With the Select tool its action bar opens too | everyone, with Multi-select off |
| Alt+drag a token (Option on a Mac) | Place it between squares, where you drop it | everyone, on a square scene, on a token you may move |
| Drag with the right or middle button | Move the map | everyone, with any tool |
| Space+drag | Move the map | everyone, with any tool, while nothing has focus or the map does |
| Ctrl+wheel, or a pinch on a trackpad | Zoom in or out at the pointer, faster than the wheel alone | everyone, with any tool |
| Ctrl+wheel, or a pinch on a trackpad | Zoom the picture or the pages in or out at the pointer, down to a whole page | everyone, in the handout viewer |
| Right-click a roll button | Open its one-roll options, such as Advantage or Secret, without rolling. Right-click it again to close them | everyone |
| Double-click the side panel's edge | Put it back to its default width | everyone |

### Mouse and touch

On any device. A token that carries others, such as a rider's mount or a holder of a torch, drags as a group.

| Drag or tap | Does | Who |
| --- | --- | --- |
| Drag a token that carries others | Move it with what it carries, and what those carry. A press in its middle takes it, even on a small token it carries or one that token carries | everyone, with the Select tool |
| Drag the rider of a controlled mount | Move the mount, the rider riding. So does a drag of a rider that covers its whole mount | everyone, with the Select tool |
| Drag any other carried token | Move it alone, from nearer its holder's edge than its middle. Dropped on its holder, or within 5 ft of the creature dragging it, it stays attached, and anywhere else it comes loose | everyone, with the Select tool |
| Place freely, then drag the token | The same, for one drag | everyone, from the token's bar, on a square scene |
| Tap a standee again | Pick the one behind it, in isometric | everyone |
| Hold a roll button | Open its one-roll options after half a second, without rolling. Tap a choice to roll once that way | everyone |
| Double-tap and hold a roll button with a screen reader | Open its one-roll options. A plain double-tap still rolls | everyone |
| Tap, click, hold or right-click an ability box in a stat block | Open its rolls: the check, the save, its skills, and Initiative under Dexterity. Tap one to roll it | everyone, where you may roll for the creature |
| Hold or right-click a roll in an ability's rolls | Show its one-roll options in their place, without rolling | everyone, in an ability's rolls |
| Double click or tap on Undo or Redo | Take back or restore one step. A second tap in the same double-click sequence never takes the following step | everyone |
| Swipe right in a panel | Go back, as the panel's Back does: to the list of panels, or from a page inside a panel, such as Members, to the panel. Not from something that can still scroll left or drags sideways itself, or from the screen's left edge | everyone, where panels open as sheets, as on a phone |

### Android

| Button | Does | Who |
| --- | --- | --- |
| Back button | Close what opened last, such as a pop-up, a sheet, a dialog, a handout or the action bar | everyone |

### Search

| Key | Does | Who |
| --- | --- | --- |
| Up, Down | Move through the results | everyone |
| Enter | Go there, or do it | everyone |
| Shift+Enter | Only go there | everyone |
| Escape, Ctrl+K | Close it, back where you were | everyone |

### Toolbar

Each tool key picks its tool, also one behind Setup or the tool menu.

| Key | Does | Who |
| --- | --- | --- |
| The tool's key | Show its hidden options and go to its next main choice, such as Area's next shape. With Shift on a letter key, the one before. It never hides them | everyone, for the tool in use |
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

### Side panel width

On a screen 900 px or wider. With the edge focused, the arrow keys resize the panel and never move a token.

| Key | Does | Who |
| --- | --- | --- |
| Left, Right | Widen or narrow the side panel 8 px, or 64 px with Shift | everyone, with its edge focused |
| Home, End | Make it its default width, or its widest | everyone, with its edge focused |
| Escape | Put the edge back where it was | everyone, while you drag it |

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
| Enter | Save the Initiative you typed | everyone, in a row's Initiative box |
| Escape | Drop the Initiative you typed | everyone, in a row's Initiative box |
| Enter | Go to the next box, and save after the last | DM, while typing several values |
| ContextMenu, Shift+F10 | Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before | everyone, on a focused Roll or Auto Initiative |
| Up, Down, Home, End | Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on | everyone, in roll options |

### Music

| Key | Does | Who |
| --- | --- | --- |
| Up, Down | Move the track one place | DM, on a track's handle in Up next or the playlist maker |
| Home, End | Move the track to the first or the last place | DM, on a track's handle in Up next or the playlist maker |
| Escape | Put the track back | DM, while dragging a track |

### Dice

| Key | Does | Who |
| --- | --- | --- |
| Enter | Roll what the field holds | everyone, in the Dice panel's formula field |
| Up, Down | Go back through the formulas this device rolled, newest first, or forward again to what was being typed | everyone, in the formula field |
| Any tap or key | Show the result at once, then do its own job | everyone, in the Dice panel or a stat block's panel while your dice are in the air |
| Enter | Roll the parts, or take the typed numbers | DM, in the group save's damage field |
| Left, Right, Home, End | Pick another creature to roll for | everyone, in the Dice panel's creature tabs |
| ContextMenu, Shift+F10 | Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before | everyone, on a focused roll button |
| Up, Down, Home, End | Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on | everyone, in roll options |

### Roll requests

| Key | Does | Who |
| --- | --- | --- |
| Enter | Send the request | DM, in Request a roll's DC or note field |
| Enter | Send the total you typed | players, in a roll card's Total field |
| Enter | Roll, with the bonus and extra dice you typed | players, in a roll card's Bonus or Extra dice field |
| ContextMenu, Shift+F10 | Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before | everyone, on a request's focused Roll |
| Up, Down, Home, End | Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on | everyone, in roll options |

### Token and character fields

| Key | Does | Who |
| --- | --- | --- |
| Enter | Save the field and leave it | everyone, in a one-line field |
| Escape | Drop what you typed and leave the field | everyone, in a one-line field |
| Enter, Space, Down, ContextMenu, Shift+F10 | Open its rolls, the first one focused | everyone, on a focused ability box |
| Up | Open its rolls, the last one focused | everyone, on a focused ability box |
| ContextMenu, Shift+F10 | Show its one-roll options, the first choice focused. Enter and Space still roll as before | everyone, on a roll in an ability's rolls |
| Escape | From a roll's options, go back to the ability's rolls. From the rolls, close them back on the box | everyone, in an ability's rolls |
| Up, Down, Home, End | Move through the rolls or the choices | everyone, in an ability's rolls |
| ContextMenu, Shift+F10 | Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before | everyone, on a focused Death Save Roll in HP |
| Up, Down, Home, End | Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on | everyone, in roll options |

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
| Page Up, Page Down | In Generate a dungeon, move Heights or Traps to its next or previous mark | DM |

### Images

Choose an image, the stamp picker, New scene's Map image, Show a handout, and a scene's Map image or Add a phase with focus there. In a text field, only a copied image with no text.

| Key | Does | Who |
| --- | --- | --- |
| Ctrl+V (Cmd+V on a Mac) | Paste a copied image there. Choose an image also takes an https link | everyone |

### Setup history

While this sheet has focus, outside text fields. Separate key presses wait for the next step. Held keys do not repeat.

| Key | Does | Who |
| --- | --- | --- |
| Ctrl+Z (Cmd+Z on a Mac) | Undo the next setup step | DM |
| Ctrl+Shift+Z (Cmd+Shift+Z on a Mac) | Redo the next setup step | DM |
| Escape | Close the sheet and return focus to its opener | DM |

## Look and accessibility

- A dark theme by default, and a light one in This device. In a room, buttons take your own member color, adjusted so they stay readable: on a light page the crest's yellow becomes a dark olive gold. The map and everything drawn on it, the pause screen, the dice tray, the table display and the dungeon generator's preview with its Reroll keep the dark look in both.
- Names in a member's color (the Log and Recent rolls) are shifted until they read on the page, in both themes. Member color dots and swatches wear a thin ring so white and yellow still show on a light page. A row of swatches that stands among other rows (Pin color, Your color on the join page, the ask card and Members, and the Icons tab's Disk color) starts on the same edge as they do, with its chosen ring just outside it.
- Controls that float on the map, such as a computer's toolbar buttons and the map's own focus, ring in your accent on a dark halo, so the ring shows over any map art in either theme. As with the other focus rings, it shows after a key press, not after a tap or a click.
- On an iPhone's home-screen app, a light page keeps a black strip under the status bar, so its white text stays readable, over dialogs and sheets that fill the screen too.
- One font everywhere: the app draws its text, the names and numbers on the map included, in Inter, an open font that comes with it, so a row reads and wraps the same on an iPhone, an Android phone, Windows and Linux. Numbers that line up or change in place, such as HP, Initiative, rounds, dice totals, counts and the ruler's reading, keep every digit the same width. Inter is credited on the About page.
- The app's words follow the SRD 5.2.1's style: ability abbreviations in capitals (STR, DEX), and the game's terms capitalized where they name a rule, such as Initiative, Advantage, Hit Points, Short Rest, Critical Hit, Concentration, a Death Saving Throw, a 20 ft Sphere and 8d6 Fire. A modifier reads with a true minus (DEX −1), while a formula keeps the hyphen you type (d20-1). What you type stays as you typed it.
- Large touch targets, 16 px text fields so an iPhone doesn't zoom in, and room for the notch and the home bar.
- Icons with their names on hover and focus: a button that is an icon alone, such as Close, Undo, a trash can for Delete or the arrows that move a row, shows its name beside it after half a second of hover, at once on keyboard focus, and on a touch held half a second, and a screen reader hears its name. The name stays up a moment and a half after the finger lifts, until another name shows, since one shows at a time, and a hold that showed it never also presses the button, while Enter, Space and a screen reader still press it at once. A stepper that repeats while held, as the Height tool's 5 ft lower and 5 ft higher do, is the one exception: it steps from the moment the finger lands. The name sits just above or below its icon at every interface size, never wider than the screen. Where a mouse would learn an icon from its name but a finger cannot hover, as for Hidden, Locked and Duplicate in the token's action bar, a touch screen shows the words beside the icon. In the token's action bar, on a pin, a light or a map label, and in the journal, Delete is a trash can alone until its first tap, then the trash can and its question. In the token's action bar the trash can keeps room for its question beside it, so the second tap lands where the first did on any screen. One icon means one thing everywhere: Hidden from players is an eye struck through, Roll again two looping arrows apart from Redo, and Ping a radar apart from Pin. The Menu's rows wear their icons, and the toolbar keeps its tools' names under their icons. Each panel has an icon of its own, in the side panel's tabs, on More and in its list, on the bar between two panels and in a phone's Panels list. Each group of the Token panel and a character's page starts with an icon before its name, and a folded group's summary gives way first, so the name and a button such as Take a shape keep their line. In a fight, the tracker's and the party bar's condition chips show the same pictures as the map's chips, where a chip shows no number: exhaustion keeps its level, as "E2", and a counted effect such as Hex its letters and count. The turn timer wears a stopwatch, the turn card folds by the chevron before its title and closes by its x, and the time-up line and the line for an effect that ended start with the stopwatch or the effect's picture. A token's panel reads "Hidden" with the eye struck through, its full words "Hidden from players" as the tag's tooltip and for a screen reader, and "Locked" with its padlock. New page, New encounter, New character and Add a companion start with a plus, and a character page's Delete with a trash can. The interface icons come from Lucide, credited on the About page.
- Respects the system's reduced-motion setting.
- In a room, the browser tab reads `RaccoonVTT · <room name>`.
- A click or tap outside a dialog closes it, except a handout or a picture from the Library.
- Take a shape reserves space for classic scrollbars in its creature list, so filtering a short or long list keeps the content at the same width.

## Backups and moving a room

- Room settings, Backup: "Download a backup" saves the whole room as one .zip file, with every scene, token, character, journal page and image, starter picks and their credits included. At most 4 an hour. It holds the Log's newest lines, not all of its history: Export in the Log saves that as text, and the server's nightly backups keep it whole.
- Home, "Import a room": "Import from a backup" makes a new room from that file, on this server or another, up to 95 MB. The server owner can import a bigger one from the command line. A backup whose images are more than a room may store on this server is refused whole, saying so. A room imported from a backup file starts With the password, as a new room does, since Joining is not part of the file.
- A room backup carries its videos, and an import checks each one again. While animated maps are off, an import keeps each map's still image and skips its video. A video counts toward the room's storage. An upload must leave 32 MB of the room's storage free. An import needs only the room's storage.
- A backup carries the room's sounds while Include sounds is on (on at first), which says how much they add. Off, the backup holds no sound file and nothing about sound: no library, playlists or scene sounds. An imported room starts silent, keeps its sounds, playlists and scene sounds, checks each file again, and says how many sounds it left out. While sound files are off, a backup leaves sounds out and an import keeps nothing about sound.

## Running the server

For whoever runs RaccoonVTT. [docs/self-hosting.md](docs/self-hosting.md) has the setup steps, and [docs/operations.md](docs/operations.md) the commands for running it.

- It runs with Docker Compose behind any HTTPS reverse proxy or tunnel, such as Caddy, nginx or Cloudflare Tunnel, with no open ports unless you use the self-host file's `https` profile. An outbound proxy is its only way to the internet, for image search and imports from a link.
- **Published image**: each release is a signed image on Docker Hub for amd64 and arm64 servers. [Verify its signature with Cosign v3 or later](docs/self-hosting.md#verify-the-image). A host needs only `selfhost/compose.yml` and an `.env`, with an optional `https` profile that runs Caddy and gets the certificate on its own.
- **Signed release assets**: each GitHub Release also carries the tag's source archive and an SBOM of its packages, each with a keyless Cosign signature, and their SLSA build provenance. [Verify them with Cosign and the GitHub CLI](docs/releasing.md#verify-a-releases-assets).
- **Animated maps** are off unless the server's environment sets `ANIMATED_MAPS=1`. Read Cloudflare's terms on serving video before you turn them on ([docs/self-hosting.md](docs/self-hosting.md#6-if-you-use-cloudflare)). Off, the server refuses video uploads, serves no video and every map shows its still. While animated maps are off, a scene's existing videos stay for renaming, reordering and removing phases, and Undo still brings one back, but no new video can be added.
- **Sound files** are off unless the server's environment sets `ROOM_SOUND=1` ([docs/self-hosting.md](docs/self-hosting.md#6-if-you-use-cloudflare)). Off, the server refuses sound uploads, serves no sound and refuses ops that name a sound file. The Sound panel says so and keeps its built-in effects.
- Google image search needs a SerpApi key. Openverse needs none. The Turnstile human check is optional.
- The strict egress port also allows `character-service.dndbeyond.com`, for the D&D Beyond import. Removing it from `docker/squid.conf` turns the link import off, and pasted JSON still works.
- **Nightly backups**: every night (at 04:00 by default) a backup copies the database and the images it needs, then checks the copy. It copies each map video too, as a .webm or .mp4 file, and each sound as an .mp3, and a restore puts them back. It keeps the newest 7 good backups and one from each of the last 4 weeks. A run that cannot finish deletes nothing, so the last good backup always remains, and every run leaves 2 GiB free on the disk. One command runs a backup now, and another restores one. The backups live on the same disk as everything else, so copy them off the server now and then.
- **Admin page** at `/admin`, off until the server owner sets an admin password:
  - Storage: the image volume, the database, the images on disk, the images waiting for cleanup, and the last backup and the last good one. It warns when the last backup failed or no good one has run for 36 hours, when the database's disk is near or under its 2 GiB free-space floor, or when one room's log archive has grown past a room's storage quota. The warning names the room with the largest archive.
  - Every room with its size on disk, its whole log included, its images, last activity and whether it is loaded, sorted by last activity or size. A room's storage limit leaves its log out, so a long history never stops uploads or makes a room read-only.
  - Pin or unpin a room (a pinned room is never unloaded to make space), or delete one after typing its room ID.
  - It never shows what is in a room and cannot enter one. A session lasts 12 hours, and repeated wrong passwords close the login for a while.
- **Cleanup of unused images**: once a day the server deletes replaced scene thumbnails, and once a week image files nothing names. Deleted image files wait 48 hours first, so a backup that is running still finds them. Images in a room's library are deleted only by its DM (see Images and art).
- **Admin commands** on the command line list rooms, create a room past the daily limits, pin or unpin a room, replace a lost DM link, import a large room backup, and make the admin password's hash.
- The X-card leaves nothing in the app's data or its logs. The HTTPS front end's own request logs, such as a reverse proxy's access log or Cloudflare's, can still record each request's address, the X-card's included, as they do for every request.
