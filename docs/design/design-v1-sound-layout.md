# raccoon-vtt: Time and Sound as panels, the player in the Sound panel, and a Now playing chip

Status: built (2026-11-06), from design draft 3 at review consensus, in lanes SL-0, SL-A, SL-B, SL-D, SL-E and SL-F (section 11), after design review rounds 1 to 3 (Codex and Claude reviewers, every finding adopted but SL-OPUS-9, "Round 1 dispositions" to "Round 3 notes" at the end). "As built" says where the build went its own way. **The Now playing chip (section 5, SL-C) was built later, in the quicker table's stack** (docs/design/design-v1-qol.md), after the top bar's give-way was decided there, and its spec here held with the changes in that note's As built. Decisions D-261106-086 to 099 (section 13). Code is cited from main `069591ea`. Builds on docs/design/design-v1-panel-groups.md, design-v1-scenes-reorg.md, design-v1-music-player.md, design-v1-panel-size.md and design-v1-calendar.md, each as built, and amends them (section 11). Drafts 1 and 2 were never committed.

## The owner's words

2026-11-06, after using what is deployed:

> couple things just at first glance:
> 1. weather being just a link to the scenes page is a bit jarring. maybe sound and time should just be their own tabs and weather can be kept as a scene? open to ideas
> 2. the full screen music player wasn't exactly what i had in mind. i think most of the configuration and everything should still be in the side panel, but i like the music player itself. additionally, i think there should be some kind of easily accessible way to access the now playing section without the tab open, open to ideas here.
>
> Overally i just want these things to feel intuitive to use and not too weirdly layed out

Then, of the Music window's Now playing column (the tile, the track, "One track", the seek bar, Shuffle, Previous, Pause, Skip, Repeat, Crossfade: 5 s, Stop the music, Up next): "this view itself is really well put together and i think we could just move it into the now playing sidebar, open to design review and pushback and all of this though to figure out what an actually good design would be".

Earlier words still honored: the player request (2026-11-05, "player-like (think Spotify, including a UI with the queue) with a bespoke playlist creator that pops up rather than trying to shove everything into the skinny panel"), the panel list (2026-11-03, "the dm's panel dropdown is going to get pretty large", and the Run the table header), and the side panel that now resizes from 360 to 640 px.

## 1. Summary

- **Time and Sound are panels again**, under Run the table in this order: DM, Scenes, Sound, Time. Ambiance goes. Weather lives only in the scene's Light and weather group in Scenes.
- **The Sound panel has two views**, picked by a row at its top: **Now playing** (the player the owner showed, Up next folded under it, then Effects, Table sound, Background, On this device) and **Library** (search, sort, playlists, tracks, Add music). The Music window goes. The playlist maker stays a pop-up. A track's page is a Sound subpage like a background sound's.
- **A Now playing chip** in the top bar, the DM's, while something plays: Pause or Play, then the track's name, which opens the same player (a popover, a centered card or a bottom sheet by width), with each background sound and its Stop.
- **No row that only jumps to another panel** on these surfaces: the Weather row and the Scene sound row go. Use what's playing stays in Sound, as an action.
- **Polish carried here**: one size of step buttons in Time, a stop icon that is not a checkbox, "Table sound" with plain volume labels, the player's Now playing as a card, the backup command that wraps at spaces, a shorter Long Rest note.
- **Nothing stored changes**: no op, projection, snapshot or room setting. Old panel ids still open the right panel.

## 2. Audit (main 069591ea, measured)

A DM room with 100 music tracks, 4 playlists, 4 background sounds and 3 effects, Tavern night playing (3 of 12) with 2 background sounds, a clock running, nothing stored. Depth is px from the panel's content top. Shots `01` to `09` with `before` in their names. "After" is the draft 2 prototype.

