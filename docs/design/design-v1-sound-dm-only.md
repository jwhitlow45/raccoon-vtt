# raccoon-vtt: Only DM devices play, and the crossfade's next up

Status: built (2026-11-07), from design draft 2 at review consensus (section "Round 1", and two P3 wording fixes from round 2), in lanes DM-A (dma) and DM-B (dmb), as OP_VERSION 50 and SNAPSHOT_VERSION 39, which section 8 calls N and S. "As built" says where the build went its own way. Decisions D-261107-232 to D-261107-245. Code is cited from main 2742ff4f (OP_VERSION 49, SNAPSHOT_VERSION 38). Draft 1 was never committed.

## The owner's words

2026-11-03: "also the music player should have a feature that is "only play for me" in case the dm is just using it to manage music on a speaker when all players are together at the same table", and "\"only play for me\" can be whatever you think is good for naming, that is just an example".

## 1. Summary

- **Only DM devices play**, a switch in the Sound panel's Table sound, off at first (D-261107-232, 234). On, players' devices and table displays get nothing of the room's sound: no music, background sounds or effects, no "Play here" ask, no Sound panel listed. DM devices play as their own Room sound says.
- **The room keeps it** until the DM turns it off, as it keeps Players see what is playing, and it is Setup history like that switch (D-261107-233, 240). While it is on, the DM's Now playing and the chip's player say so in one line, so it is never forgotten for a game played apart.
- **Players get the setting and nothing else**: `playing` is absent from their projection, as behind a blackout, so no sound entry, asset or frame about sound reaches them. Effects fired while it is on stay the DM's for good (D-261107-235, 236).
- **MUSIC-XFADE-NEXT** (D-261107-241): after a `music.set`, a revealed `next` stays revealed while it starts within 20 s. One that would now start more than 20 s ahead leaves players' projection and comes back at its reveal. One not yet revealed is revealed when due, as today.
- **Versions** (D-261107-242): OP_VERSION N for `room.update`'s new field and the gated `music.set` rule, SNAPSHOT_VERSION S for the new stored setting. Two lanes, M each, after fu49snd.

## 2. Today

At one table the room's sound plays on every device that said Play here, and on the table display. Each player's phone asks once, the first time there is something to hear. The DM guide and Room sound's help say to play from one device at one table, but that leaves the asks, phones that once said Play here (in a game played apart) playing aloud at the table, and the display doubling a speaker on the DM's laptop. Behind a blackout the projection already drops `playing` for players and displays (shared/project.ts `playersPlaying`, `ctx.paused`), effects go to `dmEffects` (shared/reducer/sound.ts:504), and a display page stops being eligible to own the sound (engine/SoundHost.tsx:42). This design reuses each of those paths. The brief's "Ambiance" went with the sound layout (D-261106-086, FEATURES.md "An older stored or reopened Ambiance opens Sound"): the player's Sound panel is its place now.

## 3. Rules and other VTTs

No SRD 5.2.1 rule touches music or sound. Ideas only: Foundry VTT's playlists and Roll20's jukebox play to every connected client, each with its own volume, and Syrinscape plays on the GM's own machine, with players listening online only through a player link the GM shares. Taken: one room-wide choice of where the sound plays, the GM's devices being the default speaker in that mode. Left out: a per-player choice by the DM, which each device's own Room sound already gives.

## 4. What the DM sees and does

