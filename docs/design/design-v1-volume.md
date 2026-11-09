# raccoon-vtt: volume on the top bar

Status: built (2026-11-08), from design draft 2 at review consensus (round 1, and the build notes of rounds 2 and 3 below), in lanes VOL-A (vola, the controls, storage and engine), VOL-B (volb, the speaker on the bar) and VOL-C (volc, the table display). Device only: no OP_VERSION or SNAPSHOT_VERSION step. Decisions D-261108-361 to 370 and 381 to 386, and the builders' D-261108-397 to 402, 405 to 411 and 417 to 420. Code is cited from `floors` (szxxtuyl, ff96039a). "As built" says where the build went its own way. The throwaway prototype behind every picture and number was bookmark `vol-proto`. Pictures: `screenshots/volume/` (001 to 015, 015 replacing 006).

## The owner's words

2026-11-08: "Rather than a global on off room sound setting buried in settings we should just implement a normal volume adjustment that is easy to access (maybe a dropdown from the top bar?). Open to ideas, Be sure to consider spacing concerns"

## 1. Summary

- **A speaker on the top bar**, for the DM and players, right of the DM's Now playing chip (D-261108-361). Its icon is this device's state: muted, low (under 50%) or loud.
- **It opens Volume**: one master level with a mute toggle at its start, then Music, Background and Effects, then Turn sound and Ping sound. A popover from 900 px, a card under 900 px, a sheet under 600 px, as Now playing's player. This device's Sounds and the Sound panel's On this device draw the same component (D-261108-366). The Room sound switch goes.
- **Mute is Room sound's stored "off"**, so nothing migrates. Volume is a new field of the stored mix, 100% at first, the level unmuting returns to (D-261108-363). Device only: no op, no OP_VERSION or SNAPSHOT_VERSION step.
- **It folds last**: after View, before the turn chip's name. Measured at 8 widths, 2 sizes, 3 bars, and in fights at 1024 to 1440 with the clock: it stays on the bar in every measured state but the DM's 320 x 568 phone at 130%, where **Volume** leads the DM menu and opens the same sheet (D-261108-362, 382).
- **The ask stays** on a player's device with no choice, its answers now Play here (unmute) and **Stay muted** (D-261108-365). Turn sound, a trap's sound and Ping sound play while muted and say so (D-261108-364, 381).
- **The table display's menu** trades Sound On/Off for **Volume**: Off, 25%, 50%, 75%, 100% (D-261108-368). **U** mutes and unmutes (D-261108-369).

## 2. Today

This device's Sounds holds **Room sound** (`rvtt.roomSound`: "on", "off", absent until a choice, read as on for a DM and off for a player until the ask), Music, Background and Effects while it is on (`rvtt.soundMix`, 80% each), then Turn sound and Ping sound (`RoomSoundControls`, features/device/ThisDevice.tsx:354). The Sound panel's On this device draws the same switch and sliders. Off means the page is not `enabled` (engine/SoundHost.tsx `soundEnabled`): it loads and plays nothing, releases the iPhone's audio session and leaves the one-page handoff. The media session's pause and play set it (engine/mediaSession.ts). The engine's gains are the device slider squared times the room's volume squared (engine.ts `#mix`). A display has its own On/Off (`rvtt.displaySound`) at full volume. Turn sound (`rvtt.sound`) also gates a trap's sound, on its own context (encounter/alerts.ts `playTrapSound`). The bar has no sound control for anyone but the DM's Now playing chip, which holds the room's volumes for everyone.

## 3. The speaker on the bar

- **Place.** Part `volume` in `TOP_BAR_ORDER` after `nowPlaying`, before `clock`: the room's sound then this device's, side by side, at the bar's own gap (12 px wide, 6 on a phone, 2 tight). For a player it leads the right-hand group, before Find my token. Not in View as a player (the preview plays nothing), not on the pause screen (a player's blackout hides the bar, Room.tsx:1115, and nothing plays there), not on a table display (section 7).
- **Look.** A 44 px square icon button in the bar's `IconButton` shape (Undo, Fit), text color, muted text color while muted. Icons: `muted` (Lucide volume-x), `volumeLow` (volume-1) under 50%, `volume` (volume-2, today's) from 50%. Two new Lucide icons in Icon.tsx, shared/credits.ts and CREDITS.md. While the page waits for a tap the icon stays as it is and the controls say so.
- **Opens.** From 900 px a dialog popover under it, body 340 px, as Now playing's. Under 900 px a card (440 px) from 600 px and a sheet below, through `ChipDialogs` `{ t: "volume" }`, so the folded row opens the very same. The bar rises over notices while the popover is open (`raiseFor.volume`).
- **Fit** (topBarFit.ts). `BarContent.volume` (a known role, not the preview), `BarShape.volume`. New steps: wide `... "tightGaps", "viewFold", "volumeFold", "turnName", "timerShort", "yourTurnOff", "eyeSlim"`, narrow `... "nowPlayingOff", "tightGaps", "viewFold", "volumeFold", "eyeSlim"`. So View and Floor fold into the Menu panel before it, and the fight's turn name gives way only after it. The WideStep and NarrowStep doc comments name the step.
- **Folded.** The DM menu's first section, after a blackout's items while one is on, is **Volume**: one item **Volume** with its value as the note ("80%" or "Muted"), on the one layout where the bar has no speaker (picture 015, D-261108-382). Time and Now playing stay last. A player's You menu has the same item before X-card…. Each opens the card or sheet in place, never This device (no jump rows). Search's DM-menu twins skip the kind, as Time and Now playing's (catalog/dm.ts `SearchedItemKind`): the search reaches the same rows in This device.
- **What the speaker costs** (tables in 10). Where the bar has room, 56 px of free space on a computer, 50 on a phone. Where it is full on a computer the room name gives way first, as the give-way already rules: at 1440 with music the DM's "Sunless Citadel" shows 58 of its 121 px. Then one more step where the name hits its 40 px:
  - Full screen at 1280 and 130%, and at 1280 in a fight.
  - At 1024 with the side panel and music (an iPad held sideways), the Now playing chip itself goes into the DM menu, a fair trade for a speaker in reach.
  - The DM chip's word at 1024, and at 640 and 130%. With music at 640 and 130%, the DM's Search icon goes to the Panels field.
  - A player at 900 loses Full screen and Floor's name, at 1024 in a fight Floor's name, and at 1440 and 130% and at 1280 in a fight Search's field becomes its icon.
  - View and Floor go to the Menu: the DM in a fight at 1024 and at 1280 and 130%, a player on his turn at 1024, and on phones a player at 390 and 130% and at 320.
  - On phones the DM's gaps tighten at 390 and the name shortens to 52 px. A player's Search icon goes to the Panels field at 390, and at 320 and 130% the player's chip shows its dot and caret only. The DM's 320 and 130% phone folds the speaker itself.