| What | Before (Ambiance) | After (prototype) |
|---|---|---|
| Side panel tab row at 360 | Token, Initiative, Dice, Log, More | same |
| Tab row at 640 (9 icons fit) | ... DM, Scenes, Ambiance, More | ... DM, Scenes, **Sound**, More (Time in More) |
| More's list at 360 | 11 panels, 629 px tall | 12 panels, 673 px |
| More at 1280 x 720 | fits | 673 px in 662 px of room: "Scroll for more" over Menu (D-097) |
| Phone Panels list | Run the table: 2 rows (DM, Scenes / Ambiance) | 2 rows (DM, Scenes / Sound, Time), list height unchanged (504 px) |
| Player's list, clock shared and music on | ... Areas, Ambiance, Characters ... (10) | ... Areas, Sound, Time, Characters ... (11) |
| Sound at 360, content height | 2,165 px, 38 buttons | 2,322 px, 52 buttons (Up next folded) |
| Pause at 360 | 255 | 208 |
| Effects at 360 | 422 (Time folded) | 492, or about 1,140 with Up next open |
| Phone 390 x 844, half sheet 444 px | Pause 243, Effects 410 | Pause 196, Effects 480 |
| Phone 320 x 568 at 130%, sheet 201 px | Pause 315 | Pause 234 (still under the sheet's foot, as before) |
| Start a playlist, computer, Sound open | Open music, Play: 2 | Library, Play: 2 |
| Start a playlist, phone | Panels, Ambiance, Open music, Library, Play: 5 | Panels, Sound, Library, Play: 4 |
| Pause the music, Sound not on screen | computer 3 (More, Ambiance, Pause), phone 3 | computer 1 (the chip's Pause), phone 2 (chip, Pause) |
| Move the clock on 1 hour, phone | Panels, Ambiance, unfold Time, 1 hour: 4 | Panels, Time, 1 hour: 3 |

Findings: the Weather row and the Scene sound row each only open Scenes. The Music window put the player one tap and a modal away, and on a computer it dimmed the map. The compact Now playing in the panel repeated Pause and Skip in a second look. Stop all sound, Stop the music and a loop's Stop draw a hollow square that reads as a checkbox (visible in the owner's screenshot). Every volume label says "for everyone". Alignment of Ambiance measured 0 over 1 px at 1440 x 900 (360 and 640) and 390 x 844.

## 3. The panel list (D-261106-086, 087)

### 3.1 Order and names

| Group | DM | Player (no labels) |
|---|---|---|
| In play | Token, Initiative, Party (phone), Dice, Log, Journal, Areas | Token, Initiative, Dice, Log, Journal, Areas |
| Run the table | DM 30, Scenes 32, **Sound 34**, **Time 36** | Sound and Time, each while listed (3.2) |
| Prepare | Monsters, Encounters, Characters, Outliner, Library | Characters, Library |
| (a line) | Menu | Menu |

- **Sound before Time.** At 640 px the row holds nine icon tabs (measured), and the ninth is the first panel of Run the table after Scenes. Sound is used every scene (Effects, Pause, background), and Time has its own chip from 900 px up, so Sound takes the row and Time waits in More. This departs from D-083's order (DM, Scenes, Time, Sound).
- Icons: Sound keeps `music`, Time keeps `time`. The `ambiance` icon (Lucide `cloud-sun`) leaves Icon.tsx and CREDITS.md if nothing else draws it.
- **What keeps the list calm**: the three labels, as now. On a phone Run the table still takes two rows of the two-column list, so the list is no taller. More gains one 44 px row: at 1280 x 720 it is 11 px taller than its room and shows "Scroll for more" over Menu (D-097, a follow-up for the shared menu's heading rows).
- Rejected: keeping Ambiance with Time and Sound as tabs inside it (a panel whose only job is to hold two others, the thing the owner called weird), a fourth Weather panel (one select), Time before Sound (Sound would fall into More at 640).

### 3.2 Players

Back to the rules before Ambiance (calendar 4.4, music 4.1): **Time** is listed while the player's view holds the clock, or while Time is open (a hidden sheet or side panel counts). **Sound** is listed while something plays that they receive, or while Sound is open. An open panel whose reason ends keeps its own line: Time says "The DM isn't sharing the date and time now.", Sound says "Nothing is playing." `PanelDef.needsAmbiance` splits back into `needsClock` and `needsSound`, and `PanelsForOptions` into `{ clock, sound }`. kept.ts, its slot and the empty line "The DM isn't sharing the date and time or playing sound now." go: each panel's own open state does that job.

### 3.3 Old ids and stored values

- `PANEL_RENAMES` becomes `{ ambiance: "sound" }`. "time" and "sound" are real ids again, so a split stored before Ambiance (Time over Sound) reads as it was. `canonicalPanelId` keeps its four callers (the store's `openPanel`, `parseSplit`, `decodeReopen` and the player preview's `openPanel`, features/dm/preview.ts:192). Stored "Initiative over Ambiance" opens Initiative over Sound. A stored pair that becomes one id reads as no split and keeps its share, as panel-groups 7 has it.
- Why Sound for "ambiance": a running clock kept Time folded, so a DM who kept Ambiance open kept it for sound.
- **The clock chip** opens Time (`ui.openPanel("time", { pane: "top" })`), focus to the panel as today. `openAmbiance`, its request slot and the request scroll go.
- **Folds**: `rvtt.ambianceFolds` is no longer read. It is left in storage (two booleans, harmless, and no other key reads it). A new surface `rvtt.soundFolds` holds `upnext` (4.3). `useEndRevealsOnClose("ambiance", …)` goes. Scenes' and the DM panel's close hooks stay (Room.tsx:550 to 552), and `SCENES_PANEL`, which Room.tsx imports from features/scenes/request.ts today, moves to features/scenes/ids.ts when request.ts's helpers go (6.2).
- **Clock toasts** show while neither the Log nor Time is on screen (calendar 4.7 as it was), so `timeShows` reads Time's panel, not a fold.
- Rejected: mapping "ambiance" to "time" (most open Ambiance panels were for sound), clearing `rvtt.ambianceFolds` on load (code for nothing).

## 4. The Sound panel (D-261106-090, 091, 092)

### 4.1 Two views, their scroll and the search

A `Segmented` row at the top, named "Sound", with **Now playing** and **Library**, `grow`. Its state is a Room scope slot, `soundViewSlot` = `{ view: "now" | "library", query: string }`, read by both trees, never stored.

- **On the panel's open** (closed to open, a hidden sheet or side panel counting as open, as the folds read it): the view becomes Now playing, the query empties, and the panel opens at its top with the player in view: Sound's saved scroll in `panelScrollSlot` is dropped as Sound closes (open to closed), not as it opens, since the keeper's first restore runs in the body's layout effect before any effect after the mount could drop it. A close and reopen after scrolling to the foot of a 100-track Library therefore lands on the player, never on Library's offset or its end (panels.ts:633, 652).
- **While it stays open**: the view and the query hold through a turn across 900 px and through a subpage and its Back. The scroll keeper's `page` names the view for the first page (`"now"`, `"library"`), published without a header, so an offset saved on one view is never put back on the other: a remount restores each view's own place. A switch of view sets the scroller's `scrollTop` to 0 itself, as `useSubpageFocus` does for a subpage (panels.ts:549), since the keeper restores only when the panel shown changes (`show(id)`, panels.ts:691), so the new view starts at its top.
- **Open Sound** from the chip's player (5.3): the panel opens, or stays, then a subpage leaves through its own Back path (a field typed in the panel is blurred first, so a track's name that was being typed saves, as SoundPage saves on blur), then the view becomes Now playing and the scroller goes to its top, counting as the viewer taking it (`takeOverPanelScroll`), so a remembered offset never pulls it away.
- Why two views and not one page: Library with 100 tracks is about 6,000 px at 360, and one page holding it is the 8,152 px Sound panel the owner first asked to stop ("shove everything into the skinny panel"). Library as a fold at the foot would sit under Effects, Table sound and Background (1,850 px down at 360), so starting a playlist would mean a long scroll each time. The view row puts Library one tap from the panel's top, and the Music window had already taught Now playing and Library as tabs on a phone.
- With the server's switch off: no view row, today's off state (its line, Effects, On this device).
- Rejected: Library as a Sound subpage (a Back for every pick), three views with Effects on its own (a tap more for every effect during play), keeping the Music window as an "expand" (two homes for one set of controls, D-084), storing the view or the query (a DM in play opens Sound for the player).

### 4.2 Now playing, top to bottom

1. **The player**, the owner's view (NowFull): the 64 px tile, the track's name and run line, the seek row, the transport (Shuffle, Previous, Play or Pause, Skip, Repeat), then Crossfade (its menu) and Stop the music in a centered row.
2. **Stop all sound** (danger, while anything sounds) in its own centered row under them, and the device line ("This device plays no sound..."). Its own row, not a wrap of the row above: the prototype tried "on the row where it fits", and measureAlignment flags the lone wrapped button at 360 and 390 (wrap-orphan 52 px). At 640 it is the same row under, so the block looks one way at every width, and its danger tone and place keep it apart from Stop the music.
3. **Up next**, a Section fold (4.3).
4. **Effects**, unchanged inside.
5. **Table sound** (PLR-24, 7): Music, each background sound's volume with its Stop, Effects, the scene's line with Use what's playing (6.2), and Players see what is playing.
6. **Background**, unchanged.
7. **On this device** and the storage line.

With no music the player says "No music is playing. Pick a playlist or a track in Library.", "Library" a link button in the Guide link's look that switches the view to Library (SL-OPUS-15). At 360 the player ends at about 430 px, so Pause, Skip and Stop all sound stand in the first screen on a computer and in a phone's half sheet (Pause at 196 of 444).

### 4.3 Up next

- A Section fold labeled **Up next**, surface `rvtt.soundFolds`, key `upnext`, **folded on every width with nothing stored**, remembered per device after a tap, its content kept mounted (`keep`).
- **Folded summary**: the Next line alone, "Next: Tavern in the rain" ("Next: this track again", "Last track"), in the fold's usual muted summary look (13 px, `textMuted`), on the label's row where it fits and under it where it does not (FoldLabel wraps it, and a long name stays whole). Measured on the label row at 360 and 640, 44 px tall. **Open**, the summary is the count, "9 tracks · 26 min", and the list is music-player 4.3 unchanged: drag and keys, the second list under Repeat all and one, Played under Repeat off, every More menu. It drops its own "Up next" heading, which the fold now carries.
- **Why folded**: The owner chose Effects right under Now playing (D-261102-766). With Up next open on a 12-track playlist, Effects falls from 492 to about 1,140 px, under the 855 px the side panel shows at 1440 x 900. Folded, the owner's view keeps its Up next heading and next track, and the queue is one remembered tap away.
- **Effects stays under Up next, not between the player and Up next**: that would split the view the owner asked to keep whole.
- A 100-track run: open, the list is long, as the DM asked by opening it. Folding it again brings Effects back.
- Rejected: open from 900 px (Effects under the fold), a capped list with "Show all" (drag and keys across a hidden edge), Up next after Background (far from the player it belongs to), the count in the folded summary (it read as the next track having 9 tracks).

### 4.4 Library

The Music window's Library column as built (music-player 4.4), in the panel: **Search music** and **Sort: Name** in one row, **Playlists** with New playlist, **Tracks** with "3 of 100" while searching, Add music…, the storage line. Every row's Play and More menu unchanged (Play next, Add to queue, Add to playlist…, Rename or delete…, Edit playlist).

- The query is `soundViewSlot.query` (4.1), not Library's own state (Library.tsx:168 today), so a view switch, a track page's Back and a turn across 900 px keep the search and its list.
- The search row sticks to the top of the panel's scroller while the lists scroll (`position: sticky`, the panel's background), so a 100-track list can be searched from anywhere in it.
- The Library's own guide link goes: the panel's Guide link at its foot (`guide: "music-and-sound"`) serves both views.
- 100 tracks: search filters as typed, sort is kept per device (`rvtt.musicSort`), and rows are 59 px with a 40 px tile from 300 px of width.

### 4.5 The maker and a track's page