- **Where.** Table sound (NowPlaying.tsx `TableSound`), on its own lines after Players see what is playing, as a `Switch`. While the server's switch is off, the panel's first page (SoundPanel.tsx `DmSoundFirstPage`) shows Table sound with this switch alone after Effects, since the built-in effects still play on players' devices, and a flag set before the server owner turned files off can still be turned off.
- **Words.** Label "Only DM devices play". Help: "For a table that hears the sound from one speaker. Players' devices and the table display play nothing and don't ask. Each DM device still plays while its Room sound is on."
- **The reminder.** While it is on, the player area of Now playing (beside `DeviceLine`) and the Now playing chip's player (mini/NowPlayer.tsx, under `NowFull`) show "Only DM devices play the sound." as help text, with nothing playing too. The device line still follows it where it applies ("This device plays no sound. Turn on Room sound under On this device." or "Another window on this device plays the sound."), so a DM whose own Room sound is off sees both.
- **Search.** client/features/sound/search.ts gains `setting(NOW, "sound.table.dmonly", "Only DM devices play", { names: ["only play for me", "play on my speaker"], valueNow: On or Off })`, with no `when`, since both layouts draw the anchor.
- **Undo.** Setup, labelled "turning on Only DM devices play" and "turning off Only DM devices play" (server/rooms/undoLabels.ts, beside the names switch's labels).
- **Layouts.** The same panel everywhere: a bottom sheet on a phone held upright, the right-hand sheet held sideways, the centered sheet on a tablet, a side panel from 900 px, and the chip's 340 px popover, 440 px card or sheet. The switch row is 44 px tall at least and its help wraps between words. Players see what is playing stays enabled while the new switch is on, since it keeps its value for later (D-261107-245).

## 5. What players' devices and the table display get and show

- **Received.** `meta.settings.soundDmOnly: true` and nothing else about sound: no `playing`, no `sounds` entry, so no sound asset in `visibleAssetIds`, and the asset and display routes answer 404 for every sound. The fan-out sends a socket no frame for a batch whose diff for it is empty (server/rooms/fanout.ts:339), so a Play, a Skip or a tick sends players no frame, beyond the seq gap every hidden batch leaves (fanout.ts:345), as every DM-only op does today.
- **Heard.** Nothing. A device playing when the switch turns on fades out over a second, as at a blackout. When it turns off, music and background sounds join in place with music's 2 s fade-in (the join rule, design-v1-music.md As built). An effect fired while it was on never sounds there. One fired before it, still sounding, was withdrawn from that page and never starts again (5.4's withdrawn set).
- **The ask.** None while it is on: `askWorthy` sees no `playing`. An ask already open when it turns on closes at once without being marked passed (useSoundAsk.ts, today kept up to its 30 s timer and then passed for the page load), so the device is asked again at the first state with something to hear after the switch turns off, as a late joiner is. The rule reads a null `playing`, so an ask open when a blackout starts closes and comes back the same way.
- **Sound panel.** Listed only while something plays that they hear, so not listed. One left open shows "The DM plays the sound on their own device." in place of "Nothing is playing." and hides the tap and other-window lines, so it says the same whether or not anything plays (PlayerSound.tsx `PlayerNow`).
- **This device.** On a player's device the Sounds group shows the same line above Room sound while the switch is on (ThisDevice.tsx, not inside `RoomSoundControls`, so the Sound panel does not say it twice). The switch and its volumes stay as they are. Room sound's help (`ROOM_SOUND_HELP`, ThisDevice.tsx:314) loses its advice to play from one device such as the table display, which the switch contradicts, and reads: "This device only: Music, background sounds and effects the DM plays. If everyone sits at one table, the DM can turn on Only DM devices play in Sound. Music uses about 60 MB of data an hour. On an iPhone it pauses music from other apps and plays even with the ringer off."
- **The table display.** A display page is not enabled while the setting is on, as behind a blackout: SoundHost's rule becomes `on && !(display && (blackout || dmOnly))`, a pure helper `soundEnabled` in engine/SoundHost.tsx. So a display window open on the DM's laptop never wins the handoff and leaves the DM's page silent, and the DM's page plays out of the laptop, to the TV where HDMI carries it. No card shows, since `somethingToHear` reads the empty projection. Its menu's Sound row keeps its own setting and gains no words.
- **Kept.** Turn sound, the trap sounds and Ping sound are each device's own alerts with their own switches, not the room's sound, and stay as they are (D-261107-243). View as a player projects the same way and shows the player's line.

## 6. Co-DMs