- **Fights.** In every measured fight (DM and player, the strip in the row with five, three or no faces, music and the clock, 1024 to 1440 at 100% and 130%) the speaker stays on the bar, so the order stands (table 10b). It folds only in chips-bar's worst case (a fight in a blackout with phases and a long name at 900 x 900 and 1170 x 900 at 130%), right before the turn name would. The prototype passes chips-bar unchanged (8 of 8, run in dvol), every other part as today.

## 4. The controls (`DeviceSound`)

One component, `client/features/sound/device/DeviceSound.tsx`, in four places: the speaker's popover, card and sheet (titled **Volume**), This device's **Sounds** group and the Sound panel's **On this device** (DM and player). The rows:

1. **A line** (`line` prop, VOL-OPUS-01), at most one, as help: a player's "The DM plays the sound on their own device." while Only DM devices play, else "Tap anywhere to start the sound." (unmuted, waiting), "Another window on this device plays the sound." or "This browser can't play the room's sound.". Drawn in the popover, card, sheet and This device, where it replaces `DmPlaysNote`. Not in the Sound panel, whose Now playing already says these (PlayerSound.tsx `PlayerNow`, NowPlaying.tsx `DeviceLine`), so no line shows twice.
2. **The grid** of today (`max-content | 1fr | 3.2em`, 44 px rows). The first row is the master: the **mute toggle** in the label column, the slider named **Volume** (0 to 100%, steps of 5), its percent. Then **Music**, **Background** and **Effects** as today. Muted, the master shows 0% ("Muted" to a reader) and the three keep their values and stay live. Only while the server's switch is "off", never while it is unknown or failed, Music and Background are hidden, since only the built-in effects play (D-261108-367, VOL-OPUS-13).
3. **The mute toggle's look** (VOL-OPUS-14, D-261108-385): a button, not a decoration like Table sound's speaker glyph before each slider (panel/controls.tsx:34). 44 px, `aria-pressed`, the bar's IconButton hover and pressed fill, and that fill held while muted, its icon as the bar's.
4. **Help**: on a player's device "This device only. At one table, the DM can turn on Only DM devices play in Sound. Music uses about 60 MB of data an hour, none while muted. On an iPhone it pauses other apps' music and plays even with the ringer off." (D-261108-384). On a DM device the second sentence is "Table sound, in Sound, sets the volumes for everyone."
5. **A rule**, then **Turn sound** ("A short chime on your turn and a trap's sound, even while muted. Android phones also vibrate.") and **Ping sound** ("A short tone when someone pings the map, even while muted."). Turn sound's help is one export (`TURN_SOUND_HELP`), also used by the Initiative panel's copy (panels/TrackerPanel.tsx:830).

This device's copy keeps the search anchors (`anchored`): `menu.this-device.sounds.volume` (new, replacing `.room`), `.music`, `.loops`, `.effects`, `.turn`, `.ping`. Its folded summary reads "Volume 80%" or "Muted". The Sound panel's copy carries no anchors and no line.

## 5. Mute, the stored setting and the engine

- **Mute** is `rvtt.roomSound`, its values kept: "off" muted, "on" unmuted, absent unmuted on a DM device and muted on a player's until the ask. Muted is today's off exactly: not enabled, nothing loads, the iPhone's audio session is let go, the handoff passes it by, voices stop with the short fade.
- **Volume** is a new field of `rvtt.soundMix`: `{ volume, music, loops, effects }`, `volume` 5 to 100, 100 at first, so every device sounds as today until someone moves it. A stored 0 or a bad value reads as 100.
- **The kept level** (VOL-OPUS-08). Never stored as 0. The kept level is the stored `volume` taken at the slider's pointerdown, or at its focus for keys, never the 0 a muted slider shows. A slider that reaches 0 mutes and keeps that level, so unmuting returns there. Pure `volumeStep(kept, value)`: 70, dragged to 0, then unmuted, gives 70. Muted with 70 kept, dragged to 30 and back to 0 in one drag, keeps 70. Left from 10 to 0 keeps 10.
- **Unmuting.** Raising the slider while muted unmutes and stores the level. A mouse's press is an activation, and a touch drag's release is the next one, which the armed unlock (lib/activation.ts) takes now that the setting wants sound, so the audio unlocks either way. The toggle and U call `setRoomSound(true)` (it resumes the context and blesses the pool inside the gesture) and set "off" to mute.
- **Engine.** `#mix` multiplies each channel's gain by `(volume / 100)²`, ramped over 0.3 s with the rest. A display uses its own level in place of `FULL_MIX`'s 100, and its engine subscribes to `rvtt.displayVolume` as a member's does to the mix (engine.ts:99), so a change while sound plays applies at once (VOL-OPUS-09). The test hook's `soundState` gains `mix`, the three channel gains, for the e2e steps.
- **Listen here** (engine/store.ts `listenHere`) plays a sound's page on this device even while muted, at the sound's own level, not scaled by Volume: it is the DM's own tap to hear a file (D-261108-383).
- **Media session.** Unchanged: pause mutes and play unmutes, at the kept level.
- **The ask.** Unchanged in when it shows. "Play here" unmutes and unlocks. "Not on this device" becomes **Stay muted**, which stores "off". Differs from the lean (D-261108-365): a player's device unmuted by default with the ask kept only for the browser's tap would start every phone at a shared table playing aloud at its first tap.
- **Versions.** Device only: nothing in shared/model.ts, protocol, migrate, the projection or the server changes, so no OP_VERSION or SNAPSHOT_VERSION step and no self-hosting note. An older build reads the mix and ignores `volume`, playing at 100%: rollback is safe.
- **Known residual** (VOL-OPUS-15, no fix). A tab of the old build left open after a deploy writes the mix without `volume` when its owner moves a slider there, and every window of the new build adopts that through the storage event, so Volume goes back to 100%. It needs a stale tab and a slider moved in it, and a reload of that tab ends it.