- **The maker is a pop-up** (D-261106-092), the shared `Dialog`: 1040 px (`dialog.xl`) on a computer with its two columns from 912 layout px, the tall sheet (`phone: "tall"`) below 600. Its body, footer, draft, Delete playlist and every rule are music-player 5 as built. Opened from Library: New playlist, a playlist row, More's Edit playlist, and a track's More, Add to playlist…, New playlist with this track. Titled with the playlist's name or "New playlist", no back button.
- **Leaving it** (as D-261106-020 and D-261106-006 settled, and the code does: Maker.tsx:296 `useUnsavedInput`, sheetSwipe.ts:338 to 349 and 529): **Save** and **Create playlist** close once answered. **Cancel**, the close button, **Escape** and Android's **Back** close at once with no changes, and with changes say "Throw away your changes?" in the status and close on a second press. A **swipe down** and **Put away sheet** close with no changes, and with changes spring back with the half-follow sign and keep the draft, never asking in the middle of a gesture. The shared rule is unchanged, so every other editor that registers unsaved input keeps it. LP31-B-MAKER-1 (the swipe springs back with no word) is the decided behavior: docs only.
- Focus returns to the row or button that opened it (found by a mark, since a turn across 900 px remounts it). Its state is `makerSlot` (the draft, its base and its id) in Room scope, from music/open.ts's window slot.
- **A track's page** (Rename or delete…) is a Sound subpage, header "Back to Sound", as a background sound's and an effect's already are. Back returns to the view it left, with its search. Its refusals are music-player 4.4's.
- Rejected: the maker inside the panel (the owner asked for a pop-up), a track's page in a dialog (a second kind of page for one sound kind), a swipe that asks (D-261106-020).

### 4.6 In a phone's sheet

The same two views in the bottom sheet. The half sheet shows the view row and the player whole at 390 x 844 (Pause at 196 of 444). At 320 x 568 at 130% the sheet shows 201 px and Pause sits at 234, under its foot, as it did before (315): the chip (5) is the phone's quick way to Pause there.

## 5. The Now playing chip (D-261106-093, 094)

### 5.1 Who and when

The DM and a co-DM, while the server's sound switch is on and something plays (music, or a background sound). Hidden while nothing plays: the bar stays calm in the many rooms that never play sound, and Sound starts music. Players, the table display and View as a player get none (5.5).

**While its player is open** (the popover, the card or the sheet) the chip stays, showing what it last showed, even after playback ends: a local Stop the music or Stop all sound, another DM's stop, or the last track ending under Repeat off. Once playback has ended it shows a stopped state: the word "Now playing" and the music icon, no Pause or Play and no track name, as NowFull drops its transport with no music. It hides as its player closes. Focus on that close: while something still plays, a close that returns focus puts it on the chip as today. When the close will hide the chip (nothing plays), every close that would put focus on the chip (Escape, Back, Close, a press on the chip) puts it on the map's focus target instead. `fallbackFocus` (Popover.tsx:125) alone does not do this: `focusAnchor` (Popover.tsx:697) prefers the anchor while it is drawn, and the chip is still drawn at that moment, so focus would land on it and then be lost as it goes. So `usePopover` gains `anchorGoes?(): boolean`, read in its `close` beside `leaving`, which the chip answers with "nothing plays", and the card and the sheet name the map's target as their return focus in the same case (their dialog helper restores to a connected opener, modalDialog.ts:79). An outside press and Open Sound keep their own destinations. Each test asserts focus after the render that removes the chip.

### 5.2 At rest

| State | Full form (computer) | Compact form |
|---|---|---|
| Music playing | [Pause] then "Tavern at night ▾" in one pill | the music icon |
| Music paused | [Play] then "Paused · Tavern at night ▾", muted | the music icon, muted |
| Crossfading | the incoming track's name, as Now playing names it (`musicAt`) | same |
| Background sounds only | the music icon, "2 background sounds ▾" (no Pause: it pauses music) | the music icon |
| Nothing, switch off, player | no chip (kept while its player is open, 5.1) | no chip |

- **The full form is a split chip**, D-085's lean: Pause or Play on its own (one tap pauses during play), a thin divider, then the name with a caret, which opens the player. One 28 px pill, two 44 px tall targets, the name cut with "…" past 180 px. Measured: 170 px for "Tavern at night", 28 px tall, 0 over 1 px, paused and with background sounds alone too.
- **The compact form** is one 44 px target with the music icon in a 28 px round pill, which opens the player. A phone shows it.
- Names: "Pause" or "Play", and "Now playing: Tavern at night, Tavern night · 3 of 12" ("Now playing, paused: …", "Now playing: 2 background sounds"), with `aria-haspopup="dialog"` and `aria-expanded`. Not a live region: the text changes with each track and a reader hears it on reaching the chip.
- **When it redraws**: on the room's changes to `playing`, and at `music.next.at`, when a crossfade starts and Now playing names the incoming track with no frame from the server: a timer set to that moment (`useWakeAt`, as Library.tsx:166 and NowPlaying's MusicBlock do), never a tick each second.

### 5.3 What a tap opens

By width, as the View menu does (RoomChrome.tsx ViewButton, SheetDialog to Dialog, Dialog.tsx:148):