Every DM device keeps receiving everything and plays as its own Room sound says, so two DM laptops at one table both play, as today. The help says each DM device still plays while its Room sound is on. A co-DM sees the switch, the reminder and the Undo label like the DM (D-261107-238).

## 7. How it turns back off

Only by the DM: the switch, either layout, or Undo setup while it is the newest Setup step. Nothing turns it off by itself. Every backup and import keeps it, with Include sounds on or off, with or without sound files, and with the server's switch off: `withoutSound` (server/rooms/exportRoom.ts:97) leaves it alone, since it holds no file and nothing hidden, and it still routes the built-in effects where files are off. So no path drops it, the import's `keepsSounds` test (importRoom.ts:273, true only with a sound file in the manifest) included. The 15-minute stop after the last member leaves it alone too (D-261107-240).

## 8. The model

- **State.** shared/model.ts `RoomSettings` gains `soundDmOnly?: true`, absent for off. server/rooms/stateSchema.ts `settings` gains `soundDmOnly: z.literal(true).optional()`.
- **Op.** `room.update`'s `settings` gains `soundDmOnly: z.boolean().optional()` (shared/protocol.ts), false removing it, as `soundNames` does (shared/reducer/room.ts). The DM's only, as every `room.update` is. client/features/sound/panel/ops.ts widens its `room.update` type. No new op.
- **Reducer.** `effectFire` (shared/reducer/sound.ts:504) sends an effect to `dmEffects` behind a blackout or while `soundDmOnly` is on. No other sound op reads it: music, loops, scene sound and the tick run as today, so the DM's devices hear everything. `effect.fire` already reads `keys.meta` (shared/reads.ts:420).
- **Projection.** `playersPlaying` returns null while `soundDmOnly` is on, beside `ctx.paused`. `soundsNamed` and `visibleAssetIds` follow from it. A settings change already re-projects every entity (Tx global), so `soundDependents` needs nothing new.
- **Replay.** No stored op below N can meet the setting, since only a version N op sets it, so `effect.fire`'s new branch needs no gate. The `music.set` rule of section 9 is gated.
- **Export and import.** `withoutSound` strips `soundNames` and keeps `soundDmOnly` (section 7), its doc comment saying why. No remap.
- **Versions** (D-261107-242). OP_VERSION N: `room.update` carries a field older strict schemas refuse, and `music.set` changes meaning. The step is the identity, its comment naming `musicSetReveals`. SNAPSHOT_VERSION S: an identity step, so an older build refuses a room that may hold the setting instead of loading it and sending players the sound. docs/self-hosting.md gains the rule 15 bullet under the newest Since group: back up just before, reload open pages so the switch and the players' line show (an old player page plays nothing meanwhile, since the server sends it nothing), and rollback needs the backup for a room with version N ops after its last snapshot or a vS snapshot.

## 9. MUSIC-XFADE-NEXT

**The bug.** `reanchor` (shared/sound.ts:262) passes `revealed !== undefined` to `withNextAt`, so a revealed `next` stays revealed at the new crossfade's start. Revealed 20 s before a 10 s crossfade, then set to Off, it starts 30 s after the op, past the 20 s window FEATURES.md and the music design's 6.5 promise. Players hold no new fact (they already had the id), but the promise is broken.

**The rule** (D-261107-241). From OP_VERSION N, `reanchor` passes `withNextAt(out, nowMs, t, kept)` with `kept = revealed !== undefined && out.now.at + nowMs - fadeMs(out) - t <= SOUND_LIMITS.revealMaxMs`: a revealed `next` stays revealed while its new start is within 20 s of t, at its crossfade's start, never before t. One not revealed, or one whose new start lies further, is revealed only when its reveal under the new repeat and crossfade is due by t, as today. So a `next` that would now start more than 20 s ahead leaves players' projection and `visibleAssetIds` in that batch, and the tick reveals it again 20 s before its start (`soundDue` already schedules that reveal). A crossfade made longer keeps a revealed `next` revealed, now nearer, even on a short track where `revealAt`'s "not before `now.at` plus the fade" clamp (sound.ts:249-251) would place the reveal later under the new fade: a 30 s track at Crossfade 2 reveals at 8 s, and set to 10 s at 9 s its `next` stays, 11 s ahead. Repeat one already drops it. A device that preloaded the withdrawn track drops its element and loads it again at the reveal, most likely from its HTTP cache (`private, immutable`). A range request in flight in that window gets a 404, which ends a voice that no longer exists.