## 6. Where nothing plays

- **Only DM devices play**, a player's device: the speaker stays where it was, showing the device's own state. The controls' first line says "The DM plays the sound on their own device." Turn sound, a trap's sound and Ping sound still play (picture 012).
- **A blackout**: a player's pause screen has no bar and nothing plays. The bar comes back as it was. The DM's bar keeps the speaker, and the DM's device plays on.
- **The server's switch off**: the built-in effects still play, so the speaker stays, with Volume and Effects.
- **Another window plays**, or **the browser cannot**: the icon shows the device's state, and the line says why. The Sound panel's `DeviceLine` (VOL-OPUS-02): "off" shows "This device is muted." with an **Unmute** link button, "cannot" shows "This browser can't play the room's sound.", "other" shows "Another window on this device plays the sound.", and "plays" and "tap" show nothing there, as today.

## 7. The table display

Its menu's **Sound** row (DisplayRoom.tsx `SoundRow`) becomes **Volume**: Off, 25%, 50%, 75%, 100%, `menuitemradio`s at the TV's size (pictures 013, 014). Off stores `rvtt.displaySound` "off" and keeps the level. A level stores `rvtt.displayVolume` (25, 50, 75 or 100, 100 at first) and "on". The engine hears the level at once (section 5). The remote's arrows step through the choices as through the menu's other buttons, which a slider would trap. Only DM devices play keeps it silent with no words, as today. The menu's group labels (Text size, Weather, Volume) start 4 px in from the buttons' edge, an existing inset the new alignment check reports: the lane moves the label padding so all three meet the edge.

## 8. The key

**U**: "Mute", "Mute or unmute this device's sound", DM and players, in the sheet's Keys and FEATURES.md's Keys table together. U is free for every role, and a device that already bound U to another row keeps it, the new default becoming unbound there (`keysInEffect`). M, the usual mute key, is the DM's Pin, and a letter matches with Shift. A keydown counts as an activation, so U unmutes and unlocks in one press. Not on the table display, where any key opens its menu.

## 9. Words

- Speaker: name "Volume on this device: 80%" or "Volume on this device: muted". Tooltip "Volume", with U.
- Popover, card and sheet title: "Volume". DM menu section and item, You menu item: "Volume", note "80%" or "Muted".
- Mute toggle: name "Mute" with `aria-pressed`, tooltip "Mute" or "Unmute". Master slider: "Volume", value text "80%" or "Muted".
- Help, Turn sound and Ping sound: section 4. Lines and `DeviceLine`: sections 4 and 6. New: "This browser can't play the room's sound." and "This device is muted." with "Unmute".
- `TABLE_SOUND_HELP`: "What everyone at the table hears, set here for every device. Each device sets its own volume from the speaker on its top bar."
- `DM_ONLY_HELP` ends "Each DM device still plays unless it is muted."
- The ask: "Play here" and "Stay muted". This device summary: "Volume 80%" or "Muted". Search: setting "Volume" (names "mute", "unmute", "room sound", "sound on this device"), value "80%" or "Muted". search/words.ts:86's `mute: ["room sound"]` points at it. Music, Background and Effects entries lose their `when`.
- Display: "Volume", "Off", "25%", "50%", "75%", "100%".
- **FEATURES.md** (docs lane):
  - This device's Sounds bullet becomes "**Sounds**: **Volume**, this device's level for the music, background sounds and effects the DM plays, with a mute button at its start, then **Music**, **Background** and **Effects** (80% at first), **Turn sound**, which also plays a trap's sound, and **Ping sound**. Turn sound, a trap's sound and Ping sound play even while muted." Sub-bullets: "The top bar's speaker opens the same controls: a popover on a computer, a card under 900 px and a sheet on a phone. Its icon shows muted, low or loud.", "Volume starts at 100%. Taking it to 0 mutes, and unmuting returns the level it had.", "DM devices and table displays start unmuted. A player's device starts muted and asks once, the first time there is something to hear: Play here or Stay muted." (the ask's close lines kept), "Listen here plays on this device even while muted.", and "Layout: the speaker is a 44 px button right of the Now playing chip. As the bar fills it costs the room name first, then one step (Full screen, the Now playing chip at 1024 with the side panel, the DM chip's word, a player's Search icon, or View and Floor), and it leaves the bar only after View, on the DM's 320 px phone at 130%, for the DM menu's first row."
  - The give-way lines: :77 gains "View and Floor fold, the speaker leaves" after "View folds" in its order, :78 becomes "What leaves the bar is in the DM menu: Volume first, then Time, Now playing and the map's phases.", and :82's never-leave list stays without the speaker.
  - Sound: :1538's "Room sound, under On this device, starts "This device only:"" becomes "On this device holds this device's Volume, as the top bar's speaker does.", :1546's "as its own Room sound says" becomes "unless it is muted", :1612's "above Room sound, whose help names that switch" becomes "above Volume, whose help names that switch". Media controls: "Pause mutes that device, and play unmutes it." The display bullet: "Volume (Off, 25%, 50%, 75% or 100%, for this display only, …)". Keys table: "| U | Mute or unmute this device's sound | everyone |".
