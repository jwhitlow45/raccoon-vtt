# Calendar C2 and C3: time spans and daylight

Status: built as calendar phases C2 and C3 (see As built). C2 is OP_VERSION 54 and SNAPSHOT_VERSION 41, C3 is OP_VERSION 55 and SNAPSHOT_VERSION 42, and the text below says the built numbers. The note went through two design reviews (the Round 1 and Round 2 sections at the end list each finding and what changed). It is an addendum to [design-v1-calendar.md](design-v1-calendar.md) (built as phase C1), and it replaces that note's section 13 outline for C2 and C3. Code is cited from main `2742ff4f` (OP_VERSION 49, SNAPSHOT_VERSION 38) as it stood when the design was written. Decisions are D-261107-186 to D-261107-195 (section 14), and the build's own are in As built.

## Summary

- **C2, time spans.** An effect can last 1 minute, 10 minutes, 1 hour, 8 hours, 24 hours or any length up to 365 days, read against the room's clock. It ends on any change to the clock that moves the current time past its end: a step, Set, a Long Rest, a fight's end, an Undo, and in a fight the Next that starts the round its end falls in. It reuses today's expiry line and notice. Previous puts it back unless the clock has since moved past its end.
- **C2 also** gives the table display's menu "Show the date and time", and closes CALBUILD-ASTRA-05: each clock line carries a claim id, so a device knows its own lines exactly.
- **C3, daylight.** A scene's Light gains a fourth choice, **Time of day**: Bright by day, Dim at dawn and dusk, Dark at night. The DM sets when dawn and dusk start in the Time panel. A real change of the clock rewrites the level of every such scene in the same op, so Undo takes it back. A phase with its own light, or a level picked by hand, turns it off.
- **Privacy.** A hidden clock's date and time never reach a player. A player's copy of a timed effect carries its end only while their view holds that clock, and whether a scene follows the clock is the DM's alone. Players still see a timed effect end and a Time of day scene change at dawn and dusk, which the DM's help says.
- **Versions.** C2 takes the next free OP_VERSION and SNAPSHOT_VERSION in stack order, OP 54 and snapshot 41. C3 takes OP 55 and snapshot 42. Four build lanes and a docs lane (section 12).

## 1. Section 13 against what shipped

The outline was written before C1 was built. What shipped since, and what changes here:

- **Versions.** The outline's op 42 and 43 are taken. C1 itself took op 42 and snapshot 32 (C1 As built). C2 and C3 took the next free steps after the rules lanes', each with a snapshot step for the reason in 4.7.
- **The clock as built.** `clockNow(clock, encounter)` (shared/calendar.ts) is the one current time, with a fight's seconds derived from the round and a player copy's `started`. Ops name times as `at`. A clock line's audience is frozen when written, and behind a blackout players get no clock and no clock lines (shared/project.ts `projectClockCtx`, D-261102-530). C2's end times use `clockNow` and the same "view holds the clock" rule.
- **The fight clock.** C1 counts 6 seconds a round, derived while the fight runs and stored at its end. The outline's "ends at the start of the round whose `clockNow` reaches it" fits that, and stays (D-261107-188). The turn timer counts real seconds and never touches the room's clock.
- **Expiry notices already show outside fights.** FightWatch is mounted in the top bar at all times (client/pages/Room.tsx:1736, InitiativeStrip.tsx `useLogAlerts`), and turns every effect expiry line into "Bless ended on Bree." So C2 needs no new toast for an effect that ends on a clock step (D-261107-190).
- **The QOL clock chip.** From 900 px up the DM's chip opens its steps (ClockChip.tsx, client/pages/ChipMenus.tsx), and on a phone the DM menu's Time item opens them as a sheet. Those steps now also end effects and relight scenes. The part of the day in the chip's name follows dawn and dusk in C3.
- **Phases with light levels** shipped before C1 (`withPhaseLight`, shared/reducer/phases.ts). The outline's rule stands: a phase with its own level wins and turns Time of day off. `withPhaseLight` already rebuilds `vision` without unknown fields, so the flag goes with no new code there.
- **The scene settings reorganization.** Light now sits first in **Light and weather**, with **Light per phase** under it (client/features/vision/VisionSettings.tsx `LightSettings`). "Use these settings on other scenes" is now **Copy to other scenes…** (copyRules.ts), and the new scene form's "Like <scene>" copies the light too (scenes/create.ts). Both copy the new flag.
- **The outline's C3 rule, "any op that changes `t` writes the new level"**, misses an Undo of a step made before a scene started following the clock. A rule of "any op that writes a scene" instead would fire on bookkeeping: door.set and every build op write the scene key through `bumpWalls` (shared/reducer/tx.ts:180, map.ts:1088). C3 relights on a real change of the clock or of that scene's light settings, compared by value (6.3).
- **"Sunrise and sunset times"** become **Dawn** and **Dusk**, the words C1's panel already shows, set in the Time panel rather than a dialog (D-261107-194).
- **Search** (QOL) indexes Time's controls (client/features/clock/search.ts) and the scene's Light row with its value (client/features/scenes/search.ts). Both learn the new values.

## 2. The rules and other VTTs

- **Spells, "Duration"** (SRD 5.2.1 p. 106): a time span "might say '1 minute,' meaning the spell ends after 1 minute has passed."
- **Combat, "The Order of Combat"** (p. 13): "A round represents about 6 seconds in the game world." So 1 minute is 10 rounds.
- **Exploration, "Vision and Light"** (p. 11): "Even gloomy days provide Bright Light", "The soft light of twilight and dawn also counts as Dim Light", and "Characters face Darkness outdoors at night (even most moonlit nights)."
- **Foundry VTT** stores an effect's duration as seconds with the world time it started, and modules remove it when world time passes. Its scenes have a darkness level that calendar modules move with the time of day. Taken: one absolute end read against the clock, light that follows the clock. Left: turning seconds into turns inside a fight.
- **Fantasy Grounds** counts effect durations in rounds, minutes, hours or days down with the combat tracker and its calendar. Taken: the plain units. Roll20 and Owlbear Rodeo leave both to scripts.

## 3. C2: what the DM and players see

### 3.1 Picking a time span

The effect form (EffectsSection.tsx `EffectDetail`, the Token panel's and a character page's effects) keeps its **Duration** select. While the viewer's room view holds a clock, it lists after today's four choices: **1 minute**, **10 minutes**, **1 hour**, **8 hours**, **24 hours** and **Other length of time**. Other opens a row in place: a number field and a unit (Minutes, Hours, Days), from 1 minute to 365 days ("Pick a length from 1 minute to 365 days."). A time span has no "X is" field: it counts the clock, not a creature's turns.

- During a fight the select's help adds: "A length of time ends at the start of the round it reaches. N rounds ends on a creature's turn."
- For the DM while the clock is hidden: "Players don't see the date and time, but they see how long this lasts and when it ends."
- For the DM with no clock, the time choices are not listed and the help reads: "Start the clock in Time to count minutes and hours."
- A player gets the time choices only while the DM shares the clock and no blackout is on. Otherwise their picker is today's.
- Editing a timed effect keeps its end unless the DM or owner touches Duration ("Leave as is to keep its end."). Picking a span again counts it from now. Picking **No duration** on a timed effect removes its end: the form sends `duration: null` when the effect has a `duration` or an `ends`.
- Group saves and trap rigs keep their rounds and turns choices (D-261107-186).

### 3.2 How it reads

The effect's row and its detail note (`describeDuration` in client/features/tokens/durations.ts gains its span forms):

- Outside a fight, same day: "Lasts 1 hour, to 7:00 AM (48 minutes left)". Another day: "Lasts 8 hours, to Day 5, 2:00 AM (7 hours left)", with the short date of C1's `dateText`.
- In a started fight: "Lasts 1 minute, to the start of round 11". The round is `round + ceil((at - clockNow) / 6)`.
- For the DM, an effect whose clock was stopped or replaced: "Lasts 1 hour, on a clock that stopped". It never ends by itself, and the DM removes it.
- For a player whose view holds no clock (hidden, a blackout, or stopped): "Lasts 1 hour". Nothing else.