**The class.** Every other placement already keeps the window: a queue edit keeps `now.at` and the fade, so a kept `next` never moves later, and a resume, a skip, a jump and a seek drop `next` and reveal only when due. The tick's late reveal after a gap places `next` at or before its schedule.

**Replay.** `musicSetReveals(opVersion)` in shared/migrate.ts, false below N, is passed through `musicChanged` to `reanchor` as `gated`, so a stored `music.set` from before replays with `kept = revealed !== undefined`, as it played. Live ops and the DM's predicted view carry no version and take the new rule.

## 10. Files

- **DM-A, model, rules and server (M):** shared/model.ts, shared/protocol.ts, shared/reducer/room.ts, shared/reducer/sound.ts, shared/sound.ts (`reanchor`'s reveal rule), shared/migrate.ts (the two steps, `musicSetReveals`), shared/project.ts, server/rooms/stateSchema.ts, server/rooms/undoLabels.ts, server/rooms/exportRoom.ts (`withoutSound`'s comment only), their tests (section 13), docs/self-hosting.md. Comments that name the blackout as the only rule gain the switch: shared/project.ts:4076 ("Behind a blackout, nothing.") and :4090, shared/reducer/sound.ts:495 (`effectFire`'s doc).
- **DM-B, client and docs (M):** client/features/sound/panel/NowPlaying.tsx (the switch, the reminder), words.ts (the four strings), PlayerSound.tsx, SoundPanel.tsx (the switch-off layout), ops.ts, client/features/sound/mini/NowPlayer.tsx, client/features/sound/engine/SoundHost.tsx (`soundEnabled`, and its comment at :41), client/features/sound/engine/useSoundAsk.ts (an open ask closes unpassed while `playing` is null), client/features/sound/engine/handoff.ts:65 and engine.ts:35 (the `eligible` and `enabled` docs name the switch, comments only), client/features/sound/search.ts, client/features/device/ThisDevice.tsx (`ROOM_SOUND_HELP` and the player's line), their unit tests, e2e/sound.e2e.ts, e2e/soundpanel.e2e.ts, e2e/alignmentRoom.ts roots, then the docs commit: FEATURES.md (Sound: the switch, the privacy line's "and nothing while Only DM devices play", the Setup line, This device's ask line, the display, and Backups' "nothing about sound" gaining "but Only DM devices play"), docs/dm-guide.md (in "What your players hear and see", the sentence "If everyone sits at one table, turn sound on for one device only, such as the table display, so the sound doesn't echo." is replaced, not added to: "If everyone sits at one table and you play the sound from a speaker of your own, turn on **Only DM devices play** under Table sound. Players' phones and the table display then play nothing and never ask. To play it from the table display instead, leave it off and have each player answer Not on this device."), this note and its README line.
- **Running lanes' files these need:** fu49snd owns client/features/sound/**, the server's sound code and e2e/sound.e2e.ts, so both lanes wait for it. fu49docs and qfu2 edit docs/self-hosting.md (DM-A's note goes in order after theirs) and fu49docs docs/design/**. lp32fix edits FEATURES.md and gp7 docs/dm-guide.md's alt text lines (DM-B's prose merges beside them). The drules, dcal and dfloors builds each step shared/migrate.ts, so N and S follow the stack order.

## 11. UI checklist

- **Loading:** none new. The switch applies at once through the room's pending op, and a refusal shows the usual toast.
- **Keys and focus:** no new key or gesture, so the shortcut sheet and FEATURES.md's tables are unchanged. The switch takes Space and Enter as every `Switch` does. Nothing moves focus.
- **Screen readers:** the switch is named "Only DM devices play" with its help as its description. The reminder and the players' line are plain text, not live, so a change says nothing aloud, as no change of sound does (D-261102-479).
- **Large sizes and themes:** at 320 x 568 and 130% the help and the lines wrap between words. Color tokens only.
- **Alignment roots** (e2e/alignmentRoom.ts): Table sound with the switch on, Now playing with the reminder and with the reminder over the device line, the chip's player with it, the switch-off layout with its Table sound, the player's open panel with the line, and This device's Sounds with the note, at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%.
- **Exact words:** "Only DM devices play", its help (section 4), "Only DM devices play the sound.", "The DM plays the sound on their own device.", "turning on Only DM devices play", "turning off Only DM devices play", and Room sound's new help (section 5), checked by ThisDevice.test.ts and the words test.

## 12. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Switch on, then a play, a skip, a tick, a loop and an effect | Pat's and the display's sockets get one batch withdrawing `playing` and every sound, then no frame. Every sound asset 404s for both | sound.itest, sound.e2e sn-10 |
| Twins with the switch on that differ in library, playlists, scene sounds and `playing` | Identical projections for a player and a display, no sound asset visible | project.sound.random.test |
| Bo (no choice) joins with music playing and the switch on, then it turns off | No ask. Asked once it is off | sound.e2e sn-10 |
| Pat playing when it turns on, then off 30 s later | Fades out in a second. Rejoins in place with a 2 s fade-in | sound.e2e sn-10 |
| An effect fired with it on, then it turns off while the effect sounds | In `dmEffects`. Never reaches Pat, before or after | reducer test, random test invariant 1 |
| The DM's laptop shows the display window with it on | The display posts not eligible, the DM's page plays, no card | soundEnabled test, sound.e2e sn-10 |
| DM's Room sound off with it on | Reminder and device line both show | panel test |
| Undo setup after turning it on | Its step is named "turning on Only DM devices play", and Undo turns it off | undoLabels.sound.test, soundpanel.e2e |
| Server's switch off with it on | Table sound with the switch shows after Effects. Built-ins play on DM devices only | panel test, soundpanel.e2e |
| A backup with Include sounds off, one of a room with only built-in effects, and an import with the server's switch off | `soundDmOnly` kept in each | exportRoom.test, server/assets/sound.itest |
| Bo is being asked when the switch turns on (or a blackout starts) | The ask leaves at once, not passed. Bo is asked again once it is off | ask.test, sound.e2e sn-10 |
| A 30 s track at Crossfade 2, revealed at 8 s, set to 10 s at 9 s | `next` kept, 11 s ahead | sound.test |
| An older build meets a vS room | Refused cleanly | migrate test |
| Crossfade 10 s set to Off just after a reveal at 20 s | `next` withdrawn, revealed again 20 s before the start | sound.test, sound.itest |
| Crossfade Off set to 10 s just after a reveal | `next` kept, now 10 s ahead | sound.test |
| A stored version N-1 `music.set` replayed after a reveal | Keeps `next` revealed 30 s ahead, as it played | reducer replay test |

## 13. Tests

- **Property** (fast-check): shared/project.sound.random.test.ts adds `room.update` toggles of the switch to its op mix. Invariant 1 gains "nothing at all while Only DM devices play, and an effect fired then never reaches them, even after it", and invariant 3 (the fan-out copy equals the fresh projection) covers the toggles. A new twins property projects random states with the switch on for P1 and the display. shared/sound.random.test.ts adds "after any op at version N or a tick at t, a revealed `next` starts at most 20 s after t" and "a `music.set` never withdraws a `next` that starts within 20 s".
- **Unit:** reducer (room.update set and clear, effect.fire routing, the `music.set` gate below and at N), project.sound.test.ts (the 6.5 table under the switch), stateSchema.sound.test.ts, undoLabels.sound.test.ts, migrate.test.ts (both steps, an older version refused), panel.test.ts and words.test.ts (the switch, both layouts, the reminder, the player's line hiding the tap line), ThisDevice.test.ts (the note for a player only, Room sound's new help), ask.test.ts (an open ask closing unpassed when `playing` goes null, for the switch and a blackout, and asking again after), exportRoom.test.ts (`withoutSound` keeps `soundDmOnly`), the search entry's value, `soundEnabled`.
- **Integration:** server/rooms/sound.itest.ts (the frames and 404s of the first case, the replay of a stored N-1 `music.set`), server/assets/sound.itest.ts (the backups and imports of section 7 keep the setting).
- **e2e:** sound.e2e.ts `sn-10` (players, the ask, the display window, turning off), soundpanel.e2e.ts (the switch, the reminder in the panel and the chip's player, the search, Undo setup). Run with sound, soundpanel, music, timesound, search, display, reach and the five alignment files (alignment, alignment-wide, alignment-icons, alignment-settings, alignment-followups).
- **Mutation check per lane:** drop the switch in `playersPlaying`, the `dmEffects` branch, `soundEnabled`'s display rule, the ask's unpassed close, `withoutSound`'s keep (strip it), the new reveal rule, its 20 s keep, and the gate, and say which test fails.

## 14. Lanes

| Lane | What | Size | After |
| --- | --- | --- | --- |
| DM-A | Setting, routing, projection, the reveal rule and its gate, versions, the backup keep, labels, tests, the update note | M | fu49snd, the stack's versions before it |
| DM-B | The switch in both layouts, the reminders, the players' and This device's lines, Room sound's help, the ask's close, the display rule, search, e2e, roots, docs | M | fu49snd, DM-A's first commit (the types), e2e on DM-A |

One review for the stack. Commits: DM-A `feat(sound): only dm devices play, kept by the room`, `fix(sound): a crossfade change keeps the next track's reveal within 20 s`, then the versions. DM-B `feat(sound): the only dm devices play switch and what players see`, then `docs: only dm devices play`.

## 15. Decisions

- **D-261107-232** The name is "Only DM devices play", "DM devices" being the app's term. Rejected: "Only play for me" (co-DMs' devices play too, and the table hears it), "Players' devices play it" on at first (the special case would be an off state that names an absence), "Play on one speaker" (says how, not what), "DM devices only" (Table sound's switches are sentences).
- **D-261107-233** Scope is the room, kept until the DM turns it off, in `RoomSettings` beside `soundNames`, Setup history. Rejected: the scene (where the table sits does not change with the scene), the DM's session ending at the 15-minute stop (a long break with every phone locked would turn it off mid-game, and a server-side session is new machinery), a DM device setting (players' devices would still receive, ask and play), no undo step (`room.update` is Setup for every setting).
- **D-261107-234** It lives in Table sound after Players see what is playing, and alone after Effects while the server's switch is off, with a search entry. Rejected: Room settings (no jump rows, the DM looks at Sound), On this device (it is not this device's), a switch in the chip's popover (one place to set it, the reminder there is enough), Table sound only (a flag set before files went off would be stuck).
- **D-261107-235** Players and displays get the setting and no `playing`, as behind a blackout, and the panel and This device say "The DM plays the sound on their own device." Rejected: sending `playing` and letting devices stay quiet (the run, ids and assets would still reach them, and an old page would play), the line only while something plays (it would tell that something plays), no line (a player who turns Room sound on hears nothing and is not told why).
- **D-261107-236** Effects fired while it is on go to `dmEffects` for good. Rejected: the open list (turning it off would show late entries to pages that load then, and it would differ from the blackout rule).
- **D-261107-237** Table displays are quiet and never eligible to own the sound while it is on, their own Sound setting kept. Rejected: the display plays (it doubles the DM's speaker, and a laptop's display window would leave the DM's page silent), a third choice for the display alone (not asked for, the default already plays the display, and a laptop's display window carried to the TV is covered by the DM's page).
- **D-261107-238** Every DM device plays as its own Room sound says. Rejected: only the device that turned it on (a device identity in room state), only that DM's devices (co-DMs share the DM's view everywhere else).
- **D-261107-239** A one-line reminder in Now playing and the chip's player while it is on. Rejected: a chip badge (the chip leaves the bar as it fills, and is gone with nothing playing), a toast at each play (noise at the table), none (the room keeps it, so a game played apart would start silent unnoticed).
- **D-261107-240** (revised in round 1) Only the DM turns it off: the switch or Undo setup. Every backup and import keeps it, `withoutSound` leaving it alone on every path. Rejected: off at the 15-minute stop (D-261107-233), off when a player connects from elsewhere (the app cannot tell where anyone sits), stripping it with the other parts about sound (draft 1: an Include sounds backup of a room with only built-in effects, or an import with the server's switch off, would drop a choice that still routes the built-ins, and it holds no file and nothing hidden), stripping it only for Include sounds off and a files-off import (sol's narrower fix, the same loss on those two paths).
- **D-261107-241** (revised in round 1) After a `music.set`, a revealed `next` stays while it starts within 20 s and is withdrawn past that, and one not revealed is revealed when due. Rejected: revealing only when due under the new crossfade (draft 1: `revealAt`'s clamp withdrew a `next` 11 s ahead on a short track), widening the promise to 30 s (it weakens the stated window for one path), holding `next.at` where it was revealed (Off would overlap the tracks for 10 s), refusing a crossfade change after a reveal (a refusal for a rule the DM never sees), no gate (stored ops would replay to a state that never played).
- **D-261107-242** OP_VERSION N and SNAPSHOT_VERSION S, identity steps, the `music.set` rule gated by `musicSetReveals`. Rejected: no snapshot step (an older build would load the room and send players the sound), the flag in `playing` (the tick and stops write `playing`, players would need it while their `playing` is null, and a setting there gets no Setup step), a separate version for the fix (one stack, one step).
- **D-261107-243** Turn sound, trap sounds and Ping sound stay each device's own. Rejected: silencing them too (each has its own switch, and they are not the DM's music).
- **D-261107-244** Two lanes after fu49snd, the e2e steps in the existing sound files. Rejected: one lane (the client half can start on the types), a fast lane (it touches model, protocol and migrate), a new e2e file (another port offset for six steps).
- **D-261107-245** Players see what is playing stays enabled while the new switch is on. Rejected: disabling it (a value the DM wants ready for a game played apart would be locked).

## 16. For the reviewers: look hardest at

1. The room scope with no automatic off (D-261107-233, 239): whether the reminder is enough to keep a game played apart from starting silent.
2. The withdrawn `next` (section 9): every placement holding the 20 s window, the 20 s keep, and devices dropping and reloading the track.
3. The display rule in the handoff (section 5) with a display window in the DM's own browser.

## As built

Built in two lanes, as section 14 says: DM-A (dma), the model, rules and server, then DM-B (dmb), the client and the docs. Where the build went its own way:

- **Versions** (DM-A). OP_VERSION 50 and SNAPSHOT_VERSION 39 landed in DM-A's first commit, the contract DM-B built on, not last. Both are identity steps, and the update note is under **Since v0.3.1** in docs/self-hosting.md, in the house format: the formats, what an old page does, and backup and rollback left to "Going back to an older build".
- **The reveal rule** (DM-A, section 9). `reanchor`'s new parameter is `windowed`, not `gated`. The sound.random invariant reads "a `music.set` that leaves a following track never withdraws a next that starts within 20 s" (it checks `following(after) !== null`), since Repeat one and Repeat off on the last track drop `next` by design. The `<=` against `<` mutant is equivalent on every state the schedule reaches, so a hand-made run in the crossing kills it (D-261107-276).
- **Comments** (DM-A). One line in server/rooms/importRoom.ts ("keeps nothing about sound but Only DM devices play") and shared/sound.ts's `dmEffects` doc changed too, the same class of stale comment as section 10's list. server/assets/sound.itest.ts's import test is renamed and asserts the keep.
- **The ask** (DM-B, section 5). useSoundAsk.ts decides through a pure `askShows(asking, { eligible, passed, playing, worthy })`, one effect in place of its two, so ask.test.ts steps it through runs of states: an open ask closes unpassed on a null `playing`, stays through a reconnect's undefined, and asks again after. `soundEnabled`'s tests sit in ask.test.ts beside it.
- **Words** (DM-B). words.ts names the four strings `DM_ONLY_SWITCH`, `DM_ONLY_HELP`, `DM_ONLY_ON` and `DM_PLAYS_IT`. `PlayerNow` takes `dmOnly`, and This device's line is `DmPlaysNote` in ThisDevice.tsx, drawn for a player's device only, never a DM's or a table display's, and nothing outside a room.
- **The switch-off layout** (DM-B, section 4). Its Table sound carries no search anchor: the catalog writes each anchor once, and Table sound's own entry waits for sound files. The switch's anchor, `sound.table.dmonly`, is drawn in both layouts by one `DmOnlySwitch`.
- **Tests** (DM-B). The search entry's value is checked in client/features/search/catalog.test.ts and the chip's player's reminder in mini/chip.test.ts. soundpanel.e2e.ts's step is `dmb-1`, and sp-9 also turns the switch on with the server's switch off and fires a built-in, which stays in `dmEffects`. sound.e2e.ts sn-10's late joiners are Hal and Ivy, since Bo and Cy joined in sn-6. It turns the switch off about 20 s after on, not 30, and checks Pat back in place against the display, which takes this browser's sound back. The 2 s fade-in of a join is the music design's rule, tested there, and sn-10 does not measure it.
- **Alignment roots** (DM-B, section 11). sn-d's DM screens gained `sound-dmonly-player`, `sound-dmonly-table` and `sound-dmonly-device-line` (the reminder over the device line, with Room sound off), its player screens `sound-player-dmonly` and `sound-this-device-dmonly`, and qe-n the chip's player with the reminder as `qe-now-*-dmonly`. The switch-off layout's Table sound is measured by the existing `sound-panel-switch-off`.

## Round 1

Replies: dmus-opus (DMUS-OPUS-1 to 8) and dmus-sol (DMUS-SOL-01 and 02), with the coordinator's dispositions. Every finding adopted.

- DMUS-SOL-01 = DMUS-OPUS-4 (P2): an open ask closes unpassed while `playing` is null, for the switch and a blackout, and asks again after. useSoundAsk.ts joins DM-B, with a case row and ask.test.ts (5, 10, 12, 13).
- DMUS-SOL-02 = DMUS-OPUS-5 (P2): `withoutSound` keeps `soundDmOnly` on every path, so no backup or import drops it. D-261107-240 revised, stripping logged as rejected. The export row now asserts the keep (7, 8, 12, 13, 15).
- DMUS-OPUS-1 (P2): Room sound's help points at the switch, and the guide's one-device sentence is replaced. Both strings are in the exact words and tests (5, 10, 11).
- DMUS-OPUS-2 (P2): D-261107-232 to 245, with the revisions, appended to the decisions log.
- DMUS-OPUS-3 (P3): the gated `reanchor` keeps a revealed `next` while it starts within 20 s, with the 30 s track case and a property invariant. D-261107-241 revised (1, 9, 12, 13, 15).
- DMUS-OPUS-6 (P3): the six stale comments are listed in each lane's files (10).
- DMUS-OPUS-7 (P3): exportRoom.test.ts, server/assets/sound.itest.ts, the five alignment files and timesound.e2e.ts named (13).
- DMUS-OPUS-8 (P3): "no frame, beyond the seq gap every hidden batch leaves" (5).
