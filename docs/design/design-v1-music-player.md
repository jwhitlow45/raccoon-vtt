# raccoon-vtt: a Music window with a queue, and a playlist maker that pops up

Status: built (2026-11-06), from design draft 3 at review consensus, in lanes PL-0, PL-A, PL-B and PL-D (section 12), after design review rounds 1 to 3 (Codex and Claude reviewers, every P2 adopted, "Round 1 dispositions" to "Round 3" at the end). "As built" says where the build went its own way. Decisions D-261102-960 to 969 (section 14), amended where marked, and the builders' D-261106-007 to 029. Code is cited from `584fa7da` (OP_VERSION 46, SNAPSHOT_VERSION 36), where every cited file reads as at draft 1's `e58995ac`. It builds after lane AR-A (op 47, snapshot 37), panel-groups lanes A to D (Ambiance's Sound group, D-261102-766 and 767), lane sndfade (D-261102-950, 951, 953 to 955), and panel-size lanes PS-A and PS-B (docs/design/design-v1-panel-size.md). Every layout here works at the side panel's default 360 px and on a phone. The preview is in the `music-player-preview` screenshots folder (13). Its prototype was never committed.

The owner (2026-11-05, after a session): "I wonder if we should look at a ui overhaul to make it more "player-like" (think Spotify, including a UI with the queue) with a bespoke playlist creator that pops up rather than trying to shove everything into the skinny panel".

## 1. Summary

- **A Music window** (D-960). The Sound group keeps a compact Now playing (the track's name, a read-only "Next:" line, Play or Pause, Skip, its bar) and an **Open music** button. On a computer it opens a large dialog, 1040 px wide: Library on the left, Now playing and Up next on the right. On a phone it opens a full-height sheet with two tabs, **Now playing** and **Library**. Not a floating window: everything the DM does in play stays in the panel beside the map.
- **Background sounds and effects stay in the panel** (D-961). They are played in time with the map, a few at once, and have no library or queue to manage.
- **A queue** (D-963, D-964). The run's order is the queue. **Up next** shows it and edits it: drag or keys to reorder, **Play now**, **Play next**, **Add to queue**, **Remove from queue**, a **Shuffle** toggle, **Previous** and a seek bar. Edits apply at once and name the run they were made against, so a late edit never lands on music another DM just started. Three new DM ops (`music.queue`, `music.jump`, `playlist.add`), one optional field on the run, op version 48 and snapshot version 38. Players' projection does not change: they still get only what plays now and the next track 10 to 20 seconds before it starts.
- **The playlist maker** (D-965) replaces the playlist page: a step of the Music window with the name, the tracks in order (drag and keys), search to add, Remove, Shuffle, Repeat, Crossfade and Play. It is a draft saved once, so making a playlist is one Setup step.
- **Library** (D-966): search and sort over playlists and tracks, and a More menu on each row with Play next, Add to queue and Add to playlist.
- **No art** (D-967): a tile with a plain tint from the name and the app's music icon.

## 2. Today (the audit, main e58995ac)

Shot as the DM with 100 music tracks, 4 playlists, 4 background sounds and 3 effects, Tavern night playing (3 of 12) and two background sounds: `01` to `03` and `08` at 1440 x 900 and 1280 x 720, `10` to `12` at 390 x 844, `17` at 320 x 568 at 130%, dark and light (13).

### 2.1 Every control in the DM's Sound panel

1. **Now playing**: track name, run line ("Tavern night · 3 of 12"), time ("0:01 / 3:16") over a bar, **Pause**/**Play**, **Skip to the next track**, **Stop the music**, **Repeat** (all, one, off). **Music volume for everyone**, each background sound's volume with **Stop <name>**, **Effects volume for everyone**, **Stop all sound**, the scene's sound line with **Play it**, **Use what's playing**, **Use silence**, **Clear**, and **Players see what is playing**.
2. **Music**: **Playlists** (each row opens its page, **Play <name>** beside it), **New playlist**, **Tracks** (every music sound, each row opens its page, **Play <name>** beside it), **Add music…**.
3. **Background**: a toggle per loop, **Edit**/**Done**, **Add background sounds…**.
4. **Effects**: **Built in** (5), the room's effects, **Edit**/**Done**, **Add effects…**.
5. **On this device**: Room sound, three volumes, Turn sound, Ping sound. The storage line.
6. **A playlist's page**: Name, the tracks with **Move <name> up**, **Move <name> down** and **Remove**, **Add tracks** (a checklist of every music track not in it, by name, then **Add N tracks** and **Cancel**), **Shuffle**, **Repeat** (All, One, Off), **Crossfade** (Off, 2 s, 5 s, 10 s), **Play**, **Delete playlist** on a second tap.
7. **A sound's page**: Name, Used as, its length, Listen here, Delete.

At 1440 x 900 the panel is 8,152 px tall with 237 buttons, the Tracks heading 1,199 px down and the Tracks list 5,699 px. At 390 x 844 the half sheet shows 444 px of a panel 8,035 px tall. The checklist of Add tracks runs about 5,200 px on a phone (`12`).

### 2.2 Taps

Counted with the Sound panel open. Opening it costs 2 more today and with Ambiance alike (on a computer More, then the panel, and on a phone Panels, then the panel). With the Music window the counts add **Open music** and, on a phone, the Library tab where the task needs it. "Typing" is the name or a search's letters.

| Task | Today | With the Music window |
|---|---|---|
| Start a playlist | 1 (its Play), under about 900 px of Now playing on a computer | 2 (Open music, its Play). Phone: 2 with nothing playing (the window opens on Library), 3 while music plays |
| Play a track | 1, after scrolling a 5,699 px list | 2 to 3, plus a search or a short scroll |
| See what plays next | Not shown. "3 of 12" only. Unshuffled: open the playlist's page and count down. Shuffled: no way | 0: the Sound group's "Next:" line. The whole queue: 1 (Open music), in view at 1440 x 900, 1280 x 720 and 390 x 844 without a scroll |
| Change the order | The live run: no way ("Changes apply the next time it starts."). A playlist: its page (1), then 1 tap a place (track 10 to place 2: 8), then Play again (1), which restarts the music: 10 | The live run: Open music (1), one drag. A playlist: Open music, its row, one drag, Save: 4 |
| Make a playlist of 10 tracks | New playlist (1), Name (1) and typing, Add tracks (1), 10 ticks, Add 10 tracks (1): 14 and typing, in 3 Setup steps, ordered by name | Computer: Open music, New playlist, Name and typing, 10 Adds, Create playlist: 14 and typing, in 1 Setup step, with search and drag. Phone: 16 |
| Add a track to a playlist | Its page (1), Add tracks (1), tick (1), Add (1): 4, through the whole checklist | From the track: Open music, its More, Add to playlist…, the playlist: 4 (phone 5). From the maker: its row, the search, Add, Save |
| Find one track among 100 | 0 taps, a scroll of up to about 6,900 px | Open music, the search and 3 or 4 letters (phone: Library too) |

The window costs one tap for a playlist start or a track and saves the scroll. Its gains are a queue the DM can see and change, search, drag order and one undo step a playlist.

## 3. Where the music lives (D-960, D-961, D-962)

### 3.1 The Sound group keeps

Ambiance's Sound group (panel-groups 4.1) in D-766's order, with Now playing's music block made compact:

1. **Now playing**: a 44 px tile (7), the track's name (16 px bold), its run line and a read-only line under it, "Next: Tavern theme" ("Next: this track again" whenever `following` names the playing track's own place, under Repeat one or for a one-track run under Repeat all, and "Last track" with Repeat off on the last), then one row with **Pause** (**Play** while paused) and **Skip**, and **Open music** at its end, wrapping under them where the row is short, then the bar and "1:24 / 3:10". The track, the run line and the Next line all read `musicAt(music, sounds, serverNow)` and `following` (4.3). With no music: "Nothing is playing." or "N background sounds" (D-766) and **Open music**. Then **Stop all sound** while anything sounds, and the line for a DM device that plays nothing, as today. The Next line is the DM's: a player's Sound (PlayerSound.tsx) does not change.
2. **Effects**, unchanged.
3. **What players hear**, unchanged: Music volume for everyone, each background sound's volume with its Stop, Effects volume for everyone, the Scene sound row with Use what's playing, and **Players see what is playing**.
4. **Background**, **On this device** and the storage line, unchanged. **Music** (Playlists, Tracks, New playlist, Add music…) leaves the group for the window, and so do the playlist page and a music track's page. Background's and Effects' sound pages stay.

**With the server's switch off** the group shows today's off state (the off line, Effects, On this device): no Now playing and no Open music, since nothing can play a file (sp-9).

**Stop the music** and **Repeat** leave the group for the window, as the brief asks. The owner saw four buttons there in the panel-groups preview, so the coordinator tells the owner (13). The music's volume and the names switch show in both places, one setting each.

### 3.2 The window

- **Computer** (layout width 600 px and up): the shared `Dialog`, `width` 1040 (`theme.layout.dialog.xl`, new), its height `min(100% - 32 px, 760 px)` as an editor's: 1040 x 760 at 1440 x 900, 1040 x 688 at 1280 x 720 (`09`). Modal: the map dims and takes no input while it is open, and Escape, the close button or a click beside it closes it.
- **Phone** (under 600): a full-height sheet, the new `Dialog` shape `phone: "tall"`: a bottom card as tall as the screen less its top inset and 12 px, so a strip of the room shows above it. It keeps the bottom card's grabber and its swipe down to close, which a slider and a drag handle never start (`lib/sheetSwipe.ts` `ownField` and `touch-action: none`). Its header takes PS-B's `controls` as every Dialog sheet does (panel-size 5.3): on a device with a fine pointer, Down ("Put away sheet") and no Up, since it has no full stand. Android's Back steps back from the maker or a track's page, then closes it.
- **Open music** opens it on Now playing while a run exists (paused too), else on Library. Its open state and the maker's draft live in a Room scope slot (`musicWindowSlot`, features/sound/music/open.ts), so crossing 900 px, which remounts the panel, keeps both. It opens with focus on its title and gives it back to Open music on close.
- **Why a dialog, not a floating window.** The map needs the DM's hands during play, and what play needs stays in the panel beside it: Pause, Skip, the Next line, the volumes, Stop all sound, Effects and Background. The window is for choosing and arranging music, a few taps between beats. A floating window would be the app's first non-modal window. It would cover the map it means to leave usable (a 400 x 600 window is a third of a 1280 x 720 map), compete with token panes, popovers and the side panel for the same space, need moving, resizing and a remembered place, and split the keys between itself and the map. The side panel already stays open beside the map, and Two panels can show Initiative over Ambiance.

### 3.3 Background and effects stay in the panel

Effects are fired in time with the map (a door, a trap, thunder), so they sit beside it, never behind a modal. Background sounds are a scene's mood, toggled in play, four at most, each with its volume. Neither has a library large enough to need search or a queue.

## 4. The Music window (D-962, D-966)

### 4.1 Layout

- **Wide** (the card 880 px and up, a layout width of 912 px and up): two columns that scroll each on its own. Left, Library (flexible). Right, 380 px with a border line: Now playing, Up next, then the music's volume and Players see what is playing.
- **Narrow** (under 880, phones and small windows): a `Segmented` row, **Now playing** and **Library**, under the header, then that tab's content. The window keeps the tab while open and starts by 3.2's rule.
- When wide, the body has no padding and does not scroll: each column scrolls. e2e/size.e2e.ts's dialog contract (one scrolling child of the card) gains this two-column case. Narrow, the body scrolls as every dialog's does.

### 4.2 Now playing

Top to bottom:

1. The tile (64 px, 48 px under 300 px of width) with the track's name and run line.
2. The seek row: "0:30", a slider and "3:16" in one row, times in tabular digits.
3. The transport: **Shuffle**, **Previous**, **Play** or **Pause** (an accent-filled 48 px circle), **Skip**, **Repeat**. Every button is 48 px, 4 px apart, in one row from 256 px of width and in two below it (Previous, Play, Skip, then Shuffle and Repeat).
4. A row with **Crossfade: 5 s** (a menu of Off, 2 s, 5 s, 10 s) and **Stop the music**.

With no music: "No music is playing. Pick a playlist or a track in Library."

- **Seek** sends `music.jump` to the playing track at the slider's place when a drag ends, and 400 ms after the last key (the slider's own keys), never during a drag. It names the run and the playing track it was made on (6.3). A pending seek is dropped when the shown track or the run changes before it is sent. Paused, it moves the paused place and stays paused.
- **Seek under Repeat one** (with a crossfade): the slider spans one pass, from 0 to the track's length less the crossfade, and its end label reads that ("0:50" for a 1:00 track with a 10 s crossfade), the compact block's time too. The last seconds of a pass sound only while the next fades in, and the time shown already reads the newest pass (`positionAt`), so a seek there could not be shown or kept. The server holds `ms` to the same bound (6.4).
- **Previous** goes to the start of the track once 3 seconds or more have played, else to the track before it in the order: under Repeat all and Repeat one the last after the first, with Repeat off the first's start. The client decides from what it shows and sends `music.jump` naming the run and the playing track. While a jump of its own is still pending, Previous treats the playing track as at 0 s, since a predicted jump's position reads the device's clock against the server's (PLR-35).
- **Shuffle** toggles the run's shuffle (6.4). **Repeat** steps as today. **Crossfade** sends `music.set` `fade`. **Skip**, **Pause**, **Play** and **Stop the music** send today's ops.
- sndfade's fades apply: a jump is a start, so it fades in over 2 s (D-950, D-954).