- **DM guide** (docs lane): in "What your players hear and see", "Each device sets its own volumes under **On this device** in Sound, or under **Menu**, **This device**, **Sounds**." becomes "Every device has its own volume: the speaker on the top bar opens it, with a mute button, the music, background and effects levels, and the turn and ping sounds. Press U to mute or unmute." "have each player answer Not on this device" becomes "have each player answer Stay muted". Line 1978's "**Room sound**, under On this device, turns the device's own playback on or off." becomes "**On this device** holds the same volume controls as the speaker on the top bar." Every guide picture of the top bar is retaken.

## 10. The fit, measured

Each cell: the speaker's place, the step it adds over today, the room name's width before and after (layout px, "Sunless Citadel" is 121), and free room left. Row px is the bar's row. DM bars on Tower, a scene of two floors, with music for the chip. Pat holds both floors.

| Width, size | Row | DM, music playing | DM, nothing playing | Player |
| --- | --- | --- | --- | --- |
| 1440, 100% | 1056 | bar, name 114 to 58 | bar, 116 free | bar, 169 free |
| 1440, 130% | 724 | bar, name 102 to 46 | bar, name 121 to 102 | bar, Search field to icon, name 53 to 121 |
| 1280, 100% | 896 | bar, name 121 to 94 | bar, name 121 to 77 | bar, 9 free |
| 1280, 130% | 601 | bar, Full screen out, name 74 to 66 | bar, Full screen out, name 74 to 66 | bar, name 121 to 70 |
| 1024, 100% | 640 | bar, chip into DM menu, name 57 | bar, DM chip to dot, name 73 to 57 | bar, name 121 to 109 |
| 1024, 130% | 764 | bar, 158 free | bar, 208 free | bar, 261 free |
| 900, 100% | 516 | bar, name 121 to 66 | bar, name 121 to 66 | bar, Floor name to icon, Full screen out, name 41 to 118 |
| 900, 130% | 668 | bar, 63 free | bar, 113 free | bar, 166 free |
| 768, 100% | 744 | bar, 138 free | bar, 188 free | bar, 241 free |
| 768, 130% | 567 | bar, name 121 to 82 | bar, 11 free | bar, 64 free |
| 640, 100% | 616 | bar, 10 free | bar, 60 free | bar, 113 free |
| 640, 130% | 468 | bar, Search icon to Panels, name 73 | bar, DM chip to dot, name 83 to 73 | bar, name 121 to 86 |
| 390, 100% | 366 | bar, tight gaps, name 70 to 52 | bar, tight gaps, name 70 to 52 | bar, Search icon to Panels, name 40 |
| 390, 130% | 276 | bar, name 101 to 55 | bar, name 101 to 55 | bar, View, Floor to Menu, name 40 to 68 |
| 320, 100% | 296 | bar, name 120 to 74 | bar, name 120 to 74 | bar, tight gaps, View, Floor to Menu, name 40 to 87 |
| 320, 130% | 222 | DM menu, name 47 | DM menu, name 47 | bar, name 60 to 40, chip 70 to 44 (dot only) |

**10b. In a fight** (VOL-OPUS-05). Goblin 1 at 20, Pat's Thorn at 19, four more goblins, so the DM's strip shows up to five next faces, no blackout. "Faces" is what the DM's strip shows, with or without the speaker. The DM's clock chip leaves early in every row, with or without the speaker, and a player's stays where it stood. At 1024 and 130% the layout is a phone's and the strip is in the band.

| Width, size | DM | DM, music, clock | Player, the strip in the row | Player, his turn, clock |
| --- | --- | --- | --- | --- |
| 1440, 100% | bar, name 121 to 76, 5 faces | bar, name 121 to 76, 3 faces, chip icon | bar, name 121 | bar, name 114 to 79 |
| 1440, 130% | bar, name 115 to 59, no faces | bar, name 115 to 59, no faces | bar, name 85 to 47 | bar, name 71 to 74 |
| 1280, 100% | bar, Full screen out, name 68 to 60, 3 faces | the same as DM | bar, Search field to icon, name 69 to 121 | bar, name 95 to 60 |
| 1280, 130% | bar, View, Floor to Menu, name 45 to 95 | the same as DM | bar, name 113 to 57 | bar, name 112 to 62 |
| 1024, 100% | bar, View, Floor to Menu, name 83 to 121 | the same as DM | bar, Floor name to icon, name 66 to 95 | bar, View, Floor to Menu, name 50 to 100 |
| 1024, 130% | bar, 208 free (band) | bar, 158 free (band) | bar, 261 free (band) | bar, 261 free (band) |

Measured by e2e/volproto.ts (heights 900, 1024 at 768, 844 at 390, 568 at 320). Table 10 compares the base build with the prototype. Table 10b compares the prototype with its speaker held off (`rvtt.volproto.off`, which leaves `volume` out of the bar's content, the base's fit exactly) and on. Raw rows beside this note: fit-base.json and fit-speaker.json, the fight rows marked `fight:` (84 rows each).

## 11. Alignment, measured