- **900 px and up**: the shared Popover (`kind: "dialog"`, below the chip, titled "Now playing"), non-modal: the map keeps working and a press outside closes it.
- **600 to 899 px**: a centered card, `SheetDialog` at `dialog.sm` (440 px, theme.ts:460, not SheetDialog's own 480 default), modal. Shot at 700 x 900 (`18-chip-open-700-…-v2`).
- **Under 600 px**: a bottom sheet, the same `SheetDialog`, modal. It closes back to whatever panel was open, which opening the Sound sheet instead would have replaced.

Each holds the following. The popover's body is 340 px wide. In the card and the sheet the body fills the card's width, so the seek bar, the volume and each Stop reach its edge:

1. **The player** (NowFull), the same component as the panel's, with every seek and Previous rule. In the **popover**, Crossfade is an inline `Segmented` labeled "Crossfade" (Off, 2 s, 5 s, 10 s), as the maker's settings draw it, since the Crossfade menu is a popover of its own and opening it would close the player that holds it (popoverRules.ts:320). Measured in the prototype: a pick of "2 s" and an ArrowRight to "5 s" each changed it with the player still open. The **card and the sheet** are dialogs, not popovers, so they keep the Crossfade menu, as the panel's player does. With no music the player says "No music is playing." (no Library here).
2. **The Next line**: "Next: Tavern in the rain", while music plays.
3. **Music volume for everyone**, while music plays (here the label keeps its words: no heading says who hears it).
4. **Background**, while background sounds play: each sound's name with its Stop ("Stop Rain on the cobblestones"), in play order. With only background sounds playing this is the body's reason to be, so the chip never opens an empty player.
5. **Stop all sound** (danger, while anything sounds) and **Open Sound**, which closes the player and opens the Sound panel on Now playing at its top (4.1), focus to the panel.

Measured: the popover is 366 x 642 px with music and two background sounds at 1440 x 900, 0 over 1 px, and the background-only body, the card at 700 px and its rows measured 0 over 1 px too.

- **Jumps** (Previous, Seek, Play now) go through one Room scope slot, music/jumps.ts, so a jump pending from the panel counts in the popover and back. Its silent fallback outside a scope (`UNCOUNTED`, jumps.ts:44 to 46, which sends nothing) goes: a player mounted without the slot is a type error, never a dead button. Skip sends `music.skip` itself (NowFull.tsx:301), not through jumps.
- Its body loads lazily with the music chunk, started as the chip first shows. Past 200 ms the shared loading line shows in it ("Opening the player…"), and a failed load says "Couldn't open the player." with Try again.
- Rejected: a mini bar over the map above a phone's toolbar (48 px of map on every turn), the chip opening the Sound sheet on a phone (it replaces the panel the DM had open), Up next rows in the popover (an editable queue in a box a tap outside closes), the Crossfade menu in the popover (it closes the player), a player step inside the popover for Crossfade (a Back inside a small box), a key to open it (none asked, a later item if the owner wants it).

### 5.4 What the chip needs from the bar (for the top bar's design)

- Two forms, full (about 140 to 250 px, 28 px pill in a 44 px row) and compact (44 px), and off.
- Give-way: full to compact first, compact off later. This design's guess for the order: the full form gives way right after the clock chip, and the compact form after the DM chip's name, since a DM in play reaches for Pause more than the clock. the top bar's lane owns the final order and the chip's place in the row.
- A phone's bar shows the compact form while it has room. The prototype fit it at 390 x 844 beside the DM chip, Undo, Redo, View and Fit. 320 x 568 at 130% is the top bar's lane to measure.
- Its width changes on a track change, a pause, a resume and a crossfade's start (5.2), never each second. It stays drawn while its player is open (5.1).

### 5.5 Players

No chip. A player has nothing to control but this device's volume, their Sound panel names what plays (when shared), and their bar's room goes to their own name chip. Their projection is unchanged: the playing track and a revealed next, never more. Rejected: a read-only chip (a second place to say what Sound already says, at the cost of the player's name).

## 6. Weather and jump rows (D-261106-088, 089)

### 6.1 One rule, for these surfaces

On Time, Sound, the chip and the Scenes settings they touched: a control lives where the DM looks for it, and a row whose only act is to open another panel is avoided unless nothing else works. Elsewhere the jump buttons were checked and are kept, each the way from a result to its own home: Dice's area template to Areas (DicePanel.tsx:144), Recent rolls' "Log" to the whole Log (RecentRolls.tsx:347), and the Token panel's character to Characters (TokenPanel.tsx:347). None stands in for a control that could live where it is.

### 6.2 Each row

| Row (where) | Now |
|---|---|
| Weather (Ambiance) | Gone. Weather is set in Scenes, Light and weather, and shows on the map itself, which the DM is looking at. |
| Scene sound (Ambiance's What players hear) | The jump row goes. **Use what's playing** stays, an action beside what plays, described by the scene's line, which becomes plain help text: "Goblin cave's sound: Tavern night." ("… has no sound of its own.", "… is silent."), and "Play something first." while nothing plays. Play it, Use silence and Clear stay in Scenes' Scene sound group. |
| The clock chip | Opens Time itself, not a section of another panel. |
| Open music (Sound group) | Gone with the window. |

- `openSceneSettings`, `sceneRequestSlot` and `useEndSceneRequestOnClose` (features/scenes/request.ts) lose their last callers (AmbiancePanel.tsx:171, NowPlaying.tsx:313, SceneSettings.tsx:231) and go with their tests, and SceneSettings.tsx stops taking a request. `SCENES_PANEL` moves (3.3), so Scenes' fold close hook stays.
- Weather outside Scenes: not shown. Rejected: weather on the clock chip or in Time's header (weather is a scene's, the time is the room's, so one line would mix two scopes and change with the DM's view), a player weather line (a new feature, still on the Later list).

## 7. Polish these surfaces carry (D-261106-095, 096)

- **Time's step buttons, one size**: 10 minutes, 1 hour, 8 hours, To dawn and Other amount… are five equal 44 px buttons in the steps grid, Other amount… spanning its row, two by two from 360 px of content and one column below. Move on takes the default size too. Measured 0 over 1 px, Other amount open and shut.
- **Stop, not a checkbox (PLR-23)**: the `stop` icon becomes Lucide `circle-stop` (ISC, Lucide already credited), so Stop the music, Stop all sound, a background sound's Stop and every other `stop` user change together.
- **"For everyone" once (PLR-24)**: What players hear becomes **Table sound**, with help "What everyone at the table hears, set here for every device. Each device can turn itself down under On this device." Visible labels: "Music", the sound's name, "Effects". Accessible names keep "Music volume for everyone" and the rest, so a reader still hears whose volume it is, and the visible words stay inside the name. Room sound's help, under On this device, starts "This device only:" so the two read apart. Rejected: "Player sound" (the DM hears it too), "Volume" (the group also holds the names switch and the scene's sound), "For everyone" (SL-OPUS-9, a clause-like label beside nouns, and the help lines already part the two scopes).
- **A player's Now playing as a card**: the 44 px tile and the track's name (16 px bold) or "Music is playing" while names are hidden, with the background line under it in muted text, then this device's lines as today. The tile's tint comes from the name only when the player holds it. Otherwise it takes one fixed tint, so the tile says nothing the projection lacks.
- **The backup command** (features/settings/ExportSection.tsx:109, `wordBreak: "break-all"`) becomes a block of code that wraps at spaces (`white-space: pre-wrap`, `overflow-wrap: break-word`), so "docker-compose.server.yml" breaks only where one word is wider than the line. The class is commands with spaces, and this is its only member. The other `break-all` users are links with no spaces (dm/controls.tsx:148, Home.tsx:404, AboutPanel.tsx:58), which need it and stay.
- **Long Rest's note**: characters with the same Long Rest stamp share one sentence, and its dates drop the weekday and the year when they are the clock's own: "Bree and Thorn finished a Long Rest at Midwinter, 5:00 PM. The next can start from Month 3 1, 9:00 AM." The party's notes are built in features/tokens/CharactersPanel.tsx:272 to 276 (PartyLongRest), which groups them, and one character's in RestSection.tsx:60 through `restNote`, which takes the short dates. The note is shown, never stored. "Month 3 1" comes from the starting month names ("Month 1" to "Month 12"): reading the day better there changes `dateText`, which stored clock lines use (shared/calendar.ts `lineDate`), so it needs an op version step and is logged as a follow-up (D-096).
- **Headings** follow the heading rule: Now playing, Library, Up next, Effects, Table sound, Background, On this device, Move the clock on, Sharing, Stop.

## 8. Players, the table display, View as a player, and storage

- Players: Time and Sound panels by 3.2, the card of 7, no chip. Nothing new reaches them: no projection, op or field changes.
- The table display: unchanged (its own Sound menu). No chip.
- View as a player: the preview lists the player's Time and Sound by the player's rules, and its bar shows no chip.
- Stored: no op, no projection, no snapshot, no room setting. Device keys: `rvtt.soundFolds` (new, `upnext`), `rvtt.ambianceFolds` no longer read, `rvtt.musicSort` unchanged. The view and the query live only in the page (4.1). Stored panel ids canonicalized (3.3).

### 8.1 Changes to what the owner has already seen

These are the changes to what the owner had already seen, each shown to the owner with the preview (section 12):

1. **Ambiance** (Time, the Weather row, Sound, folding) is gone. Time and Sound are panels again, Sound first.
2. **The Weather row** is gone. Weather is set only in Scenes, Light and weather.
3. **The Scene sound row** in Sound is gone. Use what's playing stays, with the scene's line under it.
4. **The Music window and Open music** are gone. The player the owner showed is the top of Sound's Now playing view, and Library is Sound's second view.
5. **The compact Now playing** (44 px tile, Next line, Pause, Skip, Open music, thin bar) gives way to the owner's player (64 px tile, seek, the whole transport, Crossfade, Stop the music). Stop the music and Repeat, window-only since the music player shipped, are back in the panel.
6. **The Next line** moves into Up next's folded summary and the chip's player.
7. **Up next** is folded in the panel until the DM opens it (in the window it was always shown).
8. **Effects** sits under the player and Up next's one row: 492 px down at 360 instead of 422.
9. **The playlist maker** is its own pop-up (it was a step of the window, with back "Music").
10. **A music track's page** is a Sound subpage, "Back to Sound" (it was a window step).
11. **What players hear** is **Table sound**, and its labels drop "volume for everyone".
12. **Stop icons** are a circle with a square, not a square.
13. **Time's step buttons** are all one size.
14. **The clock chip** opens Time, not Ambiance at Time.
15. **A player's** Ambiance is Time and Sound again, and their Now playing is a card.
16. **New**: the Now playing chip, and in its player an inline Crossfade row on a computer.

## 9. UI checklist

- **Loading.** Sound and Time load as any panel (the shared Loading line, a LoadBoundary that reopens the panel). The maker's chunk opens its dialog at once on the shared loading line past 200 ms ("Opening the playlist…"), and a failed load says "Couldn't open the playlist." with Try again. The chip's player as 5.3. Queue edits, jumps, Pause and Play show at once by the store's prediction. Save and Create show busy and refuse a second press. The chip's Pause turns into Play the moment it is pressed.
- **Keys and focus.** The view row is a radio group (arrow keys). The Up next fold is a heading's button with `aria-expanded`. Handles keep Up, Down, Home, End and Escape during a drag. The chip: Tab reaches Pause, then the name. Enter or Space on the name opens the popover with focus inside (Popover rules), Escape closes it and focus goes back to the name, or to the map's focus target when the chip has gone (5.1). In the popover the Crossfade row is a radio group: arrows change it and the popover stays open. The card and the sheet return focus to the chip, or to the map's focus target. Open Sound moves focus to the Sound panel. The Library link in the nothing-playing line is a button that moves the view and focus to Library's search. No new key.
- **The shortcut sheet.** The Music surface keeps its three rows. musicMove's and musicEnds' "when" becomes "on a track's handle in Up next or the playlist maker", musicDragEscape keeps "while dragging a track", and the comment over them (shortcuts.ts:1112, "The Music window's handles") follows, with FEATURES.md's Shortcuts rows in the same change. Nothing added or removed.
- **Screen readers.** The view row is named "Sound". Up next's summary is the fold's description. The chip's two buttons are named as 5.2 and are not live. The popover is a dialog named "Now playing", its Crossfade row a radio group named "Crossfade". The player card's tile is `aria-hidden`.
- **Large interface sizes.** At 320 x 568 at 130% the view row keeps two options on one line, the transport takes two rows under 256 px, the chip is compact, and its player opens as a sheet. At 1440 x 900 at 130% the popover is placed inside the window (`bound`), and its Crossfade row wraps under its label where it must.
- **Theme.** Tokens only. Light and dark shot.
- **Alignment.** Measured in the prototype, 0 over 1 px at 100%: draft 1's 17 roots at 1440 x 900 (side panel 360 and 640) and 390 x 844, and draft 2's 11 (the player block at 360, 640 and 390, Up next's label row at 360 and 640, the popover and its foot, the background-only popover and its row, the nothing-playing line, the card at 700 x 900). Not measured: 1280 x 720, 320 x 568 and 130%, which the sweep roots of 10.4 cover.
- **Words, exactly:** "Sound", "Time", "Now playing", "Library", "No music is playing. Pick a playlist or a track in Library.", "No music is playing.", "Up next", "Next: Tavern in the rain", "9 tracks · 26 min", "Table sound", "What everyone at the table hears, set here for every device. Each device can turn itself down under On this device.", "This device only:", "Music", "Effects", "Crossfade", "Off", "2 s", "5 s", "10 s", "Background", "Stop Rain on the cobblestones", "Back to Sound", "Pause", "Play", "Paused · Tavern at night", "2 background sounds", "Now playing: Tavern at night, Tavern night · 3 of 12", "Now playing, paused: …", "Music volume for everyone", "Stop all sound", "Open Sound", "Opening the player…", "Couldn't open the player.", "Opening the playlist…", "Couldn't open the playlist.", "Throw away your changes?", "Music is playing", and music-player 8's words for everything kept. Gone: "Ambiance", "Weather" (the row), "Open music", "Music" (the window's title), "Back to Ambiance", "What players hear", "… volume for everyone" as visible labels, the empty Ambiance line.

## 10. Cases and tests

### 10.1 Cases

| Case | Expected | Test |
|---|---|---|
| DM phone list | In play (7), Run the table (DM, Scenes, Sound, Time), Prepare (5), line, Menu | panels.test, sl-1 |
| DM row at 360 and 640 | 360: Token to Log, More. 640: to Scenes, Sound, More holds Time first | tabFit.test, paneltabs, sl-1 |
| Player, clock shared, nothing plays | Time listed, Sound not | panels.test, sl-2 |
| Player's Sound open, music stops | Sound stays, "Nothing is playing.", until closed, then unlisted | panels.test, sl-2 |
| Player's Time open, DM stops sharing | Time stays with "The DM isn't sharing the date and time now." until closed | sl-2, clock ck-5 |
| Stored split Initiative over "ambiance" | Initiative over Sound | splitPanes.test |
| Stored split "time" over "sound" | Time over Sound | splitPanes.test |
| Stored split "ambiance" over "sound" | No split, share kept | splitPanes.test |
| `rvtt.reopen` "ambiance" | Sound opens | reopen.test |
| Preview's `openPanel("ambiance")` | the player's Sound | preview test |
| Clock chip pressed | Time opens in the top pane, focus to it | sl-3, ck-6 |
| Clock chip pressed while a Sound subpage holds a typed name (am-3b's successor) | The name saves, Time opens, Sound keeps its subpage | sl-3 |
| Clock step from another device, Time on screen / not | No toast / toast | useClockToasts test, ck-2b |
| Sound opens with nothing stored | Now playing at its top, Up next folded with "Next: Tavern in the rain" | sound panel test, sl-4 |
| Pause whole in a phone's half sheet at 390 x 844 and 320 x 568 at 100%, 130% recorded (am-1c's successor) | whole, and the offset at 130% logged | sl-4 |
| Library scrolled to the foot of 100 tracks, Sound closed and opened | Now playing at its top, the player in view, the search empty | view slot test, keeper test, sl-4 |
| Library scrolled to its foot, a turn across 900 px | Library, the same offset, the search kept | sl-4 |
| Library scrolled to its foot, switch to Now playing | Now playing at its top | keeper test, sl-4 |
| Search "harbor", a track's Rename or delete…, Back | Library, "harbor" and its 10 rows | view slot test, sl-5 |
| Open Sound from the chip with Library scrolled to its foot | Now playing at its top, popover closed, focus in the panel | sl-6 |
| Open Sound while a track's page holds a typed name | The name saves through Back's path, then Now playing at its top | sl-6 |
| Up next opened, reload | Open (`rvtt.soundFolds`) | folds.test, sl-4 |
| Storage throws | Up next open, a tap folds for the page | folds.test |
| A drag in Up next across a turn of 900 px | music-player 10's drag rules | dragOrder.test, mu-4 |
| Nothing playing, the Library link | the view moves to Library, focus to its search | sound panel test, sl-4 |
| Server switch off | No view row, the off state, no chip | sound panel test, sp-9, chip test |
| New playlist from Library, Create | One `playlist.create`, the dialog closes, focus back to New playlist | mu-5 |
| Maker with changes: Cancel, the close button, Escape, Back | "Throw away your changes?", a second press discards and closes | mu-5 |
| Maker with changes: a swipe down, Put away sheet | Springs back with the half-follow sign, draft kept, no question | mu-7 |
| Maker with no changes: a swipe, Escape | Closes | mu-7 |
| Maker open across 900 px | Stays open, draft kept | mu-8 |
| Chip: music, paused, loops only, nothing, switch off, player | 5.2's table | chip test, sl-6 |
| Chip's Pause, then Play | `music.pause`, then `music.resume` with a new run | chip test, sl-6 |
| Chip at a crossfade's start, no frame from the server | the incoming track's name, by the timer at `next.at` | chip test (fake timers) |
| Chip's name, computer | Popover with the player, Next line, volume, Background, Stop all sound, Open Sound | sl-6 |
| Crossfade in the popover, by a press and by ArrowRight | `music.set` `fade` each time, the popover still open | sl-6 |
| Chip at 700 x 900 | A centered card with the Crossfade menu | sl-7 |
| Chip, phone | Sheet over the open panel, closing leaves that panel | sl-7 |
| Background sounds alone, chip opened | "No music is playing.", Background with each name and Stop, Stop all sound, Open Sound | chip test, sl-6 |
| Popover open with music and loops, the music stops | The player says "No music is playing.", Background stays, chip stays | sl-6 |
| Popover open, Stop the music with no loops (local), another DM's Stop all sound (remote), the last track ending under Repeat off | The chip stays while open, in its stopped state (no Pause or Play, no track), hides on close, focus to the map's focus target, asserted after the render that removes the chip, for Escape, Close and a press on the chip | chip test, sl-6 |
| Phone sheet open, playback ends, the sheet closes | Chip gone, focus to the map's focus target | sl-7 |
| Previous and Seek from the panel and from the popover, Play now from the panel's Up next | each sends `music.jump`. Skip sends `music.skip` | jumps test, NowFull test, UpNext test, mu-3 |
| Library's foot, then a switch to Now playing in the open panel | Now playing at its top | DOM test, sl-3 |
| Previous in the popover, then in the panel within a round trip | Two tracks back (shared pending jumps) | jumps test, mu-3 |
| Use what's playing with a scene in view, nothing playing | Off, "Play something first." | sound panel test, sp-6 |
| No scene in view | No scene line and no Use what's playing | sound panel test |
| Player's Sound, names hidden | "Music is playing", fixed tint, no name anywhere in the DOM | PlayerSound test, sp-7 |
| Backup command at 360 | breaks only at spaces. The three links unchanged | alignment root, style test |
| Two characters with one Long Rest stamp | one sentence, short dates | PartyLongRest test, restNote test |
| Every new screen at the sweep sizes | 0 over 1 px | alignment roots |

### 10.2 Unit

panels.test (orders, player rules, renames), tabFit.test and menuKeys.test fixtures, splitPanes.test and reopen.test (old ids), folds.test (`SOUND_FOLDS` start folded on every width, stored wins, throwing storage, the ambiance surface gone), the view slot (Now playing and an empty query at each open, both kept across a remount and a subpage), the keeper (a view's offset never restored on the other view, Sound's entry dropped on close), the sound panel render tests (both views, the order of 4.2, Stop all sound's own row, the Library link, the off state, the scene line), PlayerSound (card, hidden names), chip.test (every state of 5.2, the names, Pause and Play ops, hidden for a player, switch off and nothing playing, kept while open, the `next.at` timer), the chip's body (background rows, the inline Crossfade's `music.set`), jumps (one Room slot counted from two places, no fallback), NowFull (Previous and Seek send `music.jump`), UpNext (Play now sends `music.jump`), useClockToasts (Time on screen), PartyLongRest and restNote, words.test. Mutations: the view reset on open, the keeper's page, the dropped scroll on close, the view switch's scroll to the top, `anchorGoes`, the stopped state, the query's slot, the fold's start, `ambiance: "sound"`, the player's open-keeps-listed rule, the toasts' Time check, the chip's three hidden cases, the chip kept while open, the focus fallback, the chip's crossfade timer, the inline Crossfade in the popover (put back the menu, which must fail the open-after-pick test), the background rows, the shared jumps count, the jumps fallback, the hidden-name tint. Each names the test that fails.

### 10.3 e2e

New `e2e/timesound.e2e.ts` (prefix `sl-`, the E2E_PORT offset ambiance.e2e.ts had, +53, unless another is assigned), from ambiance.e2e.ts: sl-1 lists and the row at 360 and 640, sl-2 a player's Time and Sound, sl-3 the chip into Time, the toasts and am-3b's typed-name case with Time as its own panel, sl-4 the views, the scroll and search cases, the fold and am-1c's half-sheet Pause, sl-5 a track's page and its search, sl-6 the chip on a computer (popover, Crossfade by press and key, background alone, playback ending while open, Open Sound), sl-7 the chip at 700 x 900 and on a phone. am-4 (the Weather and Scene sound rows) goes. am-7 and am-8 were never in ambiance.e2e.ts (its line 40: joinrequests, paste and shortcuts cover them) and stay where they are. `music.e2e.ts`: mu-1 becomes the two views, mu-5 to mu-8 open the maker pop-up from Library (mu-5 the asking closes, mu-7 the spring-back), the rest drive the panel's player and Up next. Updated: soundpanel.e2e.ts (sp-1's headings, sp-6's scene line), soundupload.e2e.ts (Library view), clock.e2e.ts (Time panel), paneltabs, splitpanel, layout and panelwidth (lists), size.e2e.ts (the window's two-column case goes). Run each with `reach`.

### 10.4 Sweep roots (e2e/alignmentRoom.ts)

pg-a's Ambiance roots become Time (no clock, clock, Other amount open) and Sound (Now playing playing, paused, nothing with the Library link, Up next folded and open, the switch off) and the player's Time and Sound. pld-a to pld-c become the Library view (empty, a search with no match, the Playlists heading's wrap), the maker pop-up wide and both narrow tabs, More menus, a track's page, the chip (both forms, paused, background alone) and its popover (music with loops, background alone), the 700 px card and the phone sheet. The pg-ambiance-scene-sound-row root goes. The Export section's backup command at 390 x 844. All at 1440 x 900, 1280 x 720, 390 x 844 and 320 x 568, at 100% and 130%, dark and light, and the card at 700 x 900.

## 11. Lanes and files (D-261106-098)

| Lane | Owns | Size |
|---|---|---|
| SL-0, contract | features/panels.ts (sound 34 and time 36 with stub default exports that draw today's sections, `needsClock` and `needsSound`, `PANEL_RENAMES`, the keeper's view page), lib/folds.ts (`SOUND_FOLDS`, `rvtt.soundFolds`), music/open.ts (`soundViewSlot` with view and query, `makerSlot`, in place of the window slot), music/jumps.ts (a Room scope slot, the fallback gone), features/scenes/ids.ts (`SCENES_PANEL`), sound/panel/words.ts (the new words of 9), components/Icon.tsx (`stop` as circle-stop, `ambiance` out) with CREDITS.md and shared/credits.ts. It typechecks alone | S |
| SL-A, panels and Time | pages/Room.tsx (listing, toasts, chip to Time, split restore's `has`, Ambiance's wiring out, `SCENES_PANEL`'s new import), clock/TimePanel.tsx (the panel), clock/StepButtons.tsx, clock/StartClock.tsx (comments), features/ambiance/* (removed, its words moved to sound/panel/words.ts in SL-0), features/scenes/request.ts and SceneSettings.tsx (the request goes), with panels.test, splitPanes.test, reopen.test, folds.test, closeHooks.test, request tests | M |
| SL-B, the Sound panel | sound/panel/SoundPanel.tsx (the panel, both views, the open reset, Open Sound's path, subpages), NowPlaying.tsx (compact block and Open music out, Table sound, the scene line, MusicVolume's label), PlayerSound.tsx (the card), SoundPage.tsx (parent "Sound"), music/NowFull.tsx (the foot row, Stop all sound's row, the inline Crossfade option, the idle line), music/UpNext.tsx (headless), music/Library.tsx (the slot's query, sticky search, guide link out), music/MusicWindow.tsx and MusicWindowHost.tsx (become MakerDialog.tsx and MakerHost.tsx), music/words.ts, with panel.test, music.test, store.test | L, at about 10 logic files |
| SL-C, the chip | new sound/mini/NowChip.tsx (forms, states, kept while open, the `next.at` timer, the focus fallback), NowPlayer.tsx (the lazy body: player, Next line, volume, Background, Stop all sound, Open Sound), words and chip.test. Its one mount line in TopBar goes where the top bar's plan puts it | S |
| SL-D, polish outside Sound | settings/ExportSection.tsx (the command), tokens/CharactersPanel.tsx (PartyLongRest), tokens/RestSection.tsx and clock/words.ts `restNote`, device/ThisDevice.tsx (Room sound's help, :253, which Sound's On this device shares), with their tests | S |
| SL-E, e2e | 10.3 | M |
| SL-F, sweep and docs | e2e/alignmentRoom.ts roots (10.4), state/shortcuts.ts (the two "when" texts and the comment at :1112), FEATURES.md (84, 344, 545 to 557, 610 to 627, 932 and the Shortcuts rows), docs/dm-guide.md "Music and sound" (sections "The Sound panel", "Up next" and "Making a playlist" keep `#up-next` and `#making-a-playlist`, "The Music window" becomes "Now playing in the top bar") and "Time and the calendar" with new screenshots (scripts/guide-music.ts), guide.test.ts, the "Amended by" lines and As built of panel-groups, scenes-reorg, music-player (its 5's leaving list, which named the swipe among the closes that ask), calendar and music, this note into docs/design/design-v1-sound-layout.md with its README line | M |

**Order.** SL-0, then SL-A, SL-B and SL-D at once, then SL-C (after SL-B's player and the jumps slot, and the top bar's plan), then SL-E, then SL-F. One review for the stack. Shared files: Room.tsx with the top bar's lane and SL-A (the rest), each on its own lines. FEATURES.md and the guide only in SL-F.

## 12. The preview

Built on `069591ea` in two throwaway workspaces, one for each draft, and shown to the owner before the build: the Sound and Time panels registered, the Sound panel's two views over today's components (NowFull, UpNext, Library, Effects, Background), the maker shown alone in today's window dialog, a chip in the top bar left of the clock's (a placeholder place), circle-stop, Table sound's plain labels, one step-button size, the player's card. Draft 2 added the inline Crossfade in the popover, the Background rows and Stop all sound in the chip's body, the chip kept while open, Stop all sound's own row in the panel, the Library link, the muted Next summary, and the 700 px card. Not wired: the view slot's reset and query, the keeper's page, the fold's storage, the chip's give-way and timer, the focus fallback, the sticky search, the merged rest note, the backup command. The owner's answer: "All artifacts look good to me". The prototype was never committed.

## 13. Decisions

- **D-261106-086, the list**: Run the table is DM, Scenes, Sound, Time, Ambiance goes, and each player panel keeps its own rule. Rejected: D-083's DM, Scenes, Time, Sound (Sound would fall into More at 640), Ambiance with inner tabs, a Weather panel.
- **D-261106-087, old ids**: `ambiance` opens Sound, "time" and "sound" are real again, `rvtt.ambianceFolds` is left unread, the clock chip opens Time, toasts follow Time's panel, and `SCENES_PANEL` moves to features/scenes/ids.ts. Rejected: `ambiance` to Time, clearing the old key.
- **D-261106-088, weather**: only in Scenes' Light and weather, shown nowhere else but the map. Rejected: on the clock chip, in Time's header, a player line.
- **D-261106-089, jump rows** (amended): one rule on these surfaces. The Weather row and the Scene sound row go, Use what's playing stays in Sound with the scene's line as help, and the Scenes request helpers go with their last callers. The other jump buttons (Dice to Areas, Recent rolls to the Log, the Token panel to Characters) were checked and are kept. Rejected: keeping the Scene sound row, moving Use what's playing to Scenes alone, an app-wide sweep of jump buttons.
- **D-261106-090, two views** (amended): Now playing and Library at the top of Sound, in `soundViewSlot` with Library's query, both reset with Sound's saved scroll at each open, the keeper's page naming the view, and Open Sound leaving a subpage by its Back path before showing the player at the top. Rejected: one long page, Library as a fold or a subpage, three views, the window as an expand, storing the view or the query.
- **D-261106-091, Now playing's order** (amended): the player, Stop all sound in its own centered row and the device line, Up next folded on every width with the Next line alone as its muted summary, Effects, Table sound, Background, On this device, and a Library link in the nothing-playing line. Rejected: Up next open from 900 px, Effects between the player and Up next, a capped Up next, Stop all sound wrapping beside the row (a lone wrap the sweep flags), the count in the folded summary.
- **D-261106-092, the maker and a track's page** (amended): the maker is its own pop-up from Library, its leaving as D-261106-020 (Save and Create close, Cancel, X, Escape and Back ask with changes, a swipe and Put away sheet spring back), and a track's page is a Sound subpage. Rejected: the maker in the panel, a track page dialog, a swipe that asks.
- **D-261106-093, the chip** (amended): the DM's, while something plays or while its player is open: a split chip (Pause or Play, then the name with a caret) in full, one music icon compact, a popover from 900 px, a centered card from 600 to 899 px and a sheet below, each with the player (Crossfade inline in the popover, its menu in the card and the sheet), the Next line, Music volume for everyone, each background sound with its Stop, Stop all sound and Open Sound. Focus falls back to the map's focus target when the chip has gone. It redraws at `next.at` by a timer. Pending jumps are shared with the panel and the silent fallback goes. Rejected: an idle chip, a phone mini bar over the map, opening the Sound sheet on a phone, Up next in the popover, the Crossfade menu in the popover, a player step for Crossfade, a key, a tick each second.
- **D-261106-094, players**: no chip, Time and Sound by their own rules, nothing new in their projection. Rejected: a read-only chip.
- **D-261106-095, the polish** (amended): one step-button size, circle-stop for every stop, Table sound with plain visible labels and full accessible names, help lines that say which is for everyone and which is this device, the player's card, the backup command wrapping at spaces (commands only, links keep break-all). Rejected: "Player sound", "Volume", "For everyone", a filled square stop (the only filled icon among stroked ones).
- **D-261106-096, Long Rest's note** (amended): one sentence per shared stamp with short dates, grouped in CharactersPanel.tsx's PartyLongRest. "Month 3 1" logged as a follow-up, since `dateText` feeds stored clock lines and needs an op version step. Rejected: changing `dateText` here, renaming the starting months (existing calendars keep theirs).
- **D-261106-097, More at 1280 x 720**: accepted at 11 px over, with "Scroll for more", and a follow-up for the shared menu's heading rows (24 px instead of about 35 would fit it with room to spare), which needs its own preview. Rejected: dropping Time from More on a computer (with no clock there is no chip), hiding the labels.
- **D-261106-098, lanes**: SL-0, then SL-A, SL-B and SL-D at once, then SL-C after the top bar's plan, then SL-E and SL-F, one review.
- **D-261106-099, words** (amended): section 9's list. "Open Sound", not "Open the Sound panel" (a panel's name is enough), "Table sound", not "What players hear", and "Paused · " before the name, not a pause glyph (which reads as a button). Known risk: "Table sound" and "Room sound" are near-synonyms in one panel. Room sound sits under On this device and its help now starts "This device only:", and Table sound's help says it is for every device.

## As built

Built in six parts: SL-0 (the contract), SL-A (panels and Time), SL-B (the Sound panel), SL-D (polish outside Sound), SL-E (e2e) and SL-F (the sweep and the docs). **SL-C, the Now playing chip, was not built in this stack**: it moved to the quicker table's stack (docs/design/design-v1-qol.md), where its give-way was decided, and was built there. Sections 5 and 9's chip rows, 10.1's chip cases, 10.4's chip roots and 11's SL-C row describe that work, and this stack's FEATURES.md and guide described the panel's player only. The chip's own As built is in the quicker table's note. Where the build went its own way:

- **Contract** (SL-0): `features/panels.ts` has `SOUND_PANEL`, `TIME_PANEL`, `needsClock` and `needsSound`, `PANEL_RENAMES = { ambiance: "sound" }` and `usePanelView` (the keeper's page, read through a Room scope map, so a view that does not match waits as a subpage does). `music/open.ts` holds the view slot, `endSoundView`, `openSoundNow` and the maker's slot, with a mark on its opener (`data-maker-opener`), so the eager chip never loads the panel. `music/jumps.ts` is a Room scope slot with no fallback. `circle-stop` is credited to Feather as well, like `cloud-rain`. `usePopover`'s `anchorGoes` was not declared here, since only the chip reads it, and SL-C declared it when it built the chip.
- **Listing** (SL-A): the listing and toast rules are a pure module, `pages/timeSound.ts`, with unit tests. `features/ambiance/*` went, and so did `features/scenes/request.ts` once nothing called it. Starting the clock focuses the new date block and scrolls the panel to show it (LP31-A-TIME-1, which the design did not list): before it, focus fell to the page and on a phone the date sat above the sheet. The start form and Other amount keep their own state again.
- **The Sound panel** (SL-B): there is no Up next with no music and no player card for background sounds alone. The sticky search row has no negative bottom margin, since the alignment check reads that as the pane's inset, so Playlists sits 8 px lower at rest. `Section`'s fold takes `describedBy` (Up next's summary) and `VolumeSlider` takes an accessible `name` (Table sound's plain labels). `draftOf` and `newDraft` moved to `open.ts`, so Library opens the maker without loading `Maker.tsx` (the maker's chunk is 9 KB). Measured: Pause at 208 px at 360, at 196 of 444 on a 390 x 844 phone and at 234 at 320 x 568 and 130%. Two Library findings pre-date it and show in the old window too: a 13 px edge where a search matches tracks and no playlist, and uneven Playlists row heights at 320 x 568 and 130%.
- **Polish** (SL-D): the backup command's style is `ADMIN_COMMAND_STYLE` (`pre-wrap`, `overflow-wrap: break-word`). Long Rest's note groups by stamp (`partyRestNotes`), and a date drops its weekday and year when its year is the clock's current one, decided per date. A single character's note takes the new wording too. "Month 3 1" is not changed (it needs an op version step, D-096 follow-up).
- **The sweep** (SL-F, 10.4 without the chip): pg-a measures Time (no clock, a clock, Other amount open) and Sound (playing, Up next open, paused, nothing playing with its Library link, the switch off), ck-a and ck-b measure Time, and a player's Time and Sound with nothing shared, reached by a reload that asks for each panel. pld-a to pld-c measure Now playing with nothing playing, the Library view (empty, a search with no match, the Playlists heading), Up next open with Played, the More menus, a track's page, the maker wide and in both narrow tabs, New playlist with focus returning to its button, and the switch off. sn-d measures the Export section's backup command at 390 x 844 and checks it never runs past its box.
- **Leftovers**: `Group`'s `onOpen` and `openLabel` and `SettingRow`'s `onOpen`, the jump-row modes, have no production caller now, only their tests. `rvtt.ambianceFolds` stays in storage unread. `playerMusicLine` went with the player's old line.
- **The guide**: "The Music window" became "The Sound panel" and "Library", and its pictures (the Sound panel, Library, the maker, Up next on a phone, the phone's panel list and Time's two) are made again by `scripts/guide-music.ts` and `scripts/guide-time.ts`.
- **The Now playing chip** (SL-C, built in the quicker table's stack): the pill is drawn as two halves inside the two targets, since one pill around both stood as a painted 28 px box beside the connection dot and failed the row-height check by 18 px. Pause's target is 36 x 44. Enter on the name puts focus on Crossfade's chosen option, by the shared popover rule. The popover is placed again as its body loads and as its shape changes. Its card is a chip dialog, so it outlives a give-way. The chip shows only while the room's sound switch is on. The chip's waiting contract has its caller now, so `timeShown`, `StopAllSound`, `TIME_TITLE` and `BACK_TO_SOUND` went, and `usePopover` takes `anchorGoes`.

## Round 1 dispositions

A Codex reviewer (SOUNDLAYOUT-ASTRA) and a Claude reviewer (SL-OPUS), against `069591ea`, then a confer round. Both agreed the layout stands (Sound before Time, two views, Up next folded, the maker apart, no player chip, a scrollable More). Every finding adopted but SL-OPUS-9.

| Id | Fix |
|---|---|
| SL-ASTRA-01 | Crossfade in the popover is an inline Segmented, so it never closes the player. The card and the sheet keep the menu. Prototype measured a press and ArrowRight with the popover still open. Test by press and key (5.3, 10.1) |
| SL-ASTRA-02, SL-OPUS-6, SL-OPUS-16 | The keeper's page names the view. The view, the query and Sound's saved scroll reset on open. The query lives in `soundViewSlot`. Open Sound leaves a subpage by its Back path, saving a typed name, then shows the player at the top. Cases from a 100-track Library's foot and a track page with a name typed (4.1, 4.4, 10.1) |
| SL-ASTRA-03, SL-OPUS-2 | The chip's body lists each background sound with its Stop, then Stop all sound. Its empty line is "No music is playing." Tests for loops alone and for music stopping while loops go on (5.3, 10.1) |
| SL-ASTRA-04, SL-OPUS-1 | The maker's leaving follows D-261106-020: Save and Create close, Cancel, X, Escape and Back ask, a swipe and Put away sheet spring back. Music-player 5's list is amended in SL-F. LP31-B-MAKER-1 is docs only (4.5, 10.1, 11) |
| SL-ASTRA-05, SL-OPUS-3 | The chip stays while its player is open and hides on close. Focus falls back to the map's focus target. Tests for a local Stop, a remote Stop and a natural end (5.1, 10.1) |
| SL-ASTRA-06 | 5.3 names three ranges: a popover from 900 px, a centered card from 600 to 899 px, a bottom sheet below 600. Shot at 700 x 900 (5.3, 12) |
| SL-OPUS-4 | SL-D owns CharactersPanel.tsx's PartyLongRest (7, 11) |
| SL-OPUS-5 | The am-7 and am-8 line is gone. am-1c's check goes into sl-4 and am-3b's into sl-3 with Time as its own panel (10.1, 10.3) |
| SL-OPUS-7 | Stop all sound has its own centered row under Crossfade and Stop the music, since a lone wrap beside them measured as a wrap-orphan (4.2) |
| SL-OPUS-8 | The folded summary is the Next line alone, muted, on the label row where it fits and wrapping where not. The count shows open (4.3) |
| SL-OPUS-9 | Declined: "Table sound" stays. Logged as a known risk in D-099, and both help lines now say which is for everyone and which is this device (7, 13) |
| SL-OPUS-10 | Only musicMove's and musicEnds' "when" change, musicDragEscape keeps its words, and the comment at shortcuts.ts:1112 follows in SL-F (9, 11) |
| SL-OPUS-11 | The break-all change covers commands with spaces only. The three links keep break-all (7) |
| SL-OPUS-12, as the Codex reviewer corrected it | jumps.ts's silent fallback goes. Previous, Seek and Play now are tested to send `music.jump` from the panel and the popover. Skip sends `music.skip` itself (5.3, 10.1) |
| SL-OPUS-13 | D-089's rule is scoped to these surfaces, the other jump buttons are listed as checked and kept, and `SCENES_PANEL` moves to features/scenes/ids.ts (3.3, 6.1, 6.2) |
| SL-OPUS-14 | The chip redraws at `music.next.at` by a timer, as Library does, never a tick each second (5.2, 5.4) |
| SL-OPUS-15 | "Library" in the nothing-playing line is a link button that switches the view (4.2) |

## Round 2 dispositions

Both reviewers agreed every round 1 disposition but one: the Codex reviewer held SL-ASTRA-05 open. The Claude reviewer said consensus with two P3s. All adopted, in the text above.

| Id | Fix |
|---|---|
| SL-ASTRA-05 (round 2) | Checked: `focusAnchor` (Popover.tsx:697) prefers a drawn anchor, so `fallbackFocus` never runs while the kept chip is drawn. A close that will hide the chip sends focus to the map's target through a new `usePopover` option `anchorGoes`, and the card and the sheet name the same target. Tests assert focus after the chip's removal (5.1, 10.1) |
| SL-ASTRA-07 | The kept chip has a stopped state after playback ends: "Now playing" and the icon, no transport, no track (5.1, 10.1) |
| SL-ASTRA-08 | Play now is tested in the panel's Up next (UpNext.tsx:80), not the popover. Previous and Seek in both players. Skip sends `music.skip` (10.1, 10.2) |
| SL-OPUS-17 | Checked: the keeper restores only on `show(id)` (panels.ts:691). A view switch sets `scrollTop` to 0 itself. Sound's saved scroll is dropped as Sound closes, not as it opens. A DOM test from Library's foot (4.1, 10.1, 10.2) |
| SL-OPUS-18 | `dialog.sm` is 440 (theme.ts:460), so 5.3 says 440. The 340 px width is the popover's only: the card's and the sheet's body fills them (5.3) |

## Round 3 notes for the build

Both reviewers said consensus on draft 3. The Claude reviewer added two P3s, adopted for the build without another round:

- SL-OPUS-19: 10.1's row "Library's foot, then a switch to Now playing in the open panel" repeats the row "Library scrolled to its foot, switch to Now playing" and names the wrong step. The build drops the repeat and tests the case in sl-4 as a DOM test, not a keeper unit test (the keeper never sees a view switch).
- SL-OPUS-20: the chip's stopped state (5.1) is named "Now playing, stopped". It joins section 9's words, and chip.test asserts it.