### 4.3 Up next

**Every list and row control derives from the track Now playing names**: `musicAt(music, sounds, serverNow)` on the client, as the reducer does at `t`, never the stored `index`, which moves only when a crossfade ends. So from `next.at` the incoming track is Now playing and leaves Up next, as `musicShown` and `playingAt` already treat it.

The heading **Up next** with "9 tracks · 26 min", then the order after the playing track, one row each: a drag handle, the name and length, and a More menu (**Play now**, **Play next**, **Remove from queue**).

- **Repeat all and Repeat one** (Skip wraps under both): under it "Then Tavern night plays again from the top:" ("Then the queue plays again from the top:" when the run's playlist is gone or there was none), and a second list, the order from its first track up to the playing track, without it. Repeat one's heading line adds "Repeat one plays this track again. Skip goes on to the next." Both lists are one order, numbered across both in play order (for a 3 of 12 run, "Move Tavern theme, 2 of 11" and "Move The Prancing Pony, 10 of 11"), and a row moves between them by drag or keys. The heading's "9 tracks · 26 min" counts the first list, the rest of this pass.
- **The lists' seam is one place.** The end of the first list and the top of the second are the same slot in play order. It is the order's end (`to: "passEnd"`), so a drop there renders under the first list. A row dropped there from the first list keeps "3 of 12". One from the second list, which sits before the playing track in the order, lowers the number by one ("2 of 12"), since the number is the playing track's place in the order. Keys step past it: Down from the first list's last row goes after the second list's first row, and Up from the second list's first row goes before the first list's last row.
- **Repeat off**: "Then the music ends.", then **Played**, the tracks before the playing one, rows with no handle and a More menu of **Play now**, **Play next** and **Remove from queue**. So every track the run holds has a visible row.
- With nothing after the playing track: "Nothing after this track in this pass."
- **Drag**: the handle only, so scrolling never moves a row, as the initiative tracker's (panels/TrackerPanel.tsx). The row lifts with the pane shadow and the others make room. A drop sends one `music.queue` `move`. The drag ends, sending nothing, when the order, the playing track or the run changes by value, checked on each frame and on each tick of the panel's clock (`useTicking`), since at `next.at` the playing track changes with no frame. Other changes to `playing` (a reveal, a volume, an effect) never end it. Escape puts the row back and ends it.
- **Keys**: the handle is a button named "Move Tavern theme, 2 of 11" ("of 9" under Repeat off, which numbers Up next alone), described "Drag, or press Up or Down." Up and Down move it one place in play order, across the two lists under Repeat all and one. Home moves it to the first place, End to the last, sent as `to: "first"` and `to: "last"` and resolved at apply time (6.4). Each press is one op, focus stays on the handle, and a polite status says "Tavern theme is now 1 of 11."
- The playing track has no row here. It is Now playing, and it cannot be moved or removed.

### 4.4 Library

- **Search music** (`type="search"`) filters playlists and tracks as typed, by name, ignoring case and accents. **Sort: Name** is a menu of Name, Longest first and Shortest first for Tracks, kept per device (`rvtt.musicSort`). Playlists stay by name.
- **Playlists** with its count and **New playlist** at the heading's end, which wraps under it on a narrow width. Each row: tile, name, "12 tracks · 41 min", opening its maker, then D-951's Play or Pause, then More: **Play next**, **Add to queue** (both while a run exists, each with the playlist's tracks, the playing one skipped), **Edit playlist**. The playlist playing wears the chosen tint.
- **Tracks** with its count, "3 of 100" while searching. Each row: tile, name, length, D-951's Play or Pause (Play starts it alone, as Tracks' Play does today), More: **Play next** (disabled on the playing track's row with "Playing"), **Add to queue** (disabled with "In the queue" while it is still to come), **Add to playlist…**, **Rename or delete…**. Then **Add music…** and the storage line. No match: `No track matches "harbor".`
- **Add to playlist…** opens a menu of playlists by name, one that holds the track disabled with "Already in it", one with 100 tracks disabled with "100 tracks", then **New playlist with this track**, which opens the maker with it. A pick sends `playlist.add` (6.3), an append on the server, so two DMs adding at once both land. One Setup step, and a toast: "Added Harbor at dusk to Tavern night."
- **Rename or delete…** opens the track's page (today's SoundPage) as a step of the window, header back "Music". Its two refusals part ways (6.4): `busyRefusal` splits into `deleteRefusal` and `useRefusal`, each reading `musicAt` at `serverNow`. For a track only queued, Delete goes ahead and a change of use is refused. The playing track, the revealed next and a playing loop refuse both.
- Under 300 px of width a row drops its tile and wraps its title and detail.
- A guide link ends the Library: "Music in the DM guide" (`#the-music-window`).

## 5. The playlist maker (D-965)

A step of the Music window, header back "Music", titled with the playlist's name or "New playlist". It replaces PlaylistPage.tsx.

- **Wide**: Name, then a row with **Shuffle** (a pressed toggle), **Repeat** (All, One, Off), **Crossfade** (Off, 2 s, 5 s, 10 s) and **Play**, then two columns: **Tracks** ("12 tracks · 36 min") in order, each row a handle, name, length and Remove (×), and **Add tracks**: Search music and every music track not in it, each with **Add <name>**.
- **Narrow**: Name, then tabs **Tracks (12)** and **Add tracks**. Tracks holds the list, its total and the settings row. Add tracks holds the search and the rows.
- **Reorder** as Up next does (4.3), on the draft, Home and End included. **Add** appends, **Remove** takes out, and a track appears once.
- **A draft, saved once.** The footer has **Cancel** and **Create playlist** (new) or **Save**. Save sends one `playlist.update` with only the fields the draft changed, so another DM's change to another field stands. Create sends one `playlist.create`. Either is one Setup step. An empty name saves as "New playlist". **Play** saves first when the draft changed and sends `music.play` only once the save is answered, so a refused save never turns into a refused play. The draft lives in the window's slot (3.2).
- **Leaving with changes** (Cancel, Back, the close button, Escape, a swipe or Put away sheet): the status says "Throw away your changes?" (`DiscardQuestion`) and the same press again discards. The sheet's swipe springs back while the draft has changes (the dialog's draft registry).
- **Another device.** While the playlist plays: "Changes apply the next time it starts." (today's words). Its tracks changed elsewhere since the draft began (its `rev`) while the draft changed them too: "Another DM changed this playlist's tracks. Saving keeps your list." Deleted elsewhere: "This playlist was deleted on another device. Create playlist makes it again.", and Save becomes Create playlist.
- **Delete playlist** at the foot of the settings for a saved playlist, a second tap as today, with "It leaves 2 scenes' sound." when scenes name it.
- Up to 100 tracks: past it Add is disabled with "A playlist holds 100 tracks at most."

## 6. The queue (D-963, D-964)

### 6.1 What a queue means here

The queue is the live run's order (`MusicRun.order`), which today is fixed at its start. Up next shows it from the playing track on. Reading it costs nothing: the DM's projection already holds the whole run. **Editing** changes the run, so it needs ops. The owner asked for "a UI with the queue", like Spotify's, whose queue is edited, and a read-only list would leave "change the order" impossible for what plays, and Previous, Play now and the seek bar with nothing to send.

One order, not Spotify's two lists (a "Next in queue" played once ahead of the playlist): a run already loops its order under Repeat all, the reducer's helpers step one order, and two lists would double every rule of 6.4 and the tick.

### 6.2 State

```ts
// shared/sound.ts
export type MusicRun = {
  // ...as today
  /** DM only: Shuffle is on. The order was mixed when it was turned on or when the run started shuffled. */
  shuffle?: true;
};
export type QueueEdit =
  | { t: "next"; soundIds: SoundId[] }   // Play next: right after the playing track, in this order, the playing track skipped.
  | { t: "add"; soundIds: SoundId[] }    // Add to queue: at the end, the playing track skipped.
  | { t: "move"; soundId: SoundId; to: "first" | "passEnd" | "last" | { before: SoundId } }
  | { t: "remove"; soundId: SoundId }
  | { t: "shuffle"; seed: string }       // Shuffle on, mixed by a seeded generator so replay mixes alike. The seed is a run id's shape.
  | { t: "unshuffle" };                  // Shuffle off.
export function queueEdited(music: MusicRun, edit: QueueEdit, ctx: { sounds: SoundLengths; playlist: Pick<Playlist, "sounds"> | null }, t: number): MusicRun;
export function jumpedAt(music: MusicRun, run: string, soundId: SoundId, ms: number, sounds: SoundLengths, t: number): MusicRun;
export function seekBoundMs(music: Pick<MusicRun, "repeat" | "fade">, lengthMs: number): number;
export function seededShuffle<T>(items: readonly T[], seed: string): T[];
```

No new collection, no new stored setting. `order` keeps its bounds (1 to 100 ids, no id twice).

### 6.3 Ops

| Op | Fields | Undo |
|---|---|---|
| `music.queue` | `from` (the run it was made on), `edit: QueueEdit` (each `soundIds` 1 to 100, no id twice, `seed` the `runId` pattern) | none |
| `music.jump` | `run` (new), `from` (the run it was made on), `soundId`, `ms?` (0 by default), `on?: SoundId` (the playing track it was made on: Seek and Previous send it, Play now does not) | none |
| `playlist.add` | `id`, `soundId` | setup, "adding <track> to the playlist <name>", none when it writes nothing |
| `music.play` | gains `shuffle?: true` | none |

All three are the DM's: `forPlayer`'s FORBIDDEN list (shared/permissions.ts) gains them, displays send none, `namesSoundFile` lists them, and the quota refuses them as it refuses Play (none frees anything, actor.ts DELETIONS). shared/undoScope.ts marks the two music ops `none`, so they record no step and clear no Redo (D-261102-471), and `playlist.add` `setup`. server/rooms/undoLabels.ts `describeOp` names the music ops "changing the music". shared/reads.ts: the music ops read `keys.playing` and the sounds of the run's order and of `soundIds`, `unshuffle` also `keys.playlist(run.playlistId)`, and `playlist.add` its playlist and the sound it adds.

### 6.4 Reducer rules (shared/reducer/sound.ts)

Every music rule starts from `current = musicAt(playing.music, sounds, t)`, so an edit during a crossfade acts on the incoming track, which Now playing already names. `t = env.at + LEAD_MS`, as every sound op.

- **Guards.** No run: "Nothing is playing." (`SOUND_WORDS.nothingPlaying`). `from` not the current run's `run` (another DM played, skipped, resumed, jumped or started a scene since): "The music changed. Try again." A jump's `on` not the current playing track's `soundId` (a promotion since): "The music moved on. Try again." `on` names no `at`: the store predicts pending ops with the device's clock (client/state/store.ts `replayPending`, each pending op's `at` from `clock.now()`), so a predicted `now.at` never equals the server's, and a second Seek or Previous sent before the first is answered would always be refused. With `from`, which every jump, play, skip, resume and started scene renews, the `soundId` still catches a promotion and another DM's action. A tick never changes `run`, so a queue edit made before a promotion still applies, at `t`, to the track then playing.
- **`music.queue`**. Every id must be a music sound (`notMusic`). The result holds at most 100 ("The queue holds 100 tracks at most."). `index` becomes the playing track's place in the new order. Repeat one shapes the queue as Repeat all does, since Skip wraps under both.
  - `next` and `add` skip the playing track with no refusal and keep the rest in their order. `next` puts them right after the playing track, moving any already in the run. `add` appends those not yet in the run, and under Repeat off also moves to the end any already heard (at or before `index`), so they play again. Those still to come stay where they are.
  - `move`: the playing track refuses with "The playing track stays in the queue. Skip it or stop the music.", an id not in the order with "That track left the queue.", and a `before` naming the moved id or no id of the order with the same. `to: "first"` is right after the playing track at `t`, so Home on a later row while the first row promotes still lands first. A moved row that itself became the playing track refuses as the playing track. `to: "passEnd"` is the order's end (the lists' seam, 4.3). `to: "last"` is just before the playing track under Repeat all and one (the end of the cycle) and the order's end under Repeat off.
  - `remove`: the playing track refuses as `move` does.
  - `shuffle`: under Repeat all and one every id but the playing one is mixed, which keeps its index, so "3 of 12" stays. Under Repeat off only the ids after it, so nothing heard comes back. `shuffle: true` is set.
  - `unshuffle`: the ids go back to their playlist's order (the run's `playlistId`, while that playlist exists), ids not in it after them in their present order, under Repeat off only those after the playing track. `shuffle` is removed. With no playlist only the flag goes.
  - **Writes nothing**: Shuffle on while on, Shuffle off while off, `remove` of an id not in the order, `add` whose every id is already still to come, `next` whose ids are only the playing track, and a `move` to where it already is, as `loopStop` writes nothing for a stopped loop. So a second DM's stale press undoes nothing.
  - **Then `next`.** Paused, the run keeps no `next`, as today. Playing, `next` is dropped and placed again by `withNextAt` (shared/sound.ts, exported now) with `wasRevealed` set when a `next` was revealed: the track `following` names now, at the same crossfade start, never before `t`. So an edit inside the reveal window swaps the revealed track at once, and an edit before it reveals nothing early.