In the prototype, by the sweep's `measureAlignment` and `measureSpacing`: the popover (DM, Pat), the card at 900 and 130%, the sheets at 390 and at 320 and 130%, the sheet opened from the DM menu, the DM menu with Volume first (`menuWordLines` too), and the DM-only sheet: no finding (the checks report past 1 px). The bar, at 1440, 900 at 130%, 390 and 320 at 130%: the speaker's icon center sits 0 px from the row's middle, Undo's and Fit's icons and the chip's pill. The button is 44 px tall (57.2 CSS px at 130%). Its gaps are 12 px either side on a computer, 6 on a phone, 2 tight (a part after the bar's spacer meets two gaps there, as every part does). In the controls each label's and percent's center is 0 px from its slider's, the four sliders share their left and right edges, and the mute toggle's box starts on the labels' edge (its icon 12 px in, 15.6 CSS px at 130%). The display menu reports one 4 px edge, the existing label inset of section 7. The toggle's fill (section 4) is not in the pictures.

## 12. UI checklist

- **Loading:** none. Everything is on this device and draws at once. DeviceSound is in the main bundle (This device already holds it), so the card and sheet need no loading line.
- **Keys and focus:** the popover is a dialog popover: focus goes in only when a key opened it, Escape and Tab close it, Back on Android too. The card and sheet hand focus back to the speaker, or to the DM chip or You chip when a menu row opened them. Slider keys step 5%. U as section 8. No other key or pointer change.
- **Screen readers:** the speaker's name carries its value. The toggle is `aria-pressed`. The master slider's value text says "Muted". No live region: a change of sound says nothing aloud (D-261102-479).
- **Large sizes and themes:** at 320 x 568 and 130% the sliders are 83 CSS px, as today's This device grid, and the help wraps between words (picture 011). Color tokens only, dark and light, the toggle's fill included.
- **Alignment roots** (e2e/alignmentRoom.ts): `qe-bar` already measures the bar with the speaker. New: `vol-popover` (DM and Pat), `vol-card`, `vol-sheet`, `vol-dm-menu` and `vol-dm-sheet` at 320 x 568 and 130%, the muted toggle, and the reused `sound-this-device-*` with the new rows. The display menu is measured in display.e2e.ts (no sweep root exists for it). A player's speaker never folded, even at 320 x 568 and 130% or on qc-16b's 740 x 360 landscape phone in a fight, since the You chip shrinks to its dot first: the You menu's Volume item is one more item of a kind the You menu's roots already measure, and chipMenus.test covers it.

## 13. Cases

| Case | Expected | Test |
| --- | --- | --- |
| DM at 1440 with music | Speaker right of the chip, 12 px gaps, icon centered | chips-bar vol-c1, qe-bar |
| Tap the speaker at 1440, 900 at 130%, 390 | Popover, card, sheet titled Volume | sound.e2e vol-2, alignment roots |
| DM at 320 x 568 and 130% | Speaker gone, the DM menu's first row "Volume 100%" opens the sheet | chips-bar vol-c2, chipMenus.test |
| DM at 320 x 568 and 130% in a blackout | The blackout's two items, then Volume | chipMenus.test |
| DM and Pat in a fight at 1024 and 1280 | Speaker on the bar, the steps of table 10b | chips-bar vol-c3 |
| Fight in a blackout at 900 x 900 | Speaker folds before the turn name. The rest as today | chips-bar qc-16 |
| Mute, then unmute | Engine off (`data-sound` off), icon muted, slider 0. Back at the same level, audio unlocked in the click | sound.e2e vol-1, unlock.test |
| `volumeStep` | 70, to 0, unmute: 70. Muted with 70 kept, 30 then 0 in one drag: 70. Left from 10 to 0: 10 | DeviceSound unit |
| Raise Volume while muted | Unmutes, plays, level stored | sound.e2e vol-1 |
| Volume 50 | Each channel's gain times 0.25 | engine mix test, the hook's `mix` |
| Stored mix without `volume`, or with 0 | Reads 100 | settings.test |
| U, in a field or with a dialog open | Toggles. Nothing in a field or a dialog | shortcuts.test, shortcuts.e2e |
| Media session pause, play | Mutes, unmutes at the kept level | mediaSession test |
| Player, no choice, music starts | Asks. Play here unmutes, Stay muted mutes | ask.test, sound.e2e |
| Player under Only DM devices play | Speaker in place, the line once in the popover, once in Sound's panel, Turn and Ping sound play | soundpanel.e2e, DeviceSound unit |
| A trap goes off on a muted device with Turn sound on | Its sound plays | alerts test |
| Listen here while muted | Plays on this device | panel test |
| `DeviceLine` off, cannot, other | Muted with Unmute, the browser line, the window line | soundpanel test |
| Server's switch "off", unknown, failed | Music and Background hidden on "off" only | DeviceSound unit |
| Display: 75% while playing, Off, then a level | Gain 0.5625 at once. Off mutes keeping 75. A level unmutes | display.e2e vol-d, remember.test |
| Search "mute" | Finds Volume in This device, value Muted or the level | search.e2e, device search test |

## 14. Tests

- **Unit:** settings.test (parse, format, the 0 rule), remember.test (`rvtt.displayVolume`, and :56's Room sound wording), DeviceSound (pure `volumeIcon`, `volumeStep`, the `line` prop, the row rules), topBarFit.test (the step lists, `shapeOf`'s `volume`), chipMenus.test and chipWords.test (Volume first, the You item), catalog.test (the kind skipped in its map at :91, the Volume entries at :401-415), golden.test (:134-139), search.testutil.ts (:31), summaries.test, device search, words.test, ThisDevice.test (no Room sound, the player's Only DM devices play clause at :104), engine mix and its display subscription, mediaSession, ask.test (Stay muted stores off), the alerts' trap sound, shortcuts registry (U).
- **Property:** topBarFit, fast-check over `BarContent`: the speaker is on the bar unless every step before `volumeFold` is taken, and `volumeFold` is never taken while an earlier step is not.
- **Mutation checks:** `volumeFold` before `viewFold`, Volume after the DM menu's other sections, the master dropped from `#mix`, the display's subscription dropped, a 0 stored by the slider, the kept level read from the shown 0, unmute without the unlock, `DeviceLine`'s "cannot" falling to muted, the line drawn in the Sound panel, U bound to a taken key.
- **e2e:** VOL-A's sound.e2e vol-1 (This device's toggle and slider: mute, unmute, drag to 0, U, media session), VOL-B's sound.e2e vol-2 (the speaker: its icons, popover, card and sheet), soundpanel.e2e (the line once, the Unmute link), chips-bar.e2e (vol-c1 at 1440 and 1024, vol-c2 at 320 and 130%, vol-c3 the fight rows at 1024 and 1280, with qc-14 and qc-16 passing as they stand), shortcuts.e2e (summary, U in the sheet), search-sweep.e2e (its "Room sound" line), search.e2e, display.e2e (vol-d). Run with reach, reach-player-100, reach-player-130, music, timesound, traps, dmphone, playerphone and the five alignment files.

## 15. Lanes and files

| Lane | What | Size | After |
| --- | --- | --- | --- |
| VOL-A | 1. The contract: settings.ts `volume`, remember.ts `rvtt.displayVolume` and its subscribe, store.ts mute helpers, Icon.tsx with shared/credits.ts and CREDITS.md (the two icons), their tests. 2. DeviceSound.tsx (exported, the `line` prop, `TURN_SOUND_HELP`) and panel/words.ts. 3. engine.ts (`#mix` for both kinds, the display subscription) and testHook.ts (`mix`), ThisDevice.tsx (DmPlaysNote folded into the line), TrackerPanel.tsx (Turn sound's help), device/search.ts, summaries.ts, panel/{SoundPanel, PlayerSound, NowPlaying}.tsx (`DeviceLine`), search/words.ts, state/shortcuts.ts (U), the comments that say "Room sound off" or "Room sound on" (effects.ts:24 and :168, effects.test.ts:293, SoundHost.tsx, store.ts `setRoomSound` and `useRoomSoundOn`, useSoundAsk.ts, mediaSession.ts), and their tests (section 14's unit list but VOL-B's). 4. e2e: sound vol-1, soundpanel, shortcuts, search-sweep, search, and alignmentRoom.ts's `soundScreens` and `patSoundScreens` Room sound steps. 5. Last: docs/design/design-v1-volume.md (this note, As built) and its README line | M | floors |
| VOL-B | Speaker.tsx (new, the button), topBarFit.ts (the steps and their doc comments), Room.tsx (TopBar, the ask's "Stay muted"), ChipMenus.tsx, chipMenus.ts (Volume first), chipWords.ts (`DM_MENU_SECTIONS` and its comment), search/catalog/dm.ts, their tests (topBarFit with the property, chipMenus, chipWords, catalog.test's kind map at :91), then sound.e2e vol-2, chips-bar.e2e and alignmentRoom.ts's new roots in a function of their own, rebased onto VOL-A's e2e commit | M | VOL-A's DeviceSound commit (2) |
| VOL-C | DisplayRoom.tsx (the Volume row, the labels' inset), display.test.ts, then display.e2e vol-d (the level while sound plays, read from the hook's `mix`, and its alignment) | S | VOL-A's contract (1) for code, VOL-A's engine commit (3) for vol-d |
| Docs lane | FEATURES.md (section 9's lines, :77, :78, :82, :1538, :1546, :1612, Media controls, the display, Keys) and docs/dm-guide.md (section 9's sentences), and every guide picture of the top bar retaken | S | the stack |

Two lanes touch three files, each in its own part: sound.e2e (VOL-A vol-1, VOL-B vol-2), alignmentRoom.ts (VOL-A the Room sound steps, VOL-B the new roots) and catalog.test.ts (VOL-A the entries, VOL-B the kind map). One review for the stack. Commits: VOL-A `feat(sound): this device's volume with a mute, in place of room sound`, VOL-B `feat(ui): a speaker on the top bar that opens this device's volume`, VOL-C `feat(display): the table display's volume`, then `docs: volume on the top bar`.

## 16. Decisions

- **D-261108-361** A 44 px speaker on the bar for the DM and players, right of the Now playing chip, its icon muted, low or loud (two new Lucide icons). Rejected: in the right-hand group by Full screen (it splits the room's sound from this device's), inside the chip's pill (one target holding everyone's and this device's), the chip's player only (players have no chip), a dropdown with words ("Volume 80%" costs 60 px more on a full bar).
- **D-261108-362** (fight rows added in round 1) `volumeFold` right after `viewFold` on both lists, folding into a DM menu or You menu row that opens the same card or sheet. In every measured fight at 1024 to 1440 it stays on the bar, so the order stands. Rejected: before `viewFold` (View and Floor are used less than volume), after `turnName` (in a fight whose turn it is outranks volume), a floor under the room name on wide bars (it moves Search, the chip and the DM chip's word off a 1440 bar to keep a name the DM knows), moving `fullscreenOff` ahead of `nowPlayingOff` (a reviewed order changed for one 100 px band), a link row to This device (no jump rows).
- **D-261108-363** (revised in round 1) Mute is `rvtt.roomSound` "off", Volume a new `volume` in `rvtt.soundMix`, 100 at first, never stored as 0. A slider that reaches 0 mutes and keeps the stored level from its pointerdown or focus. Rejected: a new key for mute (two sources of one state, and a migration), storing 0 (unmuting would have no level), a muted slider showing its kept level (its thumb would jump back after a drag to 0), 80% at first (every device would turn quieter), the level shown at the grab (a muted slider shows 0).
- **D-261108-364** (revised in round 1) Volume and mute cover the room's sound only. Turn sound, the trap's sound it gates (381) and Ping sound keep their switches and sound while muted, saying so. Rejected: mute silencing them (a player who said Not on this device at a shared table but turned Turn sound on would lose the chime on upgrade, and a player not yet asked is muted), the master scaling them while mute does not.
- **D-261108-365** The ask stays on a player's device with no choice. Play here unmutes and unlocks, Stay muted mutes. Rejected: unmuted by default with the ask only as the browser's tap (the lean: every phone at a shared table plays at its first tap), no ask (a late joiner hears nothing and is not told), keeping "Not on this device" (the bar now says muted).
- **D-261108-366** (revised in round 1) One `DeviceSound` in the popover, card, sheet, This device and the Sound panel, titled Volume where it stands alone, its line only where nothing above says it. The master row's mute toggle sits in the label column with no word. Rejected: "Device sound" with a "Volume" label in the row (measured: the label column grew 20 px and the sliders at 320 and 130% shrank from 72 to 54 layout px), names over sliders (four more lines in a popover), "Sounds" (beside the Sound panel), the Sound panel without it (the DM's sound panel would lose this device's levels), the line in the Sound panel too (it would show twice).
- **D-261108-367** (revised in round 1) Music and Background hide while the server's switch is "off", and only then. Otherwise the three always show, muted too. Rejected: hiding them on unknown or failed (the popover would jump when the config answers), hiding them while muted (the popover would jump at each mute), hiding them for a player under Only DM devices play (the values wait for a game played apart).
- **D-261108-368** The display's Volume is Off, 25%, 50%, 75%, 100% as menu radios, Off keeping the level, and its engine hears a change at once. Rejected: a slider (the remote's arrows move between the menu's buttons), a mute toggle beside the levels (two controls for one state on a remote), keeping On/Off at full volume (the lean asks for Volume, and a laptop's display window had no level).
- **D-261108-369** U mutes and unmutes. Rejected: M (the DM's Pin, and Shift+M matches M), K (a slip off Ctrl+K would mute), J, Y or Z (no tie to the word), no key.
- **D-261108-370** Words: the speaker "Volume on this device: 80%", the controls titled Volume, "This device only." help with the DM's pointer to Table sound, the Sound panel's "This device is muted." with Unmute. Rejected: "Room sound" kept as a name (it is no longer a switch), "Device sound" (366), the Sound panel's old line pointing at On this device (the chip's player has no On this device).
- **D-261108-381** A trap's sound keeps following Turn sound, on its own context, and plays while muted. Turn sound's help and FEATURES say so. Rejected: mute silencing traps (a second rule for one alert, and a trap is a cue the player acts on).
- **D-261108-382** Where the speaker folds, Volume is the DM menu's first section, after a blackout's items while one is on. Time and Now playing stay last. Rejected: last with the other parts that left the bar (draft 1: below "Scroll for more" on the one layout with no speaker), above the blackout's items (they lead the menu by design).
- **D-261108-383** Listen here plays while muted, at the sound's own level, not scaled by Volume. Rejected: silent while muted (the DM's explicit tap to hear a file would do nothing), scaled by Volume (it plays one file by itself, through its own element).
- **D-261108-384** A player's help keeps "At one table, the DM can turn on Only DM devices play in Sound." Rejected: dropping it (draft 1, a reviewed pointer lost unsaid), the same clause on a DM device (it gets the Table sound pointer instead).
- **D-261108-385** The mute toggle looks like a button: the bar's IconButton hover and pressed fill, held while muted. Rejected: the bare icon of draft 1 (the same glyph before every Table sound slider is a decoration), a bordered box (no other icon button in the controls has one).

## Build notes (design review rounds 2 and 3)

- **VOL-COORD-1** (D-261108-386): the DM menu's first section, where the speaker folds, is headed **This device**, over the row **Volume**.
- **VOL-OPUS-16**: sound.e2e.ts sn-6 presses "Stay muted", changed in the same commit as the label.
- **VOL-OPUS-17**: a player's role chip shrinks to its dot at 1440 in a fight (the strip in the row at 130%, or with the clock at 100%), a cost section 3 and the FEATURES Layout sentence name.
- **VOL-OPUS-18**: the docs say "on their turn", never "his turn".
- **VOL-ASTRA-01**: one status line per rendered Sound panel branch, never two and never none. The panel's `DeviceSound` draws no line where Now playing already says it: a player's `PlayerNow` gains the "can't play" line after Only DM devices play's, which still wins, and the DM's first page while the server's switch is not `on` (unknown, failed or off) has no Now playing, so its On this device draws its own line.
- **VOL-ASTRA-02**: the U row of FEATURES.md's Keys table ships in VOL-A's shortcut commit, since shortcuts.test.ts compares that table with the registry.
- **VOL-OPUS-19**: "never none" covers the line's own states: Only DM devices play (a player), tap, other and cannot each show exactly one line in every rendered branch. Playing and muted add none where the toggle and the 0% master show them. The DM's Now playing keeps its muted line with Unmute.

## Round 1

Reply volume-opus, every finding adopted with the reviewer's pick. 01 the `line` prop (4, 366). 02 `DeviceLine`'s states (6). 03 the trap's sound (4, 9, 381). 04 the lanes (15). 05 the fight rows (3, 10b, 362). 06 the costs (3, 9). 07 Volume first (3, 382, picture 015). 08 the kept level (5, 13, 363). 09 the display subscription (5, 7). 10 Listen here (5, 383). 11 every item has an owner (15). 12 the player's clause (4, 384). 13 "off" only (4, 367). 14 the toggle's look (4, 385). 15 a known residual (5).

## As built

### VOL-A (vola): the controls, storage and engine

- **The contract.** store.ts's helpers are `useDeviceVolume()`, `{ muted, volume }` with `volume` the kept level (a display's from its own Sound and Volume), and `toggleMute(role)` for U and the toggle beside `setRoomSound(on)`, which unmutes inside the gesture as before. remember.ts holds `DISPLAY_VOLUMES` (25, 50, 75, 100), `parseDisplayVolume` (anything else reads as 100), `displayVolume`, `chooseDisplayVolume`, `useDisplayVolume` and `subscribeDisplayVolume`. The two icons are `volumeLow` and `muted`.
- **Credits** (D-261108-399). volume-1, volume-2 and volume-x carry Feather's notice too, as cloud-rain and layers do, since each redraws the Feather icon of its name. volume-2 had Lucide's alone.
- **Words.** Every word is in sound/panel/words.ts, `TURN_SOUND_HELP` included (the Initiative panel's Turn sound reads it there), with `volumeNote` ("80%" or "Muted") and `speakerName` for the speaker and the menu rows. `THIS_DEVICE_ONLY`, `DEVICE_SILENT`, `ROOM_SOUND_HELP`, `RoomSoundControls` and `DmPlaysNote` are gone.
- **DeviceSound.** Its props are `line` (required) and `anchored`. The pure parts are `volumeIcon`, `volumeStep`, `deviceSoundLine` and `mixShown`. The mute toggle is components/IconButton.tsx with `pressed` while muted, in the text color while it plays, as the bar's icons are. It names U in its tooltip and `aria-keyshortcuts` (D-261108-401). Outside a room the help is the player's (D-261108-402).
- **The device line** (D-261108-397). The DM's `DeviceLine` says "Tap anywhere to start the sound." while the page waits for a tap, as VOL-OPUS-19 asks, where section 6 said nothing. Its pure part is `DeviceLineView`. Unmute is a link button in the line, as Library is in the idle line.
- **The engine.** The mix is three exported pure parts: `channelGains(device, room)`, `deviceMix(kind)` and `subscribeDeviceMix(kind, listener)`, which a member's mix or a display's level drives. `FULL_MIX` is gone. The test hook's `mix` is the gains the channels ramp to, never a value partway up the 0.3 s ramp.
- **Search** (D-261108-398, 400). Music volume and Background volume are offered unless the server's switch is "off", as the controls hide them. The synonym `mute` stands for "volume", so "mute" lists U's key row first, then Volume. U's row says "this device's sound", so "music" and "sound" list it too, for a player as well (se-20).
- **The ask.** useSoundAsk.ts exports `stayMuted()`, which stores the mute. The hook's answer keeps its name, `notHere`, which Room.tsx calls.
- **Outside the list.** pings/feedback.ts's `usePingSound` gained its server snapshot, so the controls render in a node test. e2e/soundRoom.ts's `SoundProbe` type gained `mix`.
- **Tests.** Unit: settings.test, remember.test, DeviceSound.test (new), mix.test (new, the engine's mix and the display's subscription), mediaSession.test (new), unlock.test (U and the toggle bless the pool in the press, Listen here while muted), ask.test (Stay muted), alerts.test (a trap's sound on a muted device), panel.test (one status line per branch, `DeviceLineView`), words.test, ThisDevice.test (the controls with This device's props, since the page needs a browser), summaries.test, catalog.test, golden.test, shortcuts.test (U), icons.test. e2e: sound.e2e.ts vol-1 and sn-8, soundpanel.e2e.ts vol-p1 with sp-1, sp-9 and dmb-1, shortcuts.e2e.ts vol-k with steps 2, 3 and ambc-2, search.e2e.ts vol-s1, search-sweep.e2e.ts's exemption for the controls in Sound, and alignmentRoom.ts's `soundScreens`, whose `sound-this-device-off` and `sound-dmonly-device-line` are now a muted device with Unmute. `patSoundScreens` already measures a muted player's This device and is unchanged.
- **Mutation checks.** Each failed a test: the master dropped from the gains, the display's subscription dropped, a 0 stored by the slider, the line drawn where `line` is off, Music and Background hidden while the switch is unknown, "cannot" dropped from the line, unmute without the bless, U on a key already taken, and the kept level read from the shown 0 (vol-1's focus step).