### 3.3 When it ends

- **A real change of the clock** ends every timed effect of the current clock whose end the new current time reaches, in the same op: a step from Time, the chip or the DM menu, Set, a Calendar save that moves the time, the party's Long Rest advance, and End the fight (which adds the fight's rounds, C1 4.6).
- **In a fight** the current time moves only when a round starts, so a timed effect ends at the Next that starts the round whose `clockNow` reaches its end. A 1 minute spell cast in round 1 ends as round 11 starts. The tick happens inside that Next, so **Previous** brings the effect back with the round.
- **Previous after the clock moved.** If the DM moved the clock on after that Next, Previous leaves out a timed effect whose end the time after the Previous still reaches. It stays ended, with no second line.
- **An Undo** brings back what its step ended. An Undo that moves the clock forward (of a Set back), or brings back an effect whose end has passed meanwhile (of a remove), ends that effect at once with its line.
- **An Undo or Redo of a turn.** Undoing a Previous, or redoing a Next, brings back a later round and so a later current time, though the clock's stored time stays. Every timed effect that time reaches ends then, on any creature, the ones the turn never touched included.
- **Setting the clock back** gives a running effect more time. One that already ended stays ended.
- **Each end** writes today's expiry line ("Mage Armor ends on Bree.", "Bree's Concentration on Bless ran out.") with today's audience rules, and every device that gets the line shows the alerts' notice "Mage Armor ended on Bree.", which keeps its three newest as it does today. A Long Rest that ends six effects writes six lines, all in the Log. A "save ends" effect that time ends closes its waiting roll request in the same op, as a removal does.
- **Stop the clock** ends nothing. Effects keep their end and wait. Undo setup of the Stop brings back the clock with its id, and they run again. A new clock reads them as on a stopped clock (3.2).

### 3.4 Hidden clock, blackout and players

- A player's device receives a timed effect's end time only while its view holds that very clock. Otherwise it receives the length alone, so a hidden clock's time never leaks through an effect added while it is hidden.
- A player who sends a time span with the clock hidden, no clock or a blackout on gets one refusal for all three, with one code and one message: `invalid`, "The DM isn't sharing the date and time." So the refusal never tells a hidden clock from none.
- A span-only effect still tells a player that a clock exists, and its end tells them time passed. Players also see a Time of day scene change at dawn and dusk. Each is the DM's choice, and the DM's help says so (3.1, 5.1).

### 3.5 The table display