- **`music.jump`**: the id must be in the order ("That track left the queue."). `ms` is held to 0 to `seekBoundMs` less 1 s: the track's length, or under Repeat one with a crossfade one pass (the length less the crossfade, `occurrencesAt`'s period), so a seek always places a single first occurrence. Under a new `run`, `index` is its place and `now` is `{ soundId, at: t - ms }`, `next` dropped and placed again if due (`withNextAt`, `wasRevealed` false). A paused run jumping to its own track stays paused at `ms` (a seek), and a later resume places it there. Any other jump plays.
- **`playlist.add`** (Setup): appends the track when the playlist does not hold it, a music sound (`checkTracks`). At 100: "A playlist holds 100 tracks at most.", nothing added. Already in it: writes nothing and records no Setup step. It replaces no list, so it loses no other DM's addition.
- **`music.play`** with `shuffle` stores it on the run (`startedRun` builds the run afresh and adds it). **`sound.scene`** sets the run's `shuffle` from the scene's music only on a run it starts, never on one that plays on (`sameMusic`), and only for ops of version 48 or later, an absent version taking today's rules (`env.opVersion`, as `clockTicks` reads it). "Use what's playing" (features/sound/panel/state.ts `sceneSoundFrom`) reads the run's `shuffle`, not the playlist's. It still saves the run's playlist, or its playing track when it has none, never the queue's edits, since a scene's sound names a playlist or one track (D-261102-472). The guide says so.
- **Deleting a queued track** (`sound.delete`, no step, version 48 on): read and written through `musicAt(playing.music, sounds, t)` like every music rule, so during a crossfade the incoming track is the playing one, and the run it writes keeps `order[index]` on `now`. A sound that sits in that run's order but is neither the playing track nor the revealed `next` leaves the order (`index` kept on the playing track) in the same op, and the delete goes ahead with no stop. The playing track still refuses ("This track is playing. Skip it or stop the music first."), and so does the revealed next ("This track plays next. Take it out of Up next first."). Before 48 the refusal stands, which replay meets only for ops refused live, never stored.
- **A change of use** (`sound.update`, Setup) of a track in the order is still refused, since no Setup op writes `playing` (D-261102-471): "This track is in the queue. Take it out under Up next first.", pointing at a row Up next always shows (4.3).
- **Ticks** (`soundStep`, `sys.sound`) carry the run whole, `shuffle` included, and change nothing else. No pass reshuffles (6.7).
- **Shape checks**: `musicRunSchema` (shared/protocol.ts) gains `shuffle: z.literal(true).optional()`, which `sys.sound`, the state schema and import share. Nothing else changes: `index` in `order`, no id twice, at most 100.