### VOL-B (volb): the speaker on the top bar

- **Speaker.** `Speaker.tsx` is the 44 px button, with a popover from 900 px and a card or sheet below it through ChipDialogs `{ t: "volume" }` and `raiseFor.volume`. TopBar takes its own `speaker={!preview}` prop. The menu rows use kind `volume` and section `thisDevice`, headed **This device** over **Volume** (VOL-COORD-1), after a blackout's items (D-261108-382). The popover is placed again as its line comes or goes (D-261108-408).
- **One-floor scenes** (D-261108-409). The design measured a two-floor room, whose Floor button takes a step. On a one-floor scene the DM's 390 x 844 phone at 100% gives Search's icon to the Panels field and, with music, the Now playing chip to the DM menu. The narrow list takes `searchPanels` and `nowPlayingOff` before `tightGaps`. qe-a's S3 line, qe-n and timesound's sl-7c (now 430 x 932) follow that order. Whether to tighten a phone's gaps before those two leave is J's call.
- **A player in a fight** (D-261108-405). Pat's speaker leaves in chips-bar qc-16's worst case on his own turn, because his turn name leaves there first. His You menu then holds Volume.
- **Where the tests live** (D-261108-406, 407). vol-b1, the popover, card, sheet and DM menu row, lives in the alignment sweep beside qe-n in alignment-icons. vol-c3 measures Goblin 1's turn as table 10b did.
- **Two fixes the speaker's width uncovered** (D-261108-410, 411). At 480 x 320 at 130% the alerts' summary row kept clear of the left edge by the notch's inset plus its shadow's room, so it stayed under the notice. It now keeps the larger of the two. At 844 x 390 at 130% the speaker sent the strip to the band, the map got short and the compact stop note failed its pad check. The note is padded 12/12 and its body and Close give 8 px back, so its content does not move.
- **Outside the list.** shortcuts.test.ts (the speaker among the controls that show U), timesound's sl-7c and alignmentRoom.ts's qe-a and qe-n lines.
- **Mutation checks.** Each failed a test: `volumeFold` before `viewFold` (wide and narrow), the shape ignoring `volumeFold`, Volume last in the DM menu, This device last in `DM_MENU_SECTIONS`, the You menu without Volume, the search finding Volume, the speaker drawn after Undo, the key hint taken from another id, the sum back in `toastPlacement` and `padTop` always 4.

### VOL-C (volc): the table display's volume

- **Volume row** (D-261108-417). Off, 25, 50, 75 and 100% as menu radios. Off stores `displaySound` "off" and keeps the level, and a level stores `displayVolume` then "on". `volumeChecked` and `VOLUME_CHOICES` are pure parts in features/display/logic.ts, so display.test.ts can test them (D-261108-419).
- **Labels.** The Text size, Weather, Animated maps and Volume labels lose their 4 px inset, so they meet the row's left edge (D-261108-418). Animated maps was the same class and went with them.
- **vol-d** (D-261108-420). display.e2e.ts sets `ROOM_SOUND=1`, Chrome's autoplay flag and the sound test hook on the TV's context, since the upload needs the server's switch. It plays music and reads the gains from the hook's `mix` (100 gives 1, 75 gives 0.5625, Off keeps 75, 50 gives 0.25 with sound on). The display menu has no sweep root, so vol-d runs `measureAlignment` on it at 1920 x 1080.
- **Mutation checks.** Each failed a test: `volumeChecked` without the sound-on guard, and the Volume label's padding put back.