The display's menu gains **Show the date and time** after "Show whose turn it is", off at first and remembered by the display (client/features/display/remember.ts, as `turn` is). On, while the display's view holds a clock, a chip in the same corner as the turn reads "Day 4, 6:00 AM, Dawn" (C1's chip text with the part of the day). The display already receives the shown clock and no lines, so this is client only.

### 3.6 Layouts

- **Phone upright and sideways, tablet upright**: the effect form is in the Token panel's sheet as today. The select is the phone's own picker. Other's row puts its unit under the number where the sheet is narrower than 300 px of content.
- **Tablet sideways and computer**: the same form in the side panel. Nothing new in the top bar.
- **Table display**: the chip at 1440 x 900 and at the display's own text size (85% to 130%).

## 4. C2: model, ops and versions

### 4.1 State (shared/model.ts)

```ts
// Effect gains, apart from `duration` (never both):
ends?: {
  /** The length chosen, in whole minutes as seconds: 60 to LIMITS.effectSpanMax. */
  span: number;
  /** `clockNow` when it was set, plus `span`. A player's copy has it only while their view holds this clock. */
  at?: number;
  /** The clock it runs on (RoomClock.id). Absent exactly when `at` is. */
  clock?: string;
};
// The stored state always holds both `at` and `clock` (the import schema requires them, 4.7).
// ClockLogEvent gains `claim?: string`: the client id on the clock op that wrote the line, or for a DM's
// Undo or Redo the head of the history step it named (4.6). DM and co-DMs only.
```

`LIMITS.effectSpanMax` is 365 days (31,536,000 s).

### 4.2 Ops and permissions (shared/protocol.ts, shared/permissions.ts)

- `durationInput` gains `{ mode: "span", seconds }`, whole minutes from 60 to `effectSpanMax`, with no `of`. `effectInput` and the update patch carry it, so spans reach every op that adds effects through `effectAdd`: `actor.effect.add`, `actor.effect.update`, the bulk `actor.effects` (players may send it, each item checked as its single add, permissions.ts:971-976) and `actor.outcome` (the DM's alone). All take spans under the same refusals. `null` in the patch still removes the duration, and now the end too.
- `clock.start`, `clock.set`, `clock.advance` and `clock.update` gain `claim?: id`. `sys.restore` gains `claim?: id` (4.6).
- **Permissions** (permissions.ts:1133-1134): the player branch of `actor.effect.add` and `actor.effect.update` passes `duration.of` to `anchorVisible`, which a span lacks. It skips the anchor test for the span mode and keeps the ownership and hidden-effect tests as they are.
- **The reducer's refusals**, every one `invalid`: a span with no clock for the DM ("Start the clock first."), a span from a player whose view lacks the clock ("The DM isn't sharing the date and time." for no clock, a hidden clock and a blackout alike, never `clockOf`'s `gone`), and a span past the clock's bound (C1's "The clock can't go that far.").

### 4.3 Reducer

- **Setting it** (shared/reducer/actors.ts `effectAdd`, `effectUpdate`): a span writes `ends = { span, at: clockNow(...) + span, clock: clock.id }` and drops `duration`. A rounds or turn mode writes `duration` and drops `ends`. `checkAnchor` skips the span mode.
- **The due test** (shared/rules/durations.ts, new `endsDue(effect, clock, now)`): `ends.clock === clock.id && ends.at <= now`.
- **In a fight** `tickEffects` gains an optional `due: { clock, now }`, where `now` is `clockNow` of the encounter after the step (`round`, `activeEntryId: landing`). `encounterNext` passes it, so the effects it ends land in `snapshot.effects` and `effectChanges.ended`, and Previous puts them back as it does a rounds expiry.
- **Previous** (shared/reducer/encounter.ts `undoEffects`, :800-814, which today puts back every ended effect with no time test) leaves out a timed effect for which `endsDue` holds against `clockNow` after the Previous. It writes no line for it, so no end is told twice.
- **After every other op** (shared/reducer.ts, after dispatch and the link passes, before `endSaves` at :199 so a save-ends request closes in the same op, gated by `timedEnds(opVersion)`), one trigger with two reaches (D-261108-092):
  - **Every actor in the room** (every scene's tokens and every character, since the clock is the room's) when, between before and after, the clock appeared, its `id` changed, or `clockNow` changed. The current time is compared, not the stored `t`, because a restore of the encounter moves `clockNow` by its rounds alone: an Undo of a Previous, a Redo of a Next, by the DM, a co-DM or a player's own turn. A fall finds nothing due, and after a Next or a Previous the tick and the filter have already done their part, so no end is told twice. A clock.start whose id matches old effects (only a crafted client sends one) is caught here too.
  - **The actors a `sys.restore` touched**, on every restore, which catches an ended effect brought back past its end (an Undo of a remove) when the time did not move.
  - Every other op skips the scan. Due effects end with the tick's own writes and `effectEvent(effect, "expire")`.
- **The invariant**: after every op from 54, no effect whose `ends.clock` is the clock's id has `ends.at <= clockNow`. Next ends inside its tick, Previous filters what it brings back, any op that moves the current time scans every actor, and a restore scans what it brought back.

### 4.4 Projection and privacy (shared/project.ts)

- `publicEffects` (players and the display, owners included) keeps `ends.span` and keeps `at` and `clock` only when the viewer's clock projection exists (shown and not paused) and its id is `ends.clock`. The DM gets `ends` whole.
- `projectEventCtx`'s clock case drops `claim` from a player's copy. Players never send clock ops, so it would only be bytes.
- **Re-projection.** The `ends` copy depends on the clock's presence, id and `shown`, and on the blackout. A blackout is already a global change (shared/reducer/tx.ts `isGlobalChange`). `dependents` adds every token and character holding an `ends` effect when the batch touched `keys.clock` and the clock appeared, went, changed id or flipped `shown` between before and after. A plain step changes no `ends` copy, since `at` is absolute, so C1's "no clock step re-projects a character" holds for steps.
- View as a player projects on the DM's device by the same rules.

### 4.5 Undo, Previous and replay

- The ends a clock op or End the fight caused are writes of that op, so its Undo restores the effects with the clock, and the existing correction line covers the restored creatures. Previous restores what its Next ended, less what 4.3 filters.
- A clock op that ended an effect guards that creature like any write: an earlier play step on the same creature can be undone only after it. A Calendar save that moves the time is a Setup op, so the effects it ends guard those creatures across scopes too. Both are accepted, as for rests today.
- `timedEnds(v) = v === undefined || v >= 54` gates the scan, the Next tick and the Previous filter. No op stored before 54 meets a timed effect, so the gate cannot change today's replays. It stays as the house pattern (CAL-13). Replay of a 54 op ends the same effects and writes the same lines.

### 4.6 The clock line's claim (CALBUILD-ASTRA-05, folded in)

Today a device settles a claim on its own clock line by kind within the update that answers its op, and two same-kind lines in one batch, one its own, are left to chance (useClockToasts.ts `settleClaims`, D-261102-502). C2 closes it, since the op step already changes these ops' schema (D-261107-191):

- The client puts a fresh `claim` only on the ops that can write a line: every `clock.start`, `clock.set` and `clock.advance`, and a `clock.update` with `at` (client/features/clock/claim.ts `withClaim`, used by StartClock.tsx, StepButtons.tsx, SetTimeDialog.tsx, CalendarDialog.tsx and ties.ts). The sharing switch and the Dawn and dusk row send none. The reducer copies the claim onto the line.
- A DM's Undo or Redo already names its stack head, a fresh `randomUUID` per step (server/rooms/undo.ts). The server copies that head into the `sys.restore` it builds as `claim` (server/rooms/actor.ts:1334, beside `correction`), and `clockCorrection` copies it onto the line. A second command naming the same head in one batch is refused as stale (actor.ts:1258-1261), so no batch holds two lines with one claim.
- `settleClaims` matches a line whose `claim` equals the op's (or the command's head) in the answering update, and gives the claim up when none came. The kind test and `CLOCK_STEP` go.
- server/rooms/remap.ts:650 keeps clock lines as they are. Its comment "A clock line names no id" becomes "A clock line names nothing an import remaps".

### 4.7 Versions, migration, export and import (shared/migrate.ts)

- **OP_VERSION 54**, identity: new fields and the span mode, which the version before's strict schema refuses.
- **SNAPSHOT_VERSION 41**, identity: `ends` is optional. It moves because an older build loads stored state without the import's schema check (server/rooms/stateSchema.ts runs only on import) and would send `ends` whole to players, a hidden clock's `at` included (`publicEffects` spreads every field). So a rollback refuses the room by version, as C1's step did.
- **Import only.** `ends` joins the effect element of `actorSchemaForImport` (shared/protocol.ts:3026), which stateSchema's one `effectSchema` (stateSchema.ts:360) uses for actors, encounter history and HP lines alike. `effectStored`, the actor schema of token.create's inline actor (protocol.ts:618) and of `characterInput` (:1071), keeps refusing it, so no create op carries an end, due or not. The client's copies already send no effects (client/features/tokens/factory.ts `freshActor`). A player could not have used those ops anyway: a player's new character must have no effects (permissions.ts:2950) and a player places no inline actor (:3173).
- stateSchema's element requires both `at` and `clock`, `span` within its bounds and `at` within `±clockSecondsMax`, and accepts `claim` on clock lines. Export, the backup and import carry them.
- **Deploy**: reload every page left open across the update, table displays included (docs/self-hosting.md:572 says no version check makes an open page reload). The migrate.ts comment says so in the house form of the weather step (:1114-1122): "Deploy: back up the database just before, and reload open pages, table displays included. Rollback needs the backup for a room with version 54 ops after its last snapshot or a v41 snapshot, which an older build refuses." The docs lane adds the rule 15 bullet to docs/self-hosting.md.

## 5. C3: what the DM and players see

### 5.1 Time of day

- **Light** (Light and weather) gains a fourth choice, **Time of day**, after Dark, while a clock runs or the scene already follows it. The four keep one row where they fit and go two by two where they do not (Segmented `even`).
- Its help: "Follows the time of day: Bright by day, Dim at dawn and dusk, Dark at night. It is Dim now." While the clock is hidden it adds "Players don't see the date and time, but they see the light change." With the clock stopped: "The clock is stopped, so the light stays Dim until it starts again." With party vision off, today's LIGHT_NEEDS_VISION.
- Picking Bright, Dim or Dark turns Time of day off. So does switching to a phase with a light level of its own, which "Light per phase" now says: "A phase with its own light turns Time of day off." A phase with "Leave the light" leaves it on.
- The folded group reads "Time of day, Dim · Heavy rain".
- **Copy to other scenes…** and "Like <scene>" copy it.
- The level follows the clock's current time at each real change of the clock: a step, Set, a Long Rest, a fight's end, Start, a dawn or dusk change, and an Undo that moves the clock. A change to the scene's own light settings (picking Time of day, a phase switch, Players see, a copy onto it) reads the time then too. During a fight it waits for the fight's end, a clock change or such a change to that scene, so a dusk reached by rounds alone darkens the map when the fight ends. Opening a door, building, and changing another scene never relight it.
- It writes no Log line. The map changing is the news, as a level picked by hand is today.

### 5.2 Dawn and dusk

- The DM's Time panel gains a row after Calendar…: **Dawn and dusk**, "6:00 AM and 6:00 PM", with **Change**. Change opens two time fields in place, Dawn and Dusk, with Save and Cancel. Help: "Each lasts an hour. They set the part of the day, To dawn, and the light of scenes that follow the time of day."
- Dawn may start from 12:00 AM to 11:00 AM ("Pick a dawn from 12:00 AM to 11:00 AM."), dusk from 12:00 PM to 11:00 PM ("Pick a dusk from 12:00 PM to 11:00 PM."), in whole minutes. Save sends one `clock.update` with `daylight` and no claim, a Setup step labeled "changing dawn and dusk", with no line.
- The parts of the day become: Dawn the hour from dawn, Morning to noon, Afternoon to dusk, Dusk the hour from dusk, Night until dawn. To dawn moves to the next dawn and its name says the time ("Move the clock on to dawn, 5:30 AM").
- Players read the part of the day through the same times. They get them with the shown clock.

### 5.3 Layouts

- The Light choices sit in the scene settings sheet on a phone and the side panel from 900 px up. The Dawn and dusk row is the Time panel's on every layout. Its two fields stand side by side and stack under 360 px of content.

## 6. C3: model, ops and versions

### 6.1 State (shared/model.ts)

```ts
// SceneVision gains `byClock?: true`: the level follows the clock's time of day. Stored only while true. DM only.
export type Daylight = { dawn: number; dusk: number }; // seconds since midnight, whole minutes
// RoomClock gains `daylight?: Daylight`. Absent reads as DAYLIGHT, dawn 6:00 AM and dusk 6:00 PM.
// ProjectedClock (a player's and a display's) gains `daylight` while it is set.
```

### 6.2 Ops and helpers

- `sceneVision` (create, stored) gains `byClock: z.literal(true).optional()`. `sceneVisionPatch` gains `byClock: z.boolean().optional()`: absent keeps the scene's flag, as `perPlayer` does (shared/reducer/room.ts `patchedVision`). The client's Bright, Dim and Dark send `false`, Time of day sends `true`, and Players see's patches send none.
- `clock.update` gains `daylight?`, dawn within 0 to 39,600 and dusk within 43,200 to 82,800, whole minutes. server/rooms/undoLabels.ts:277-279 gains a case for it, "changing dawn and dusk", before the sharing switch's, which today would name a daylight-only update.
- shared/calendar.ts: `partOfDay(t, daylight?)`, `nextDawn(t, daylight?)`, new `lightAt(t, daylight?)` (Dawn and Dusk Dim, Morning and Afternoon Bright, Night Dark) and `DAYLIGHT`. The shared argument stays optional, so C1's shared callers keep working.
- client/features/clock/words.ts: `chipName`, `timeLine` and `toDawn` take the whole clock in place of the calendar alone, a required argument, so a caller C3 misses fails the typecheck rather than keeping 6:00 AM and 6:00 PM. Their callers: ClockChip.tsx:25, ChipMenus.tsx:312, :360 and :561, TimePanel.tsx:57, StepButtons.tsx:102, and C2's display chip, which takes its name and its text from `chipName` (dropping "Time: ", as ChipMenus.tsx:312 does). So that every commit typechecks, `timeLine`'s change goes with its one caller, TimePanel.tsx, and `chipName`'s and `toDawn`'s go in C3b's commit stacked on C2b, with all their callers (12).

### 6.3 Reducer

- `patchedVision` and `sceneCreate` store the flag as sent. They do not compute the level.
- **One pass** (shared/reducer/clock.ts `followDaylight`, called from shared/reducer.ts right after dispatch, before `foldSight` and `keepMemory`, gated by `followsDaylight(opVersion)`). With a clock after the op, every scene with `byClock` after it takes `lightAt(clockNow(...), clock.daylight)` where that differs, keeping the rest of its vision, when either:
  - the clock really changed between before and after (it appeared, or its `id`, `t` or `daylight` differs), which relights every following scene, or
  - that scene's own light settings changed between before and after (its `vision` or `phaseId` differs, or it is new), which relights that scene alone.
- The tests compare values, so `bumpWalls`'s bookkeeping (door.set, every build op) and edits of a scene's weather, name or walls relight nothing, and a restore relights only through what it really changed. An unrelated Undo relights nothing. Next, Previous and their Undo and Redo change neither the stored `t` nor a scene, so rounds alone never relight a scene. This trigger reads the stored `t` on purpose, where C2's reads `clockNow` (4.3).
- `withPhaseLight` rebuilds `vision` without the flag when the phase has a level, unchanged. A hand-picked level comes with `byClock: false`.
- **The invariant**: after every op from 55, outside a started fight, every scene with `byClock` has `vision.light === lightAt(clockNow)` while a clock runs. Within a fight it holds as of the last real change of the clock or of that scene.

### 6.4 Projection and privacy

- `projectSceneCtx` (project.ts:2920) drops `byClock` from a player's and a display's `vision`. They get the level, as today.
- The player clock copy adds `daylight`. A hidden clock sends nothing, as in C1.
- A level change is already a global change (`isGlobalChange`'s scene case), so sight and fog follow it as they follow a level picked by hand. The flag alone is not one.

### 6.5 Undo and replay

- The pass's writes are the op's, so a step's Undo restores each scene's level with the clock, and an Undo of a step made before a scene followed the clock relights that scene, since it moves the clock.
- A step that relit a scene guards the scene key: Undo setup of an earlier change to that scene (its weather, say) is refused until the step is undone, and a setup change after the step refuses the step's Undo, where Set puts the time right. This happens only when a step crosses dawn or dusk, since the pass writes only a changed level. Accepted, as C1 accepted the whole-clock guard (D-261107-193).
- `followsDaylight(v) = v === undefined || v >= 55`. No scene follows the clock before 55, so older replays cannot change.

### 6.6 Versions, export and import

- **OP_VERSION 55**, identity. **SNAPSHOT_VERSION 42**, identity, for the reason of 4.7: an older build would send `byClock` to players (`projectSceneCtx` passes `vision` whole), which tells them a clock exists.
- stateSchema accepts `byClock` and `daylight` with the bounds of 6.2. Export, the backup and import carry them.
- **Deploy**: reload every page left open across the update. A DM page left on the old build sends Bright, Dim or Dark with no `byClock`, which keeps the flag, so the pass would put Time of day's level back over the pick until that page reloads. The migrate.ts comment: "Deploy: back up the database just before, and reload open pages, DM pages first, table displays included. Rollback needs the backup for a room with version 55 ops after its last snapshot or a v42 snapshot, which an older build refuses."

## 7. Files

- **C2 shared**: shared/model.ts, shared/protocol.ts (the span mode, the claims, `actorSchemaForImport`'s effect element), shared/limits.ts, shared/permissions.ts (the span branch), shared/rules/durations.ts, shared/reducer.ts, shared/reducer/actors.ts, shared/reducer/encounter.ts (the tick and `undoEffects`), shared/reducer/clock.ts (copies `claim`), shared/undoCorrection.ts (`clockCorrection` takes the claim), shared/project.ts, shared/reads.ts (a span reads `keys.clock` where the view holds one, `clockRead`), shared/migrate.ts.
- **C2 server**: server/rooms/stateSchema.ts, server/rooms/actor.ts (one field on the restore it builds at :1334), server/rooms/remap.ts (the comment).
- **C2 client**: client/features/tokens/durations.ts (modes, `durationInput`, span words), client/features/tokens/EffectsSection.tsx (`DurationFields`, the Other row, the help, No duration on a timed effect), client/features/clock/claim.ts (new), client/features/clock/useClockToasts.ts, the senders client/features/clock/StartClock.tsx, StepButtons.tsx, SetTimeDialog.tsx, CalendarDialog.tsx and ties.ts, client/features/display/DisplayRoom.tsx and remember.ts.
- **C3 shared**: shared/model.ts, shared/protocol.ts, shared/calendar.ts, shared/reducer.ts, shared/reducer/clock.ts, shared/reducer/room.ts, shared/project.ts, shared/migrate.ts. **Server**: server/rooms/stateSchema.ts, server/rooms/undoLabels.ts.
- **C3 client**: client/features/vision/VisionSettings.tsx, settings.ts (`LIGHT_LEVELS`, `lightPatch`) and copyRules.ts, client/features/scenes/create.ts, sceneSummary.ts and search.ts, client/features/clock/words.ts, TimePanel.tsx, ClockChip.tsx, DaylightRow.tsx (new) and search.ts ("Calendar…" also found by dawn, dusk, sunrise and sunset, and a "Dawn and dusk" entry), client/pages/ChipMenus.tsx (the chip's name), and, stacked on C2b, the `toDawn` call in StepButtons.tsx and the `chipName` call of DisplayRoom.tsx's chip.
- **Docs**: FEATURES.md (Date and time, Durations, Fog and vision's Light, The table display), docs/dm-guide.md, docs/self-hosting.md, docs/design/design-v1-calendar-c2c3.md (new), docs/design/design-v1-calendar.md (a link in section 13), docs/design/README.md, docs/design/mvp.md.
- **Assets**: none. No icon is new.

## 8. Keyboard, touch, accessibility and performance

- No new key or gesture. The shortcut sheet registry and FEATURES.md's Shortcuts stay as they are, and each docs commit says so.
- Every control is an existing select, number field, time field, segmented choice, switch or button, 44 px tall, with 16 px inputs. Nothing needs hover or a long press.
- The span choices are options of the Duration select, so a screen reader reads them in order. The Other row's fields are named "Length" and "Unit", and a refusal under them is linked by `aria-describedby`. The display's chip is a polite live region named "Time: Day 4, 6:00 AM, Dawn", as the room's chip is.
- Time of day is a radio of the Light group, and its help is the group's description. Dawn and Dusk are named time fields. Change focuses Dawn, Save and Cancel give focus back to Change.
- Colors are theme tokens. Nothing moves, so reduced motion changes nothing.
- **Performance on a mid-range phone.** The expiry scan reads every actor only when the clock appears, changes id or its current time changes (a Next only as a round starts), and otherwise only a restore's own actors, and the daylight pass only on a real clock change or a scene's light settings, at most a few hundred actors or 50 scenes. Effect rows already re-render on view changes. A relit scene costs what a level picked by hand costs. Sizes: `ends` about 70 bytes an effect, within `MAX_EFFECTS`, a claim 36 bytes a line in the existing rings, `daylight` about 30 bytes, `byClock` about 14 bytes a scene.

## 9. UI checklist

- **Loading**: every op applies at once. A refusal is the existing refusal toast with the reducer's words, and the form keeps its values, as today's effect form does.
- **Keys and focus**: Tab order follows reading order. Escape closes the Other row's sheet as today. Enter in Dawn or Dusk saves the row.
- **Screen readers**: as section 8. An effect that ends is spoken by the alerts' existing polite notice.
- **Large interface sizes**: at 130% on a 320 px phone the Other row's unit goes under its number, Light's four choices go two by two, and Dawn and Dusk stack.
- **Alignment**: the sweep (e2e/alignmentRoom.ts) gains roots for the DM's and Pat's effect form with the span choices and the Other row, an effect row reading a span in and out of a fight, the display's chip, the Light group with Time of day and its hidden-clock help, and the Time panel's Dawn and dusk row open, each at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%. A step from the DM's chip popover that ends an effect is measured at 1440 x 900 with the notice showing, so the popover and the alerts never overlap.
- **The words**: "1 minute", "10 minutes", "1 hour", "8 hours", "24 hours", "Other length of time", "Length", "Unit", "Lasts …", "Show the date and time", "Time of day", "Dawn and dusk", "Dawn", "Dusk", "Change", "Save", "changing dawn and dusk", and the notes and refusals quoted in sections 3 and 5.

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| DM adds Mage Armor for 8 hours at 10:00 PM, then taps 8 hours | It ends with the step, one expire line, the notice on every device | reducer, e2e tm-2 |
| Bless for 1 minute cast in round 1 | Ends at the Next that starts round 11, Previous brings it back | reducer, e2e tm-3 |
| Next to round 11 ends Bless, the DM taps 10 minutes or Sets the clock on, then Previous | Bless stays ended, no second line, round 10 back | reducer, random |
| Same, but the DM Sets the clock back before Previous | Bless comes back with its time left | reducer |
| Round 11, the rows replaced, Previous skips back to round 1, a co-DM adds a 1 minute effect to a character Previous never touched, then Undo of the Previous | Round 11 back, the current time 60 s on, and the effect ends in that restore with its line | reducer, server (undo.test.ts) |
| A 10 minute effect cast in round 1, Next to round 11, Undo, a Calendar save 9 minutes on, then Redo of the Next | Round 11 back, the effect's creature untouched by the Next, and it ends in the Redo | reducer, server (undo.test.ts) |
| Undo of a Next | The current time falls, nothing ends, nothing told twice | reducer |
| 1 minute cast in round 1, End the fight in round 10 | The end adds 60 s and ends it in the same op. Undo brings back both | reducer |
| A save-ends effect with a pending request runs out on a step | The request closes in the same op | reducer |
| 1 hour effect, DM sets the clock back 2 hours | 3 hours left. Undo of the Set ends it at once with its line if due | reducer |
| Undo of a remove after the effect's end passed | It comes back and ends in the same restore | reducer |
| Undo of the step that ended it | The effect and the clock come back, no expire line | reducer, server (undo.test.ts) |
| Calendar save with a new time that ends an effect, then Ctrl+Z on an earlier play step of that creature | Refused as changed since (accepted) | server (undo.test.ts) |
| Stop, then Undo setup | Effects keep their end and run again with the old clock | reducer |
| Stop, then a new clock | The DM reads "on a clock that stopped". It never ends by itself | reducer, client unit |
| A clock.start that reuses an old clock's id | Its due effects end in that op | reducer |
| Pat adds a span with the clock shown, by the form and by the bulk `actor.effects` | Accepted, his copy carries `at` | permissions, reducer, projection |
| Pat adds or updates a span, single or bulk, with no clock, a hidden clock, or a blackout | The same code and message in all cases | permissions, reducer |
| Pat's span on a creature he does not own, or naming a hidden effect | Refused as today, ownership and hidden tests kept | permissions |
| token.create or character.create whose actor holds an `ends` | Refused by the schema | protocol |
| DM adds a span while the clock is hidden | Pat's copy carries only `span` and reads "Lasts 1 hour" | projection, e2e tm-4 |
| Sharing turned on with timed effects on Pat's character | Pat's copy gains `at` in that batch | projection, itest |
| Sharing off, or a blackout | Pat's copy loses `at` | projection, itest |
| Two rooms that differ only in a hidden clock's `t`, with `at` shifted the same | Pat's projections are equal | property |
| A span past the clock's bound | Refused, "The clock can't go that far." | reducer |
| Span on update replaces rounds, rounds on update replaces span, null removes both | Never both fields | reducer |
| No duration picked on a timed effect | The form sends `duration: null` and the end goes | client unit |
| Two DM devices step the clock in one batch | Each toasts the other's line and not its own | client unit, server itest |
| A co-DM's Undo of a clock step and this device's step in one batch | Each device matches its line by claim | client unit |
| The sharing switch and Dawn and dusk | Send no claim | client unit |
| Pat's copy of a clock line | No `claim` | projection |
| Replay of an older `encounter.next`, `encounter.prev`, `encounter.end`, clock ops and restores | No timed scan or filter, same state | migrate |
| A build before 41 opens a room saved at 41 | Refused by version | migrate |
| Export and import with timed effects | `ends` comes back whole | importRoom |
| Display with Show the date and time, clock shown, then hidden | Chip shows, then goes | client unit, e2e tm-5 |
| Scene on Time of day at 5:30 PM, DM taps 1 hour | Light goes Dim in that op. Undo takes it back | reducer, e2e dl-1 |
| Fight crosses dusk by rounds | No change until the fight ends, then Dim | reducer |
| Fight past dusk by rounds, then Pat opens a door, or the DM paints with the builder | No scene light written, the door's undo holds no scene | reducer, random |
| Fight past dusk, the DM edits another scene's weather | The followed scene keeps its level | reducer |
| An unrelated Undo, such as a token move | Relights nothing | reducer |
| Next and Previous on a Time of day scene | Never write a scene | random |
| Switch to a Night phase with Dark | Dark, Time of day off | reducer, e2e dl-2 |
| Switch to a phase with "Leave the light" | Time of day stays on, the level read from the time | reducer |
| Bright picked by hand | Time of day off | reducer |
| Players see changed with Time of day on | The flag stays | reducer |
| Undo of a step made before the scene followed the clock | The pass relights the scene from the restored time | reducer |
| Dawn set to 5:30 AM | Part of day, To dawn and the light follow it, the chip's name, Pat's panel too | calendar unit, e2e dl-3 |
| Dawn and dusk saved alone | Undo setup reads "changing dawn and dusk" | server (undoLabels.test.ts) |
| Dawn 11:01 AM or dusk 11:01 PM | Refused under the field | client unit, protocol |
| Clock hidden, Time of day scene | Pat's scene carries the level and no flag | projection, e2e dl-4 |
| Two rooms that differ only in `byClock`, levels equal | Pat's and a display's projections are equal | property |
| Two rooms that differ only in a hidden clock's `daylight`, levels equal | Pat's and a display's projections are equal | property |
| Copy to other scenes and Like <scene> from a Time of day scene | The copies follow too, levels from the clock | reducer, client unit |
| Undo setup of a scene's weather after a step relit it | Refused, "Undo the play step first" (accepted) | server (undo.test.ts) |
| A build at 41 opens a room saved at 42 | Refused by version | migrate |

## 11. Tests

- **Unit**: shared/rules/durations.test.ts (`endsDue`, `tickEffects` with `due`), shared/calendar.test.ts (`partOfDay`, `nextDawn` and `lightAt` with daylight at every boundary and at the bounds), shared/permissions.test.ts (the span branch, single, update and bulk, with shown, hidden, absent and blacked-out clocks, ownership and hidden-effect refusals kept), shared/protocol tests (create ops refuse `ends`, the import element accepts it), client/features/tokens/durations.test.ts (the span words, the round of the end, a stopped clock, Other's bounds, No duration on a timed effect), client/features/clock/useClockToasts.test.ts (claims by id, a co-DM's same-kind line in the same batch, a refused op, no claim on lineless ops), client/features/clock/words.test.ts (To dawn, the chip's name and the part of day with daylight), client/features/display/display.test.ts (the choice remembered), client/features/vision/VisionSettings.test.ts (choices, help lines, patches with the flag), server/rooms/undoLabels.test.ts (the daylight case).
- **Property** (fast-check): shared/calendar.property.test.ts gains `lightAt` agreeing with `partOfDay` for random daylight and `t`. shared/project.timed.property.test.ts: twin rooms that differ only in a hidden clock's `t` (and `at` shifted equally) project equally to a player and a display. shared/project.daylight.property.test.ts: twin rooms that differ only in `byClock`, or only in a hidden clock's `daylight`, with equal stored levels, project equally.
- **Reducer**: shared/reducer/timed.test.ts and shared/reducer/daylight.test.ts, the reducer rows of section 10. **Random**: shared/reducer/timed.random.test.ts runs clock ops, spans and rounds added and edited, Next, Previous, End, Stop and Undo setup, and undo and redo, with sequences of Next, a step or Set, then Previous weighted in, and Undo and Redo of Next and Previous with a Setup clock move or a co-DM's step between, and rows replaced so Previous skips rounds. Invariants: the 4.3 invariant after every op, never both `duration` and `ends`, each end writes exactly one expire line over the whole sequence, Previous after Next with no clock change between restores the timed effects as they were, a player copy never holds `at` unless their view holds that clock. shared/reducer/daylight.random.test.ts adds scene light picks, phase switches, weather edits, door.set, build paints and fights, with the 6.3 invariant, "Next and Previous write no scene" and "an op that changes neither the clock nor a scene's light settings writes no light".
- **Projection and versions**: shared/project.timed.test.ts and shared/project.daylight.test.ts (each audience, the paused case, `claim` dropped, `byClock` dropped, the dependents on a sharing flip), shared/migrate.test.ts (54 and 55, the two snapshots, both gates).
- **Server**: server/rooms/stateSchema.test.ts, importRoom.test.ts, undo.test.ts (a step's undo with its ended effects and relit scenes, the cross-scope guard of a Calendar save, the Undo of a Previous and the Redo of a Next of section 10 ending an untouched creature's effect, the claim on a DM's restore and none on a player's), server/rooms/clock.itest.ts (a player socket never receives `at` while hidden, nor `claim`, nor `byClock`).
- **e2e**: e2e/timed.e2e.ts, steps `tm-1` to `tm-5` (the picker and Pat's copy, a step that ends Mage Armor with the notice on Pat's phone, Bless across round 11 and Previous, a hidden clock, the display's chip). e2e/daylight.e2e.ts, steps `dl-1` to `dl-4` (a step past dusk relights Pat's view, a Night phase turns it off, dawn at 5:30 AM with the chip's name, a hidden clock). Both join e2e/durations.json. Run with clock, combat, tokenpanel, display, vision, scenesetup, search, alignment, alignment-wide, alignment-settings and reach.
- Each new test fails with its fix removed. Mutation checks: the clock id test in `endsDue`, `<=` for `<`, the Next tick's `due` dropped (Previous then fails), the Previous filter dropped, the scan moved after `endSaves`, the restore's touched-actor scan dropped, the trigger comparing the stored `t` in place of `clockNow` (the Redo of a Next then fails), `at` kept for a hidden clock, the dependents on a sharing flip, the permission span branch dropped, `ends` accepted on create ops, the claim match by kind, a claim on the sharing switch, the daylight pass on any scene write, the pass run on Next, `byClock` kept in a player's scene, the daylight undo label, and each gate.

## 12. Lane plan

The contract fixed here lets the client lanes start beside the model lanes: the types of 4.1 and 6.1, the op fields of 4.2 and 6.2, `endsDue`, `lightAt`, `partOfDay(t, daylight?)`, `nextDawn(t, daylight?)`, `DAYLIGHT`, `LIMITS.effectSpanMax`, words.ts's clock-taking `chipName`, `timeLine` and `toDawn`, and the words of sections 3 and 5. Each model lane lands its types and protocol first.

| Lane | Owns | Size |
| --- | --- | --- |
| **C2a, timed model** (OP 54, snapshot 41) | C2's shared and server files of section 7, their tests, the new reducer, random and projection tests, server/rooms/clock.itest.ts cases | L |
| **C2b, timed client** | C2's client files of section 7, e2e/timed.e2e.ts, C2's alignment roots | M |
| **C3a, daylight model** (OP 55, snapshot 42) | C3's shared and server files of section 7 and their tests | M |
| **C3b, daylight client** | C3's client files of section 7, e2e/daylight.e2e.ts, C3's alignment roots | M |
| **CD, docs** | the docs of section 7, after the four merge | S |

- **Stack order**: the rules lanes, with any steps they take, then C2a, then C3a, which shares shared/model.ts, protocol.ts, reducer.ts, reducer/clock.ts, project.ts, migrate.ts and stateSchema.ts with C2a. 54, 41, 55 and 42 are the next free numbers when each lands. C2b and C3b run beside both. They share StepButtons.tsx and DisplayRoom.tsx: C2b owns them, and C3b's commit that changes `chipName` and `toDawn`, whose callers include those two files, lands on C2b's tip. Their alignment roots and durations.json entries land in a last commit each, C3b's on C2b's tip.
- **Commits.** C2a: `feat(effects): time spans that run out with the clock`, `feat(clock): clock lines name the op that wrote them`, then the versions. C2b: `feat(effects): pick a length of time`, `feat(clock): a device knows its own clock lines`, `feat(display): show the date and time`, then its e2e. C3a: `feat(clock): scene light that follows the time of day`, `feat(clock): dawn and dusk`, then the versions. C3b: `feat(vision): time of day light`, `feat(clock): dawn and dusk in time` (with `timeLine` and TimePanel.tsx), `feat(clock): the chip, to dawn and the display read dawn and dusk` (on C2b's tip: `chipName` and `toDawn` with ClockChip.tsx, ChipMenus.tsx, StepButtons.tsx and DisplayRoom.tsx), then its e2e. Each commit typechecks. CD: `docs: time spans and daylight`.

## 13. Waits, not planned

Time spans in group saves and trap rigs, turn-exact time spans in a fight, map phases switched by the clock, dawn and dusk that change with the season or month, moon phases, "the next dawn" recharges (a new rest kind, D-261024-28), weather by the day, a Log line for a light change, and a list in Time of which scenes follow it.

## 14. Decisions

- **D-261107-186** Scope: C2 is time spans on the effect form (and the effect ops that share its input), the display's date, and the clock line's claim. C3 is Time of day light with dawn and dusk. Rejected: one build of both (two op steps either way, and C3 reads nothing of C2), time spans in group saves and trap rigs now (their forms are state machines of their own, and their presets are turn based), dawn and dusk in C2 (they serve the light).
- **D-261107-187** Model: `Effect.ends { span, at, clock }`, apart from `duration` and never both, `at` read against `clockNow`, whole minutes from 1 to 365 days, a clock id as rest stamps carry, accepted in stored state and on import only, never on a create op. Rejected: turning a span into rounds in a fight (it would pause when the fight ends, the gap C2 closes), storing time left (every clock step would rewrite every timed effect and re-project it), `at` without `span` (a player with a hidden clock would read nothing at all), ending timed effects at Stop (Undo setup brings the clock back, and a stop is no time passing), listing the spans without a clock as rounds (one choice with two meanings), `ends` on `effectStored` (token.create and character.create could carry an end already due, which no scan ends).
- **D-261107-188** (revised in rounds 1 and 2, with D-261108-092) When it ends: every actor is scanned when the clock appears, changes id or its current time changes, a restore of rounds included, and a restore also checks the actors it touched. In a fight that is the Next that starts the round it reaches, inside the tick so Previous puts it back, and Previous leaves out what the time after it still reaches. The scan runs before `endSaves`. One invariant holds after every op. Rejected: ending on the turn of the creature acting when it began (a row id to keep through rows leaving and joining, and an invariant that no longer holds within a round, where N rounds already gives turn-exact ends), the round after the end (late by a round), a pass after Next instead of the tick (Previous could not put it back), adding Previous to the scan (it would bring the effect back and end it again with a second line), the trigger "`clockNow` rose" (two rules where one fits, and it misses a start that reuses a clock id), the stored `t` as the trigger (an Undo of a Previous or a Redo of a Next moves the time by rounds alone), a restore that scans only its touched actors (it misses an effect on a creature the turn never touched).
- **D-261107-189** Privacy: a player's copy has `at` only while their view holds that clock, else `span` alone. A player sets a span only with the clock in view, refused with one code and one wording for none, hidden and blackout. Re-projection through `dependents` on the clock's presence, id or sharing. What players can still tell (a clock exists, time passed, dawn came) is the DM's choice, told in the DM's help. Rejected: `at` always (an effect added while hidden reads out the clock), `at` never (players lose the end while the clock is shared), refusing spans to the DM while hidden (a DM keeping a secret clock is the case it serves), a global change on a sharing flip (it projects every key where a few actors change), `gone` for a missing clock (its code would tell none from hidden).
- **D-261107-190** Notices: today's expiry line and the alerts' notice, which FightWatch already shows outside fights, and a DM help line when the clock is hidden. Rejected: a new toast hook (two notices for one end), one line per step that lists what ended (a new line shape whose audience is every effect's own).
- **D-261107-191** CALBUILD-ASTRA-05 folds into C2, since the op step already changes these ops: a client claim on the ops that can write a line, a DM restore claimed by the head its command named, the line carrying it, players' copies without it. Rejected: the ack naming its seq (a server frame change in qfu2's files that needs no op step, so it belongs to no phase), a member id on the line (one member's two devices share it, and D-261102-335 turned it down), a new claim field on undo and redo commands (the head already names the step once), a claim on every clock op (harmless, since an unmatched claim lapses, but it would put the sharing switch and C3's Dawn and dusk row on C2's helper), leaving the residual open.
- **D-261107-192** The display's "Show the date and time", off at first, beside "Show whose turn it is". Rejected: on at first (most tables show the map alone on a TV), in C3 (it reads only the clock).
- **D-261107-193** Daylight: a fourth Light choice and a DM-only `byClock` flag beside the stored level, rewritten by one pass from `clockNow` when the clock really changed (every following scene) or a scene's own light settings changed (that scene), compared by value, never by Next or Previous. A phase with its own level and a hand pick turn it off. The flag survives Stop. Rejected: a level derived at read time from the clock (sight, the explore step and the fan-out read the stored level, so a clock step would change sight with no scene write), relighting on Next (Previous and every scene guard would meet it mid-fight), relighting on any scene write (door.set and build ops bookkeep the scene key through `bumpWalls`, so a player's door would relight every scene and join its undo), turning flags off at Stop (a restarted clock should light them again), the outline's "any op that changes `t`" (it misses an Undo of a step made before the scene followed).
- **D-261107-194** Dawn and dusk: one pair for the room, set in the Time panel's own row, each an hour, driving the part of the day, To dawn and the light, its Undo labeled "changing dawn and dusk". Rejected: "Sunrise" and "Sunset" (C1's panel says Dawn and Dusk), the Calendar dialog (a modal where the panel fits, J on 2026-11-06), times per month or season (waits), per scene (one sky for one world), fixed 6:00 AM and 6:00 PM (the outline promised them, and a northern winter campaign needs them), an optional daylight argument in the client's words (a missed caller would keep 6:00 AM silently).
- **D-261107-195** Versions and lanes: C2 and C3 each take the next free OP_VERSION and SNAPSHOT_VERSION in stack order, each an identity step, with a manual reload at deploy. Four lanes and docs. Rejected: fixed numbers now (the rules lanes may take one or two first), no snapshot steps (an older build loads stored state unchecked and would send `ends` or `byClock` to players), one lane per phase (the contract lets client and model run at once), C2 and C3 sharing one snapshot step (each phase may deploy alone and must refuse a rollback alone), "nothing to do" at deploy (no version check reloads an open page, and an old DM page's light pick would be overwritten).

## 15. For the reviewers: look hardest at

1. The expiry rule of 4.3: the tick inside Next, the Previous filter, the scan of every actor when `clockNow` changes (restores of rounds included) and over a restore's actors, its place before `endSaves`, and the one invariant (D-261107-188, D-261108-092).
2. The `ends` projection and its re-projection through `dependents` on a sharing flip, a stop and a start, against the twin property tests (4.4), and `ends` kept off the create ops (4.7).
3. The claim copied from a DM's head into the restore (4.6).
4. The daylight pass's two triggers, compared by value, and the undo guards a relighting step creates (6.3, 6.5).
5. Flags that stay through Stop and through Players see changes, the `byClock: false` every hand pick sends, and the deploy reload it needs (6.2, 6.6).

## As built

Built in five parts: the timed model (C2a), the time span client (C2b), the daylight model (C3a), the daylight client (C3b), and the docs. The rules work took steps 51 to 53 and snapshot 40 first, so the two phases were renumbered once, to OP 54 and SNAPSHOT 41 for C2 and OP 55 and SNAPSHOT 42 for C3. The update notes in docs/self-hosting.md read room format 41, change format 54 and room format 42, change format 55. No key or gesture is new, so the shortcut sheet and FEATURES.md's Shortcuts are unchanged.

**C2, time spans**

- `heldClock(state, viewer)` in shared/project.ts is the one rule for "the view holds the clock". Spans, their refusals and the projection all read it. A player's own copy of the room carries a shared clock with no `shown` switch, so a copy with no switch reads as shown and the player's device replays its own span as the server applies it (D-261108-130). It stays in project.ts beside `paused` and joins project.clip.test.ts's list of reducer imports that read no walls (D-261108-131).
- The scan is `endDueSpans` in shared/reducer/actors.ts, and its refusal words, "Start the clock first." and "The DM isn't sharing the date and time.", live in shared/rules/durations.ts for the client.
- Previous's filter reads the current time after the whole Previous, so a Previous that walks back over several steps leaves out every span the later time still reaches (D-261108-133). A restore scans every creature it wrote, through `tx.touched()` (D-261108-134).
- stateSchema also refuses an effect with both `duration` and `ends`. The import case is tested through `parseRoomState` and `remapState`, saved steps included. The restore's claim is tested in server/rooms/clock.itest.ts and the rest of the undo cases in undo.test.ts.
- The self-hosting note says "room format 41, change format 54" in the house words (D-261108-132).
- The time spans are modes of the one Duration select, not a second select. The client's `ownKindOf` and `CLOCK_STEP` were replaced by `ownClaimOf`, so a device knows its own clock lines by claim and the same-kind guess is gone. `partyRestOps` gained a claim argument, which touched CharactersPanel.tsx.
- The display's date and time pill stands under the turn pill, in a column both share (DisplayRoom.tsx `TopPills`). `chipName` is the pill's text with "Time: " dropped.
- e2e/timed.e2e.ts has steps tm-0 to tm-5. e2e/durations.json gives alignment-settings 400 and timed 80.

**C3, daylight**

- `byClock` is stored as design 6.2 says and dropped from a player's and a display's scene by the contract commit, so no commit of the stack sends it to a player (D-261108-161). The bounds of dawn and dusk live once, as `DAYLIGHT_BOUNDS` in shared/calendar.ts.
- shared/undoScope.ts, which section 7 did not list, gains `byClock` among the vision fields. Without it every Bright, Dim or Dark pick, which now sends `byClock: false`, would turn Setup (D-261108-160).
- The pass also relights when a fight goes away without End the fight, which is an Undo of its start, since the rounds it counted leave the current time with it. With no fight the 6.3 invariant then holds exactly (D-261108-162). An Undo of End the fight moves the clock back, so the level reads the restored time with the rounds. When the rounds had passed dusk the map stays Dim (D-261108-163).
- Weather is a play step, so 6.5's case of an Undo setup of a scene's weather became a rename, in both directions, in the cross-scope guard test.
- Clock start sends no `daylight`, so a new clock reads 6:00 AM and 6:00 PM, and an Undo setup of a Stop brings the old pair back. The import case is tested through `remapState` in server/rooms/stateSchema.test.ts.
- Time of day is a separate `lightChoices` list, not a fourth entry of `LIGHT_LEVELS`, since the phase selects and the Universal VTT import share that list. Its Segmented uses `grow`, not `even`, which cramped "Time of day".
- "It is Dim now" reads the stored level, not `lightAt` computed in the client. The Dawn and dusk row keeps its value on the left and Change on the right.
- client/features/vision/playersSeeRules.ts's `likeSummary` says "Time of day".
- The ck-d alignment root, a step from the chip's popover that ends an effect while its notice shows, found a real overlap: the alerts column ran under the popover. The fix is `popoverFoot` in the bar's dock (ChipMenus.tsx `useClearance`, barDock.ts, InitiativeStrip.tsx), which starts the column below the popover while it is open, for the whole column and not only where the boxes overlap, so cards never jump as widths change. The "notice" is an alert card, not a toast. ck-d is no longer marked todo.
- e2e/daylight.e2e.ts runs on E2E_PORT plus 61. Its dl-2 is Dawn and dusk (the refusal, focus, the undo label), dl-3 is dawn at 5:30 AM and dl-4 is a hidden clock. The design's case of a Night phase turning Time of day off is covered by reducer tests, since a phase needs an uploaded map image. ck-e is the new alignment root, with the Light group shown, hidden and stopped, and the Dawn and dusk row open and refused. e2e/durations.json gives daylight 60.

**Not covered.** The Night phase case has no browser test. When ck-a, ck-b and ck-d run alone through the name filter, the clock chip is missing at 1440 x 900 and 130%. They pass in the file's order, and this was so before the calendar's C2 and C3.

**Docs.** FEATURES.md (Conditions and statuses, Fog and vision, Date and time, The table display) and the DM guide (Time of day light, Dawn and dusk, Timed effects, and the table display's paragraph) carry the feature. The guide has three new pictures. The table display's pill and the Other length row have none: the pill is a line of text, and the Other row adds only the Length and Unit line under a select that now stands in full width. That select was cut off at the side panel's width until FieldRow's `stack` put the Duration label on a line of its own over the select, as it does for "Counted on" and "X is". The alignment check measures the select's name for it.

**Keeping a duration.** An effect with a count of turns or an end opens Duration on a first choice, "Keep current duration", which sends nothing. A native select fires no change when its shown option is picked again, so opening on "No duration" made that choice impossible to make first. `openingForm` and `durationEdit` (durations.ts) build the opening form and the patch, and e2e/timed.e2e.ts tm-6 covers saving untouched and clearing at once for an end and for a count.

## Round 1

Reviewers dcal-opus and dcal-astra, dispositions by the design's owner. Every finding was adopted.

- **DCAL-OPUS-01 = DCAL-ASTRA-01 (P2)**: Previous leaves out a timed effect whose end the time after it still reaches, with no new line (3.3, 4.3, 4.5, D-261107-188). Cases for Next, a step or Set, then Previous, and the random mix weights those sequences (10, 11).
- **DCAL-OPUS-02 = DCAL-ASTRA-02 (P2)**: the daylight pass relights every following scene only on a real clock change, and one scene only when its own light settings changed, compared by value, so `bumpWalls` bookkeeping and unrelated Undos relight nothing (1, 5.1, 6.3, D-261107-193). Cases for door.set and build paints mid-fight past dusk, another scene's weather, and an unrelated Undo (10, 11).
- **DCAL-OPUS-03 = DCAL-ASTRA-03 (P2)**: shared/permissions.ts joins C2a with a span branch that keeps the ownership and hidden-effect tests, tested single, update and bulk with every clock state (4.2, 7, 11). server/rooms/undoLabels.ts joins C3a with "changing dawn and dusk" (5.2, 6.2). words.ts's `chipName`, `timeLine` and `toDawn` take the whole clock as a required argument. ClockChip.tsx and ChipMenus.tsx go to C3b, and C3b's changes to StepButtons.tsx and DisplayRoom.tsx stack on C2b (6.2, 7, 12).
- **DCAL-OPUS-04 (P2)**: `ends` is accepted only on the import side, through `actorSchemaForImport`'s effect element, and create ops keep refusing it. No player bypass existed (permissions.ts:2950, :3173), and the note says so. Spans reach `actor.effects` and `actor.outcome` under the same refusals (4.2, 4.7, D-261107-187).
- **DCAL-OPUS-05 (P2)**: both steps get a deploy note to reload pages left open (docs/self-hosting.md:572), DM pages first for C3, and rollback lines in migrate.ts's form (4.7, 6.6, D-261107-195).
- **DCAL-OPUS-06 (P3)**: the scan runs before `endSaves`, with a case for a save-ends request (3.3, 4.3, 10).
- **DCAL-OPUS-07 (P3)**: one trigger, a real change of the clock (presence, `id` or `t`), plus a restore's touched actors, which also covers a start that reuses an id (4.3, 10, D-261107-188).
- **DCAL-OPUS-08 (P3)**: the summary says a hidden clock's date and time never reach a player, and 3.4 lists what players can still tell. The DM help reads "they see how long this lasts and when it ends" (Summary, 3.1, 3.4).
- **DCAL-OPUS-09 (P3)**: every span refusal is `invalid`, the player's one wording for all three cases, tested for the same code and message (3.4, 4.2, D-261107-189).
- **DCAL-OPUS-10 (P3)**: claims go only on the ops that can write a line. The sharing switch and Dawn and dusk send none, which keeps C3b off claim.ts (4.6, D-261107-191).
- **DCAL-OPUS-11 (P3)**: the model comments read "Absent exactly when `at` is" and name the restore's claim as the history head (4.1).
- **DCAL-OPUS-12 (P3)**: remap.ts:650's comment changes, in C2a (4.6, 7).
- **DCAL-OPUS-13 (P3)**: No duration on a timed effect sends `duration: null`, in C2b with a client unit case (3.1, 7, 10).
- **DCAL-OPUS-14 (P3)**: D-261107-186 to 195 are appended to the decisions log.
- **DCAL-OPUS-15 (P3)**: a twin property for a hidden clock's `daylight`, and 4.5 says a Calendar save's ends guard across scopes (4.5, 10, 11).
- **Versions**: C2 and C3 take the next free OP_VERSION and SNAPSHOT_VERSION in stack order, written as 54, 41, 55 and 42 (Summary, 1, 4.7, 6.6, 12, D-261107-195).

## Round 2

Reviewers dcal-opus and dcal-astra, dispositions by the design's owner. Both agree with every round 1 change except the narrowed restore scan of OPUS-07, which round 2 corrects.

- **DCAL-OPUS-16 + DCAL-ASTRA-04 (P2)**: adopted as one fix (D-261108-092). The C2 trigger compares `clockNow`, so any op that moves the current time, a restore of the encounter's rounds included, scans every actor in the room, and every restore still scans its touched actors. Astra's sequence (rows replaced, Previous back to round 1, a co-DM's 1 minute effect, Undo of the Previous) and Opus's (Undo of a Next, a Calendar save, Redo of the Next) join the reducer and server Undo cases, and the random test weights them. D-261108-092 says "every actor on the scene", read here as every scene's, since the clock and its effects are the room's (3.3, 4.3, 8, 10, 11, D-261107-188).
- **DCAL-OPUS-17 (P3)**: adopted. Both rollback lines take the house form, "a room with version 54 ops after its last snapshot or a v41 snapshot, which an older build refuses", and the same for 55 and 42 (4.7, 6.6).
- **DCAL-OPUS-18 (P3)**: adopted. `toDawn`'s signature change moves to C3b's commit stacked on C2b, and `chipName`'s goes with it, since C2b's display chip calls it. The earlier commit changes `timeLine` and TimePanel.tsx only, so each commit typechecks (6.2, 7, 12).
- **Versions**: unchanged. C2 and C3 take the next free steps at stacking.