### 6.5 Versions and replay

- **Op version 48**, after AR-A's 47. Its step is the identity: `music.queue`, `music.jump` and `playlist.add` are new op types and `music.play`'s `shuffle` a new optional field, so no stored op changes shape. Two rules are gated on it, by the stored version in the envelope (persistence.ts passes it): `sound.scene`'s `shuffle` and the delete of a queued track. Its comment follows step 45 to 46's: back up the database just before, reload open pages, a rollback needs the backup for a room with version 48 ops after its last snapshot or a v38 snapshot.
- **Snapshot version 38**, after AR-A's 37, an identity step: `MusicRun.shuffle` is optional and absent reads as off, and the number moves so that an older build, whose strict schema refuses the field, refuses the snapshot.
- **Replay** lands on the same state: each op is a pure function of the state, the op and `env.at` and `env.opVersion`. The shuffle's randomness is the op's `seed` through `seededShuffle` (a small hash and a 32-bit generator in shared/sound.ts), never `Math.random`, and a golden test pins its output for fixed seeds. A stored pre-48 `sound.scene` of a shuffled scene replays with no flag, from a snapshot before it and against a snapshot after it alike. Ticks store their concrete result, as today. The store predicts the DM's ops (client/state/store.ts `replayPending`), so a predicted shuffle equals the confirmed one whenever the predicted and the confirmed state agree on the order and the playing track, which the seed makes so.
- Export and import: unchanged. An import sets `playing` to null.

### 6.6 Every device's projection, and privacy

| Viewer | The run | Tests |
|---|---|---|
| DM, co-DM | whole: `order`, `index`, `shuffle`, `playlistId`, `paused` | project.sound.test |
| Player, table display, View as a player | `{ run, repeat, fade, now, next? }` only (shared/project.ts `playersMusic`, an allow list, so `shuffle` never reaches them), null while paused and behind a blackout | project.sound.test, project.sound.random.test, sound.itest |

- **Before the reveal window** an edit gives players nothing: their projection is unchanged, so fan-out sends them no frame at all (server/rooms/fanout.ts skips a connection whose diff is empty), and no other track's id or asset.
- **Inside it** an edit that changes the following track swaps `next` to the new track at the same start: players get the new sound's `id`, `assetId`, `ms`, `level` and `use`, never its name, and the old next leaves `soundsNamed` and `visibleAssetIds`, so its file answers 404 to them again. The engine needs no change: its voice plan is keyed by sound and start (engine/voices.ts `musicVoices`), so a swapped `next` drops the old voice and plans the new one, and the playing track keeps its key. A file that loads late starts late from its place (D-940).
- **Accepted:** each swap inside the window gives players the id and asset of a track that stays in the queue and may play later, which `MusicRun.next`'s rule "a player holds no later track" did not foresee. It carries no name, a player's device loads it only within the window, and the DM caused it. Noted, not blocked.
- **A jump** is a new run, placed as a resume is, so players join at its place.
- **Tests:** project.sound.test runs each `QueueEdit` and a jump before and inside the window: a player's projection holds no `order`, `index`, `shuffle`, `playlistId` or `paused`, a `next` only inside the window and only the track `following` names. project.sound.random.test adds edits and jumps to its sequences: a player's `next` is never more than 20 s before its start. sound.itest: Pat gets no `ev` for a Play next before the window, one naming the new next's sound and not the old one's inside it, and the old next's asset answers 404 to Pat.

### 6.7 Costs, the likely choice, and the rejected options

- **Cost**: three op types and one field, two identity version steps with two gated rules, about 200 lines of reducer helpers with a property test, no engine change, no projection code (tests only), Up next's edits in the client.
- **The owner's likely choice**: editing, Spotify-like, applied at once (the owner's words name the queue and "player-like").
- **Rejected**: a read-only Up next (the live order still cannot change, and Previous, Play now and seek have no op), Spotify's second "Next in queue" list (two orders under every rule, the tick included), order-shaped ops that send the whole new order (a tick between the DM's view and the op makes the edit act on the wrong track), edits with no `from` (a late edit lands on music another DM just started), locking a revealed `next` (a rule to explain before every track), a new run for each edit (every device would seek the playing track), deferring an edit made during a crossfade until it ends (it would act on the outgoing track Now playing no longer names: an edit then ends the outgoing track with the 0.3 s fade, as `music.set` does today, which the guide says), reshuffling each pass (the step functions skip whole passes arithmetically), a server-decided Previous (`music.previous`, a third music op for what one jump does), `Math.random` in the reducer (replay and the store's prediction would differ), the seek's requested occurrence stored on the run (a new field for seconds that already sound in the crossing), taking a queued track out of the order on a change of use (a Setup op would write `playing`, D-261102-471, so Up next keeps a row for every queued track instead), a revision guard with a retry for Add to playlist (an append cannot conflict), a toast in place of moving heard tracks on Add to queue under Repeat off (the track would never play), `on` with the playing track's `at` (the store's prediction uses the device's clock, so Previous twice within a round trip would be refused), disabling Seek and Previous while an op that changes the run or its anchor is pending and then checking the gesture again (more client state than dropping `at`, and Previous twice would wait a round trip), one `busyRefusal` for delete and change of use (they now answer differently for a queued track).

## 7. Tiles, no art (D-967)

A tile is a rounded square filled with one of eight fixed tints chosen by a hash of the name, mixed at 38% into `surfaceRaised` (`color-mix(in oklab, …)`), with the app's `music` icon (tracks) or Lucide `list-music` (playlists, new, `queue`) at 42% of its size in the text color. Nothing else is drawn or generated. A name always gets the same tint, a renamed sound may change tint, and two sounds with one name share one. Sizes: 64 px in the window's Now playing (48 px under 300 px), 44 px in the Sound group, 40 px in Library rows from 300 px of width, none in Up next and the maker's rows. tile.test.ts checks the icon against each tint at 3:1 at least in both themes. Rejected: no tile (the window reads as a settings list, not a player), a letter (a generated mark that says little), a tint by sound id (two copies of one name differ), the member colors at full strength (they mark players).

## 8. Words

| Where | Words |
|---|---|
| The Sound group | **Open music**. "Next: <name>", "Next: this track again", "Last track". "Nothing is playing." or "N background sounds" (D-766) with no music |
| The window | Title **Music**. Tabs **Now playing**, **Library**. A step's title: the playlist's name, "New playlist", or a track's name, back "Music" |
| Transport | **Shuffle** (pressed while on), **Previous**, **Play** / **Pause**, **Skip to the next track** (or "Skip past <name>" in a crossfade), **Repeat all** / **Repeat one** / **Repeat off**, **Crossfade: 5 s** (menu Off, 2 s, 5 s, 10 s), **Stop the music**, **Seek** ("1:24 of 3:10") |
| Up next | **Up next** "9 tracks · 26 min", **Played**. More: **Play now**, **Play next**, **Remove from queue**. Handle "Move <name>, 2 of 11" ("of 9" under Repeat off), described "Drag, or press Up or Down.", then "<name> is now 1 of 11." The lines of 4.3 |
| Library | **Search music**, **Sort: Name** (Name, Longest first, Shortest first), **Playlists**, **New playlist**, **Tracks**, `No playlist matches "x".`, `No track matches "x".`, "No playlists yet.", today's "No music yet.". More: **Play next** ("Playing"), **Add to queue** ("In the queue"), **Add to playlist…** ("Already in it", "100 tracks", **New playlist with this track**), **Rename or delete…**, and a playlist's **Edit playlist**. "Added <track> to <playlist>." |
| Maker | **Name** (placeholder "Tavern night"), **Shuffle**, **Repeat**, **Crossfade**, **Play**, **Tracks (12)**, **Add tracks**, **Add <name>**, **Remove <name>**, **Cancel**, **Create playlist** / **Save**, **Delete playlist**, and 5's lines |
| Refusals | "The music changed. Try again.", "The music moved on. Try again.", "The queue holds 100 tracks at most.", "That track left the queue.", "The playing track stays in the queue. Skip it or stop the music.", "A playlist holds 100 tracks at most.", and 6.4's three delete and use lines, which replace `trackPlaying`'s "in the playlist that's playing". PL-0 adds every new line to `SOUND_WORDS`, which panel/words.ts and the split refusals read |

"Player" appears in no new UI word (D-962): in this app it means a person at the table ("Player view", "Players see what is playing").

## 9. UI checklist

- **Loading.** The window's chunk loads lazily with the panel's. Past 200 ms the shared indicator shows in the dialog's body, and a failed load says "Couldn't open music." with Try again (LoadFailed). Queue edits, jumps and Add to playlist show at once, since the store predicts the DM's ops (`replayPending`), and the engine plays only the confirmed state. A refusal puts a dragged row back with the refusal toast. D-951's row button changes the moment it is pressed. Save and Create show busy and refuse a second press until answered, and Play waits for the save's answer. Search and sort are local and instant. Add music… keeps its rows, percent and Cancel.
- **Keys and focus.** The window traps focus (`<dialog>`), opens on its title, closes on Escape and returns focus to Open music. A step moves focus to its title (`useStepFocus`). The tabs are a radio group. Handles take Up, Down, Home, End, and Escape during a drag (4.3), and keep focus. Menus are the shared Menu. New rows in the shortcut sheet (11.5).
- **Screen readers.** Up next, Played and the maker's tracks are ordered lists named "Up next", "Played" and "Tracks in order". The playing playlist's or track's row is `aria-current="true"`. Shuffle and Repeat use `aria-pressed` and Repeat's name says its state. The seek slider's value reads "1:24 of 3:10" and is not live. The Next line is plain text, not live. A keyboard move speaks through one polite status. The tile is `aria-hidden`.
- **Large interface sizes.** At 320 x 568 at 130% the window is the tall sheet, the transport takes two rows, rows drop tiles and wrap, headings wrap their button under them, and the maker's tabs carry the two lists (`17`, `18`, and the coordinator shots of 13).
- **Theme.** Every color is a token or a tint mixed into one. Light and dark are both shot.
- **Alignment.** Measured in the preview: 0 over 1 px on 46 new rows and blocks at 1440 x 900, 1280 x 720, 390 x 844 and 320 x 568, at 100% and 130% (13). Not measured: the Playlists heading's wrap at 320 x 568 at 130%, which was only re-shot after its fix. The sweep's `music-library` root measures it (11.4).

## 10. Cases

| Case | Expected | Test |
|---|---|---|
| Play next 30 s before the reveal, then the reveal | Pat gets no `ev` before it. At the reveal `next` is that track | project test, sound.itest |
| Play next 5 s before a revealed next starts | `next` swaps to it at the same start. Pat's old next file answers 404 | project test, sound.itest, voices test |
| Up next from `next.at` until the promotion tick | The incoming track is Now playing and not in Up next, Remove offers no row for it | client test |
| An edit during an A to B crossfade | B is promoted first, A fades over 0.3 s, the edit acts after B | reducer test, property test |
| Home on a later row as a tick promotes the first row | It lands right after the new playing track | sound.itest |
| A move of the first row sent as that row promotes | Refused: "The playing track stays in the queue. Skip it or stop the music." | sound.itest |
| Previous twice within a round trip, from 0:40 of track 3 | The first restarts track 3, the second goes to track 2, no refusal | sound.itest, mu-3 |
| Play, then Seek before the Play is answered | The seek applies to the new run | sound.itest, mu-3 |
| One queued track, neither playing nor next, on its page | Delete goes ahead. A change of use: "This track is in the queue. Take it out under Up next first." | panel test, sp-5 |
| A first-list row dropped at the end of Up next under Repeat all | It lands at the order's end, under Up next, "3 of 12" kept. Up from the second list's first row steps past the seam | client test, mu-4 |
| A second-list row dropped at the seam under Repeat all | It lands at the order's end, under Up next, and the line reads "2 of 12" | client test |
| A queue edit sent before and after another DM's Play, a seek before and after a promotion tick | Before: applied, then replaced by the Play. After: "The music changed. Try again." The seek after: "The music moved on. Try again." | sound.itest, both orders |
| Two DMs: move and remove one track at once, Shuffle off twice | The second remove writes nothing, the move refuses "That track left the queue.", the second Shuffle off writes nothing | sound.itest (two sockets) |
| Playlist Play next while one of its tracks plays | The others go right after it in the playlist's order, no refusal | reducer test |
| Remove or move the playing track | Refused in 6.4's words | reducer test |
| Add to queue past 100, and of a heard track under Repeat off | Refused, unchanged. The heard track moves to the end | reducer test |
| Shuffle on under Repeat all at 3 of 12, then off | Every other track mixed, still 3 of 12. Off puts the playlist's order back | reducer test, property test |
| Shuffle on under Repeat off at 5 of 8, and unshuffle after the playlist was deleted | Only tracks 6 to 8 mixed. Only the flag goes | reducer test |
| A stored pre-48 `sound.scene` of a shuffled scene | Replays with no `shuffle`, from a snapshot before it and against one after | migrate replay test |
| Seek to 0:59 of a 1:00 Repeat one track with a 10 s crossfade, playing, and paused then resumed | Held to 0:49, one occurrence, the bar reads "0:49 / 0:50". The resume plays from 0:49 | reducer test, mu-3 |
| Previous at 0:02 and 0:40 of track 3, and at 0:02 of track 1 under Repeat off and Repeat one | Track 2, track 3's start, track 1's start, the last track | client test, mu-3 |
| Delete a played track under Repeat off while track 4 plays, and delete the revealed next | The first leaves the order and the music plays on. The second: "This track plays next. Take it out of Up next first." | reducer test, sp-5 |
| Change the use of a queued track | "This track is in the queue. Take it out under Up next first.", its row in view | reducer test, panel test |
| Two DMs add a track to a 99-track playlist at once, and two to a 3-track one | 100 tracks and the second refused. Both added | reducer test, sound.itest |
| Make a playlist of 10 with search, reorder, Create, then Save of a renamed one | One `playlist.create`. Save sends `name` alone | maker test, mu-5 |
| Close the maker with changes, by X, Escape, Back, a swipe and Put away sheet | "Throw away your changes?", a second press discards, the swipe springs back | mu-5, mu-7 |
| A drag while a co-DM changes a volume, while the order changes, and across `next.at` with no frame | The first drag goes on. The other two end with nothing sent | client test, mu-4 |
| Search "harbor" among 100 tracks, then Longest first | 10 rows, "10 of 100", longest first, the sort kept after a reload | client test, mu-6 |
| The server's switch off | The Sound group's off state, no Open music | panel test, sp-9 |
| An older build loads a room with `shuffle` | Refused cleanly | migrate test |
| Phone 390 x 844: Open music, swipe down. A mouse on a narrow window | The tall sheet opens on Now playing and closes on the swipe, never from the seek slider or a handle. Put away sheet closes it | mu-7 |
| The window open while the browser crosses 900 px | It stays open on the same step, the draft kept | mu-8 |
| Every new screen at 4 sizes and 2 scales | Nothing over 1 px out of line | alignment roots |

## 11. Tests

1. **Unit and properties.** `shared/sound.queue.test.ts`: each `QueueEdit`, each refusal and each no-write, `next` placed again inside and outside the window and never before `t`, a paused run, `jumpedAt` and `seekBoundMs`, golden outputs of `seededShuffle`. `shared/sound.queue.random.test.ts` (fast-check, the queue's state machine): random ticks, edits, jumps, skips, pauses, resumes and `music.set` at random times, each edit made on a view a random lag behind. Invariants: the order holds no id twice and at most 100. `index` points at the playing track, which is in the order. `next`, when present, is the track `following` names and starts at or after the op's time. A shuffle keeps the same ids, and Repeat off's never moves a heard track ahead of the playing one. A repeated edit changes nothing the first did not. Many ticks equal one tick at the last. A player's projection never holds `order`, `index` or `shuffle`, and its `next` is never more than 20 s ahead. Reducer tests for `playlist.add`, the delete rule and the gated `sound.scene`. Reads, undo scope, undoLabels.sound.test.ts (the three labels), permissions (players refused, `namesSoundFile`), the schema, migrate (identity steps, the newer version refused, pre-48 replay), project.sound.test as 6.6. Client: `tile.test.ts`, `dragOrder.test.ts` (moves, both lists, Home and End, what ends a drag, Escape), the lists from `musicAt` across a crossfade before its promotion, the Next line, the maker's draft (dirty, discard, the changed fields alone), Library's filter and sort, Previous's rule, the pending seek dropped on a track change, the lists' seam, `deleteRefusal` and `useRefusal` for one queued track, a store test that a predicted shuffle equals the confirmed one, words.test.ts.
2. **Integration**: server/rooms/sound.itest.ts gains 6.6's frames and 404s, the two-DM and both-orders cases of 10, Previous twice and Play then Seek before an answer, concurrent `playlist.add`, a queue edit's replay after a crash, and a jump's tick.
3. **e2e.** New `e2e/music.e2e.ts`, lane prefix `mu-`: mu-1 Open music on a computer and a phone, its layouts and tabs, mu-2 Up next after Play next, Add to queue and Remove, mu-3 seek (Repeat one too), Previous (twice within a round trip), Play then Seek, Shuffle on and off, mu-4 drag and keys, mu-5 the maker, mu-6 search, sort, Add to playlist, mu-7 the phone sheet's swipe and Put away sheet, mu-8 a resize across 900 px. The files that move: `soundpanel.e2e.ts` (sp-1's heading list loses Music, sp-2 moves to the window, sp-5 deletes a played track and reaches the track's page through Rename or delete…, sp-7 checks the switch in both places, sp-9 no Open music), `soundupload.e2e.ts` (Add music… is in Library, line 448's `music` section), `e2e/size.e2e.ts` (the two-column case), `alignmentRoom.ts` (the playlist page's root becomes the maker). `sound.e2e.ts` drives ops and does not move. Run with `reach`, `ambiance` and the three alignment files.
4. **Sweep roots** (e2e/alignmentRoom.ts): the Sound group compact (playing, paused, nothing, the switch off), the window wide and both narrow tabs, `music-library` (the Playlists heading's wrap), Played under Repeat off, the maker wide and both narrow tabs, the More menus and Add to playlist's menu, a track's page step, an empty library and a search with no match, at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, plus 1280 x 720.
5. **The shortcut sheet** (client/state/shortcuts.ts): a new surface **Music** in `SURFACES` after "Initiative", with three DM rows, "Up, Down" ("Move the track one place"), "Home, End" ("Move the track to the first or the last place"), when "on a track's handle in Up next or a playlist", and "Escape" ("Put the track back") when "while dragging a track", device `keys`, with FEATURES.md's Shortcuts rows in the same commit (shortcuts.test.ts). Plain taps and drags add no rows. The seek slider uses the browser's own keys.
6. **The guide**: docs/dm-guide.md "Music and sound" gains `### The Music window` (#the-music-window), `### Up next` (#up-next) and `### Making a playlist` (#making-a-playlist), in guide voice, with a screenshot each. Its Now playing paragraph (today "Pause, Skip, Stop and Repeat", dm-guide.md:1751) says what the Sound group keeps and the Next line. It says that an edit during a crossfade ends the outgoing track at once, and that Use what's playing saves the playlist, not the queue's edits.
7. **Mutations**: remove the promotion before an edit, the `wasRevealed` placement, the never-before-t bound, the `from` and `on` guards (and `on` with an `at`, which must fail Previous twice), `to: "first"`'s resolution at apply time, the seam's `passEnd`, the delete rule's `musicAt`, one refusal for delete and use, the playing-track skip in `next`, each no-write, the 100 cap, the seed (use `Math.random`), Repeat off's rules, unshuffle's playlist order, `seekBoundMs` under Repeat one, the paused seek, `sound.scene`'s version gate, the delete rule, `playlist.add`'s append (replace the list), `playersMusic`'s allow list, the client's lists from the stored `index`, the drag's value comparison, and the maker's changed-fields Save. Each names the test that fails.

## 12. Lanes and files (D-969, amended)

**Order.** After AR-A (op 47, snapshot 37), lane sndfade, panel-groups lanes A to D, and panel-size PS-A and PS-B, on the newest stacked tip. Then PL-0, then PL-A and PL-B at once, then PL-D. PL-B runs mu-2 to mu-4 after rebasing on PL-A. One review for the stack.

| Lane | Owns | Size |
|---|---|---|
| PL-0, contract | shared/sound.ts (`shuffle`, `QueueEdit`, signatures), shared/protocol.ts (the three ops, `music.play`'s `shuffle`, `musicRunSchema`'s `shuffle`), shared/migrate.ts (both steps), shared/reducer.ts (dispatch to stub reducers that refuse, which PL-A fills), shared/reducer/sound.ts's `SOUND_WORDS` (every new line, so PL-A and PL-B read the same keys), shared/undoScope.ts, shared/reads.ts, shared/permissions.ts (FORBIDDEN, `namesSoundFile`), server/rooms/undoLabels.ts with undoLabels.sound.test.ts, client/features/sound/panel/ops.ts (`SoundOp`), client/components/Dialog.tsx (`phone: "tall"`, on PS-B's `controls`), lib/theme.ts (`dialog.xl`), components/Icon.tsx, shared/credits.ts and CREDITS.md (Lucide `skip-back` and `list-music`), features/sound/music/open.ts (`musicWindowSlot`). It typechecks alone | S |
| PL-A, rules | shared/sound.ts helpers and its stale comments (`order` "fixed at its start" and "never compared", `withNextAt`'s callers), shared/reducer/sound.ts (the three reducers, the gated `sound.scene` and delete, the new words, the comments that say a run keeps the order it started with), their tests, project.sound tests, the property test, migrate replay tests, server/rooms/sound.itest.ts | M |
| PL-B, the window | features/sound/music/ (new: MusicWindow.tsx, NowFull.tsx, UpNext.tsx, Library.tsx, Maker.tsx, tile.ts, dragOrder.ts, words.ts), features/sound/panel/SoundPanel.tsx, NowPlaying.tsx (the compact block and Next line), MusicSection.tsx and PlaylistPage.tsx (removed, their rows moved), SoundPage.tsx (its two refusal callers), state.ts (`sceneSoundFrom`, `busyRefusal` split into `deleteRefusal` and `useRefusal`), words.ts, panel.test.ts, features/ambiance/* (where lane A hosts the Sound group, for the slot and the window), client/state/shortcuts.ts with its FEATURES.md Shortcuts rows, a store test, e2e/music.e2e.ts, soundpanel.e2e.ts, soundupload.e2e.ts, e2e/size.e2e.ts | L |
| PL-D, sweep and docs | e2e/alignmentRoom.ts roots, the Library's guide link with client/features/guide/guide.test.ts, FEATURES.md's other lines, docs/dm-guide.md and its screenshots, design-v1-music.md's "Amended by" line and as-built, this note into docs/design/ with its README line | S |

**Files shared with other lanes.** With panel-groups lane A (which edits them first): SoundPanel.tsx, NowPlaying.tsx, PlayerSound.tsx (read only), panel.test.ts, words.ts, features/ambiance/*, soundpanel.e2e.ts (sp-1, sp-6), soundupload.e2e.ts. With panel-size: Dialog.tsx and the sheet's `controls` (PS-B), lib/theme.ts, Icon.tsx, CREDITS.md, shortcuts.ts and FEATURES.md (PS-A), each lane on its own lines. With lane D and PS lanes: alignmentRoom.ts.

**What changes for lane A: nothing in its plan.** D-952 stands. Two asks of its build: keep the Sound group's parts as separate components (Now playing's music block, Stop all sound and the device line, Effects, What players hear, Music, Background), so PL-B swaps one and removes one in small diffs, and keep What players hear's grouping with Players see what is playing. The heading's wording is the polish pass's (PLR-24).

## 13. The preview

Built on `e58995ac` in a throwaway workspace, with a throwaway Music dialog over the real Sound panel. Ambiance is not on main, so the compact Now playing shows in the Sound panel in D-766's order. Queue edits, Shuffle and Previous are local to the prototype and send nothing. The maker's Save is not wired. Not in the shots, added in the second draft: the Next line, the Played list, Play next's "Playing", Put away sheet.

Shots: the `music-player-preview` screenshots folder, `<nn>-<screen>-<before|after-v2>-<computer|phone>-<dark|light>.png`. The `after` files without `v2` are a first pass, superseded. The coordinator also shot 390 x 844 and 320 x 568 at 130% and 1440 x 900 at 130%.

**Shown to the owner first (12):** `01-panel-before-computer-dark`, `01-panel-after-v2-computer-dark`, `02-player-after-v2-computer-dark`, `04-track-menu-after-v2-computer-light`, `05-drag-after-v2-computer-light`, `06-maker-after-v2-computer-dark`, `10-panel-before-phone-dark`, `10-panel-after-v2-phone-dark`, `11-now-after-v2-phone-light`, `13-library-after-v2-phone-dark`, `16-maker-add-after-v2-phone-dark`, `12-addtracks-before-phone-light`.

**Found in the preview, folded into the design:** a 56 px Play beside 44 px buttons broke the row rule (all five are 48 px). Times under the seek bar measured as a broken row (they sit beside it). Up next fell below the fold on a computer (the volume and the names switch moved after it). The maker's footer wrapped three buttons on a phone (Play moved into the settings). At 320 x 568 at 130% the Playlists count slid under New playlist and tiles cut names (headings wrap, rows drop tiles under 300 px). For the visual design pass: playlist rows wear the raised card look beside plain track rows, Stop the music's square icon reads as a checkbox (PLR-23).

## 14. Decisions

- **D-261102-960, the window**: a Music window opened by Open music from the Sound group: a 1040 px dialog on a computer, a full-height sheet (`phone: "tall"`, with PS-B's Put away sheet) on a phone, its state in a Room scope slot. Rejected: a floating window (the app's first non-modal window, covering the map it means to free, competing with panes and popovers, needing move, resize and a remembered place), the player in the side panel, Two panels' lower pane (still 360 px), a page of its own, the `fill` shape on a phone (no grabber, no swipe), the panel's sheet filled.
- **D-261102-961, what stays** (amended): the Sound group keeps a compact Now playing (Play or Pause, Skip, the bar, Open music, and a read-only "Next:" line for the DM), Stop all sound, Effects, What players hear, Background, On this device and storage, and with the switch off today's off state with no Open music. The library, the playlist page, music tracks' pages, Stop the music and Repeat move to the window. The music's volume and the names switch show in both. Rejected: background and effects in the window, Stop and Repeat kept in the group, the names switch in the window only, no Next line (the DM would open a modal during play to see what comes).
- **D-261102-962, the words**: "Music", "Open music", "Now playing", "Library", "Up next", "Played", "Playlists", "Tracks". No new UI word says "player". Rejected: "Open player" and "Music player" (a player is a person at the table), "Queue" as the heading.
- **D-261102-963, the queue** (amended): the live run's order is the queue, shown from the track Now playing names (`musicAt`), with the rest of the cycle under Repeat all and one and a Played list under Repeat off, and edited at once: Play now, Play next, Add to queue, Remove, move by drag and keys, Shuffle, Previous and seek, a revealed next swapped in place. Deleting a queued track that is neither playing nor next takes it out of the order. Rejected: read-only, Spotify's second list, locking a revealed next, a new run for each edit, rows from the stored `index` (the incoming track shows twice in a crossfade), taking a track out on a change of use (a Setup op would write `playing`).
- **D-261102-964, the ops and versions** (amended twice): `music.queue` with command-shaped edits applied at `t` and `to: "first" | "passEnd" | "last"` moves resolved then, `music.jump` for Play now, Previous and seek, both naming the run they were made on and a seek or Previous the playing track's `soundId` (never its `at`, which the store's prediction cannot match), refusing with words on a mismatch, edits that change nothing writing nothing, `playlist.add` as an append, `music.play`'s `shuffle` and `MusicRun.shuffle`, op version 48 and snapshot 38 after AR-A, `sound.scene`'s flag and the queued delete gated on 48. Repeat one shapes the queue as Repeat all does, and a seek under it is held to one pass. Rejected: order-shaped ops, unguarded edits, `on` with an `at`, disabling Seek and Previous while ops are pending, `music.previous`, `Math.random`, reshuffling each pass, shuffling heard tracks under Repeat off, sharing a version step with AR-A, storing the seek's occurrence, a revision guard for Add to playlist.
- **D-261102-965, the maker** (amended): a step of the window, a draft saved once (Create playlist or Save, one Setup step, Save sending only the changed fields), drag and keys, search to add, Play saving first and playing once the save is answered, Delete playlist inside, the discard question on leaving with changes. Rejected: a second dialog stacked over the window, saving each change, the checklist, a separate Save and play button, a Save of every field (it undoes another DM's change to another field).
- **D-261102-966, the library** (amended): search, sort kept per device, More menus with Play next (disabled on the playing track), Add to queue, Add to playlist… (an append) and Rename or delete…, Play on a track starting it alone. Rejected: sort by date added, Play inserting into the queue, filters by playlist.
- **D-261102-967, the tiles**: eight fixed tints by a hash of the name with the music or list-music icon. Rejected: no tile, letters, tints by id, member colors at full strength.
- **D-261102-968, keys and Previous** (amended): a handle takes Up, Down, Home, End, and Escape during a drag, in a new "Music" section of the shortcut sheet. Previous restarts the track once 3 seconds have played, else goes back one, the same under Repeat all and one. The seek slider keeps the browser's keys, sends once, and drops a pending seek when the track changes. Rejected: a key to open the window, Alt with the arrows, a Space pick-up mode, a seek on every slider step.
- **D-261102-969, lanes** (amended): after AR-A, sndfade, panel-groups A to D, PS-A and PS-B, PL-0 (which typechecks alone), then PL-A and PL-B at once (B's queue e2e after A), then PL-D. Lane A's plan does not change. Rejected: building before lane A or panel-size, one lane for everything.

## As built

Lane PL-0, the contract:

- **Refusals by key** (D-261106-007). The queue's helpers in shared/sound.ts throw a `MusicRefusal` that names a key, and the reducer refuses in `SOUND_WORDS`' words for it, so each helper still returns a plain `MusicRun`.
- **Icons** (D-261106-008). `previous` draws Lucide `skip-back` as one path, and `queue` draws Lucide `list-music`.
- **The window's slot** (D-261106-009) keeps the maker's draft with the playlist it began from, its `rev` included, and a new playlist's id chosen as its draft begins, so a Create sent twice makes one.
- **The tall sheet** needed no wiring of its own: Dialog's bottom card already passes PS-B's `controls` with no full stand, so it shows Put away sheet and no Expand sheet.
- **Reads.** Shuffle off reads the run's playlist only while the view holds it, so a Shuffle off that only clears the flag, after the playlist was deleted, still predicts.

Lane PL-A, the rules:

- **The refusals' words** (6.4). A delete and a change of use refuse in three lines, by where the music holds the track: "This track is playing. Skip it or stop the music first.", "This track plays next. Take it out of Up next first." and "This track is in the queue. Take it out under Up next first." Before version 48 a delete of any track in the run is refused as it was, in those words. "Stop the music first: this track is in the playlist that's playing." is gone.
- **A change of use** (D-261106-011) is refused on the stored run, with its words read through `musicAt`. Reading the run itself through `musicAt` let a change through on a run that had ended but was not yet stored, which the fan-out property test caught.
- **A paused seek** takes the jump's new run (D-261106-010). A delete as the schedule ends the run writes it ended (D-261106-012). A move to before the playing track is allowed (D-261106-013). The property test's 20 s check covers every edit and jump that gives players a new next or keeps a start they already hold (D-261106-014).
- server/rooms/stateSchema.ts's note on a run's order follows the queue.

Lane PL-B, the window:

- **Keys and the seam** (D-261106-015). Up and Down walk play order and step over the seam, and a drop at the seam sends `passEnd` from either list.
- **A More item that cannot act** is off with its note, such as "Playing" or "In the queue" (D-261106-016).
- **A playlist deleted on another device** is made again under a fresh id by Create playlist, so an undo of that delete never meets it (D-261106-017).
- **A search** counts "10 of 100" beside Tracks while it narrows the list (D-261106-018).
- **Delete playlist** sits at the maker's foot in both layouts (D-261106-019). The maker's Add tracks rows use Up next's track line, their words at the column's edge, and Cancel and Save wrap as one.
- **A swipe down or Put away sheet** with changes in the maker springs back (D-261106-020).
- **Files** (D-261106-021). features/sound/music/ also holds parts.tsx (the list heading, the handles, More and the choice menus), jumps.ts (the window's jumps still waiting for an answer, which Previous reads) and MusicWindowHost.tsx (the window's own chunk). The tiles' tints are the theme's eight member colors, by name.
- **Add to playlist's toast** waits for the server's answer (D-261106-022).
- **The seek** is held on the client too, to the bound less a second, and sent 400 ms after the slider's last key (D-261106-024).

Lane PL-D, the sweep and the docs:

- **The sweep's roots** (11.4) are e2e/alignmentRoom.ts's pld-a to pld-c, which alignment-icons.e2e.ts runs first in its room, before any sound exists, so the empty library is a real one (D-261106-025). Each root is measured dark and light, at 1440 x 900, 1280 x 720, 390 x 844 and 320 x 568, at 100% and 130%. The wide window is measured as its header and its two columns, each a root of its own, since the one-row rule would compare the middles of two regions that scroll apart, and under 300 px Library's rows are measured one by one, as music.e2e.ts mu-9 measures them. The size sweep's playlist page root is the maker now, and its upload in progress is under Library's Add music.
- **A menu item that is off** draws its note dim with its title (components/Menu.tsx), which the sweep found on Add to queue's "In the queue" and Add to playlist's "Already in it" (D-261106-026).
- **Library's guide link** is the panels' small Guide link at its foot, named "Music in the DM guide" (D-261106-027).
- **The guide's pictures** come from scripts/guide-music.ts, which takes sound-panel.webp again for the compact Now playing. Up next's picture is a phone's (D-261106-028). The guide's three sections close Music and sound, after its general paragraphs (D-261106-029).

Lane musicfix, the build review's first round:

- **A drag's last place.** The dragged row's middle passes a row once it reaches that row's middle, going up or down, as the initiative tracker's drop does. So the drag's bound, the last row's middle, reaches the last slot in Up next and the maker. `dragAt` holds the bound and the slot together.
- **The seam before the last place** (D-261106-040). With the second list empty, or its only row moving, the seam is also the last slot, and a drop there sends `passEnd`. End with the second list empty sends `passEnd` too, where 4.3 says `last`, since `last` would put the track before the playing one.
- **The maker's tracks** (D-261106-041). Save and the status line read the draft's tracks and the base's without those no longer music, so a track deleted elsewhere is no change of this DM's, and a rename leaves another DM's list alone.
- **The maker's Play** (D-261106-042) starts the stored playlist, and the draft's new base is that playlist, so another DM's tracks, Repeat, Crossfade and Shuffle play. Lane musictap changed how it reads it (below).
- **The seek** (D-261106-043). A drag's start disarms a key's timer, a drag stays one until the pointer lets go though its seek is dropped, and a key no longer ends a drag. Only the release sends.

Lane musictap, the build review's later rounds:

- **A tap on a handle** drops nothing. A release drops the row only once the pointer has moved 4 px from where it went down, in Up next and the maker, so a tap on the second list's first row no longer sends `passEnd` (4.3).
- **The maker's Play** reads the playlist and the sounds from the room store as the save is answered, with nothing laid over them, so a save answered in one batch with another DM's append plays the appended track too (5).
- **A seek drag** under way when the run or the track changes is cancelled for the rest of that press: later input is ignored and the release sends nothing (4.2).

## Round 1 dispositions

A Codex reviewer (PLAYER-ASTRA) and a Claude reviewer (PLR), against `584fa7da`. Every P2 adopted. Each claim was checked in the code.

| Id | Fix |
|---|---|
| PLR-01 | 48 and 38 everywhere, after AR-A's 47 and 37. The "share one step" sentence is gone (6.5, 14) |
| PLAYER-ASTRA-01, PLR-02 | `sound.scene` sets `shuffle` only on a run it starts, gated on op version 48, absent taking today's rules. The no-new-branch claim is gone. A pre-48 replay test at both snapshot boundaries (6.4, 6.5, 10) |
| PLAYER-ASTRA-02 | A seek under Repeat one is held to one pass (`seekBoundMs`) on the slider and the server, its end label the pass. Playing and paused-then-resumed seeks tested (4.2, 6.4, 10) |
| PLAYER-ASTRA-03, PLR-04 | `next` and `add` skip the playing track after `musicAt`, no refusal, the rest in order, an empty rest a no-write. Library's Play next disabled with "Playing" (4.4, 6.4) |
| PLAYER-ASTRA-04, PLR-08 | Up next and every row control derive from `musicAt` at the shown server time. A client test across the crossfade before its promotion (4.3, 10, 11) |
| PLAYER-ASTRA-05 | Deleting a track queued but neither playing nor next takes it out of the order, gated on 48, no stop. A change of use cannot (a Setup op never writes `playing`), so Repeat off shows a Played list and every queued track has a row, which the refusal names. Both logged (4.3, 6.4, 6.7) |
| PLAYER-ASTRA-06, PLR-16 | `playlist.add`, an append, for Add to playlist, with concurrent and at-100 tests. The maker's Save sends only the changed fields, and Play waits for the save's answer (4.4, 5, 6.3, 6.4) |
| PLAYER-ASTRA-07, PLR-03, PLR-15 | `from` on both ops, `on` for Seek and Previous, refusals with words. `to: "first"` and `"last"` resolved at apply time, used for the first place, Home and End. A pending seek dropped on a track or run change. Both orders around a tick and another DM's Play tested (4.2, 4.3, 6.3, 6.4, 10) |
| PLR-05 | Shuffle on while on, off while off, a remove of a missing id, an add with nothing to add, a no-op move all write nothing. A move of a missing id refuses "That track left the queue.". A two-DM itest (6.4, 10) |
| PLR-06 | PL-0 owns undoScope, reads, FORBIDDEN, `describeOp` with undoLabels tests, the reducer dispatch with stubs, `musicRunSchema` in protocol.ts and `SoundOp`, and typechecks alone. PL-B owns its FEATURES.md Shortcuts rows, size.e2e.ts and features/ambiance/*, and runs mu-2 to mu-4 after rebasing on PL-A. PL-D owns guide.test.ts and the Library's link (12) |
| PLR-07 | All PL lanes after PS-A and PS-B. The tall sheet wires PS-B's `controls`: Put away sheet, no full stand. The coordinator amends panel-size's floating window bullet (3.2, 12) |
| PLR-09 | The timing note is gone: fan-out skips a connection with no change. sound.itest asserts Pat gets no `ev` before the window (6.6) |
| PLR-10 | The reveal-window id and asset stated as accepted (6.6) |
| PLR-11 | The second list excludes the playing track and numbers across both lists. End is `to: "last"`, the cycle's end (4.3, 6.4) |
| PLR-12 | Repeat one shapes the queue as Repeat all for shuffle, unshuffle, the lists and Previous (4.2, 4.3, 6.4) |
| PLR-13 | PL-A and PL-B list the stale comments and `busyRefusal`, PL-D the guide's line 1751 (8, 11, 12) |
| PLR-14 | Section 9 says edits show at once by the store's prediction. A store test of a predicted shuffle (6.5, 9, 11) |
| PLR-17 | With the switch off: today's off state, no Open music, sp-9 (3.1) |
| PLR-18 | The alignment claim says the Playlists wrap was only re-shot. The `music-library` root measures it (9, 11) |
| PLR-19 | A drag ends only when the order, the playing track or the run changes by value (4.3) |
| PLR-20 | The seed takes the `runId` pattern (6.2, 6.3) |
| PLR-21 | An edit in a crossfade ends the outgoing track with the 0.3 s fade: under rejected options and in the guide (6.7, 11) |
| PLR-22 | Add to queue under Repeat off moves a heard track to the end (6.4) |
| PLR-23, PLR-24 | The polish pass. Not changed here (12, 13) |
| The Claude reviewer's question | Adopted: a read-only "Next:" line in the DM's compact Now playing, no op (3.1) |

## Round 2 dispositions

Both reviewers agreed with every round 1 disposition and with the ASTRA-05 departure. Each new finding was checked at `584fa7da` (store.ts:479 and :894, SoundPage.tsx:81 and :93, state.ts:215, words.ts:151).

| Id | Fix |
|---|---|
| PLR-25, PLAYER-ASTRA-08 | `on` names the playing track's `soundId` alone, since the store predicts with the device's clock. `from` still catches another DM's action. Disabling Seek and Previous while ops are pending is rejected and logged. Previous twice within a round trip and Play then Seek are cases in sound.itest and mu-3 (6.3, 6.4, 6.7, 10, 11) |
| PLAYER-ASTRA-09 | `busyRefusal` splits into `deleteRefusal` and `useRefusal`, both callers in SoundPage.tsx updated, SoundPage.tsx given to PL-B. One queued track: delete goes ahead, a change of use is refused. The playing track, the revealed next and a loop refuse both (4.4, 10, 12) |
| PLAYER-ASTRA-10, PLR-31 | The success case is Home on a later row as the first row promotes. A move of the row that itself promotes is refused (6.4, 10) |
| PLR-26 | The delete rule reads and writes `musicAt(…, t)` (6.4) |
| PLR-27 | "Next: this track again" whenever `following` names the playing track's place (3.1) |
| PLR-28 | "of 11" under Repeat all and one, "of 9" under Repeat off. The heading counts the first list (4.3, 8) |
| PLR-29 | The lists' seam is one slot, the order's end (`to: "passEnd"`). Keys step past it, and a drop there renders under the first list (4.3, 6.2, 6.4) |
| PLR-30 | The drag-end check runs on each frame and each tick (4.3) |
| PLR-32 | PL-0 adds the new `SOUND_WORDS` keys (8, 12) |
| PLR-33 | `playlist.add` takes one `soundId`. An add that writes nothing records no Setup step. Its label is "adding <track> to the playlist <name>" (6.3, 6.4) |
| The Codex reviewer on PLR-14 | A predicted shuffle equals the confirmed one when both states agree on the order and the playing track, not by the seed alone (6.5) |

## Round 3 (consensus, folded in by the coordinator)

Both reviewers reached consensus on the third draft. Their P3s are folded into the text above, and there was no further round:
- PLR-34 with PLAYER-ASTRA-11: the Previous-twice case now starts at 0:40.
- PLR-35: while a jump of its own is pending, Previous treats the track as at 0 s (section 4).
- PLR-36 with PLAYER-ASTRA-12: the seam keeps "3 of 12" only for a first-list row. A second-list row lowers it, and has a case of its own.
