# raccoon-vtt: the in-game calendar and time of day


Status: built as phase C1 (see As built). From docs/design/mvp.md section 16, Later: "In-game calendar and time of day." Code is cited from main at `5948c7e0` (v0.3.0), where OP_VERSION was 40 and SNAPSHOT_VERSION 31. The build took OP_VERSION 42 and SNAPSHOT_VERSION 32, and the text below says the built numbers. Decisions are D-261102-115 to D-261102-124 (section 14), and the build's own are in As built. The note went through three design reviews, listed at the end.

## Summary

- **A room clock the DM keeps.** Off until the DM starts it. One number of in-game seconds, read through a calendar: the default **Day count** ("Day 4, 6:00 AM") or the DM's own **Months** calendar (named months with their lengths, an optional week of named days, and words after the year).
- **One Time panel** holds it: the date, the time and the part of the day for everyone, and for the DM the steps that move it on (10 minutes, 1 hour, 8 hours, To dawn, any amount), Set the date and time, Calendar, and "Players see the date and time". From 900 px up a small chip in the top bar shows it too.
- **It ties into what exists.** The DM's party Long Rest moves the clock 8 hours. A fight adds 6 seconds a round when it ends, and one current time (5.1) counts it for everything that reads "now". Each character remembers when its last Long Rest ended, so the DM's rest card gives the earliest next start the 16 hours of the rules allow. Each clock change, its Undo and Redo included, writes one Log line, toasts on players' devices, and the journal editor gains "Add the date".
- **Privacy.** With "Players see the date and time" off, no player device receives the clock, its lines or any rest stamp.
- **Small first build, phase C1.** Time-span durations (spells of 1 minute to 24 hours that run out as the clock moves) are phase C2. Scene light that follows the time of day is phase C3, opt-in per scene. Section 13 says what waits.
- **Versions.** C1 takes snapshot 32 and op 42, each an identity step.

## 1. Today

- Durations count rounds only (`Effect.duration`, shared/rules/durations.ts): N rounds, or the start or end of a chosen creature's turn, at most 1,000 rounds. Outside a fight they pause.
- The round counter runs in the encounter (`Encounter.round`, starting at 1, with `activeEntryId` null until Start). Players always receive the round.
- Rests: `actor.rest` (short or long) for the DM and the creature's owner, from the Rest section (client/features/tokens/RestSection.tsx), and the DM's "Long Rest for the party" in the Characters panel (client/features/tokens/CharactersPanel.tsx `PartyLongRest`), sent as one gesture. Neither knows the time.
- A scene's light is Bright, Dim or Dark under party vision (`SceneVision.light`). The DM sets it, and so does switching to a map phase that carries a light level of its own (shared/reducer/phases.ts `withPhaseLight`), so a Night phase can make the scene dark.
- The Log stamps lines with real time (`LogEntry.at`), and Export splits evenings by real time. Journal pages are the DM's Markdown blocks.

## 2. The rules (SRD 5.2.1)

- **Combat, "The Order of Combat"** (p. 13): "A round represents about 6 seconds in the game world."
- **Resting** (p. 16): "Any creature can take hour-long Short Rests in the midst of a day and an 8-hour Long Rest to end it."
- **Rules Glossary, "Long Rest"** (p. 185): "at least 8 hours", and "After you finish a Long Rest, you must wait at least 16 hours before starting another one." An interrupted rest "requires 1 additional hour per interruption to finish."
- **Rules Glossary, "Short Rest"** (p. 187): "a 1-hour period of downtime".
- **Spells, "Duration"** (p. 106): a time span "might say '1 minute,' meaning the spell ends after 1 minute has passed." (Phase C2.)
- **Exploration, "Vision and Light"** (p. 11): "Even gloomy days provide Bright Light", "The soft light of twilight and dawn also counts as Dim Light", and "Characters face Darkness outdoors at night (even most moonlit nights)". (Phase C3.)
- **Magic Items, "The Next Dawn"** (p. 206): items recharge "at the next dawn", and where dawn never comes "the GM determines when the item recharges." (Waits, section 13.)
- **Travel Pace** (p. 12) gives distances per minute, hour and day. The app does not compute travel. The DM moves the clock by the time a trip takes.

The SRD names no calendar. Published settings' calendars are not SRD content, so the app ships none and the DM types one in.

## 3. How other VTTs do it (ideas only)

- **Foundry VTT** keeps world time in seconds, moves it on by a set time per combat round, and its D&D system and modules (such as Simple Calendar) add named calendars, a clock on screen and rests that move time. Taken: seconds as the one number, 6 seconds a round, rests that move the clock. Left: a clock that ticks with real time.
- **Fantasy Grounds** has a calendar window with settings' calendars and notes kept on days. Taken: the DM's own months and weekdays. Left for later: notes on a date.
- **Roll20** and **Owlbear Rodeo** leave it to scripts and extensions. Taken: nothing, which says a plain built-in clock is already more than most groups have.

## 4. What the DM and players see and do

### 4.1 Starting the clock

The DM opens **Time** (a new panel, "In play" group, after Areas, and in a DM's "Run the table" group since the panel groups change). With no clock it reads:

- "Track the in-game date and time. You move the clock on as time passes. Party Long Rests and fights move it too."
- **Calendar**, two radio cards: **Day count** ("Day 1, Day 2 and on.") and **Months** ("Months, weekdays and years with names you choose."). Months opens the Calendar dialog (4.3), whose Save only keeps the calendar as a draft on this form, named beside the card ("12 months, 7-day week", with Change). Nothing is sent until Start the clock.
- **It is now**: Day `1` (or, after Months, the month, day and year), and a time field at 8:00 AM.
- Switch **Players see the date and time**, on: "Off, players see no date or time anywhere, not even in the Log."
- **Start the clock** (primary): the one `clock.start`, with the calendar, the date and the switch as the form holds them. So a hidden Months clock never reaches a player, its start line included.

### 4.2 The Time panel

For everyone with a clock, at the top, in a polite live region:

- The date, large: "Day 4", or "Tuesday, Deepwinter 3, 1204 AF".
- "6:00 AM, Dawn". The parts of the day are fixed in C1: Dawn 6 to 7 AM, Morning 7 AM to noon, Afternoon noon to 6 PM, Dusk 6 to 7 PM, Night 7 PM to 6 AM.

For the DM, under it:

- During a fight: "When the fight ends, the clock moves on 6 seconds for each round." While the clock is hidden: "Players don't see the date and time."
- **Move the clock on**, a group of four buttons in a 2 by 2 grid: **10 minutes**, **1 hour**, **8 hours**, **To dawn** (the next 6:00 AM). Each is one `clock.advance`. Then **Other amount…**, which opens a row in place: a number field, a unit (Minutes, Hours, Days) and **Move on**.
- **Set the date and time…** opens a dialog (4.3).
- Switch **Players see the date and time**.
- **Calendar…**, its value beside it ("Day count", or "12 months, 7-day week").
- At the foot, **Stop the clock** (danger, armed second tap): "Removes the date and time for everyone. Undo setup in Setup history brings them back."

Every step applies at once and shows on every device. A mistake is the top bar's Undo. Setting the clock back is Set, never a negative step.

### 4.3 Set the date and time, and Calendar

**Set the date and time** (Dialog): for Day count, a Day field. For Months, a Month select, a Day field and a Year field, with the weekday read out under them ("A Tuesday."). A Time field (`<input type="time">`, the phone's own picker). **Set** and Cancel. A day past the month's length or a year out of range keeps the dialog open with the reason ("Pick a day from 1 to 30."). Set sends only when a field changed, and a date changed alone keeps the clock's seconds (As built, review round 1).

**Calendar** (Dialog, DM only):

- The two radio cards of 4.1.
- For Months: one row per month, Name and Days, with Move up, Move down and Remove ("Remove Deepwinter"). **Add a month**. New calendars start with 12 rows, "Month 1" to "Month 12", 30 days each. Help: "A 1-day month, such as a festival day, shows by its name alone."
- **Day names**: one field, "In order, split by commas. Leave it empty for no week."
- **After the year**: one field, "Words after the year, such as an era's initials. Leave it empty for none."
- "A year is N days.", with N counted from the rows as they are edited (`yearDays`).
- **Today in this calendar**: the date fields of Set, filled from the clock's current time (5.1) as the new calendar reads it, or with the first day of year 1 when the kind changed, keeping the time of day. A kind change starts it again from the first day even after the DM typed in it.
- **Save** and Cancel. With a clock running, Save sends one `clock.update`, with a time only when the DM edited Today or changed the kind. Before the clock starts, Save returns the draft to the start form (4.1). With anything changed, Cancel and a swipe ask "Discard changes?" as the New character form does. Renaming months or days writes no line.

### 4.4 What players see

- While the DM shares it, players get the Time panel (date, time, part of the day, nothing else), the top bar chip from 900 px up, a toast for each clock line while the Log and the Time panel are closed, and the lines in the Log.
- Behind a blackout players get no clock and no clock lines, as they get no encounter and no encounter lines, and get both back when it ends.
- With sharing off, or no clock, the Time panel is not in their list. A player whose Time panel is open when sharing stops keeps it open, reading "The DM isn't sharing the date and time now.", until they close it.
- The table display shows nothing new in C1 (section 13).

### 4.5 Rests

- **Long Rest for the party** gains a checkbox, while a clock runs: **Move the clock on 8 hours**, ticked. "Finish the Long Rest" then sends one gesture: `clock.advance` (8 hours, `why: "longRest"`) first, then the rests, so each stamp marks the rest's end. Its Undo step reads "Undo the party's Long Rest". There is no new party-rest op.
- A gesture is ops sent together, not one transaction (client/state/actions.ts `dispatchGesture`). So: an advance the server refuses (past `clockSecondsMax`) leaves the rests going through at the time as it was, with the refusal's toast. A rest the server refuses, such as a character that fell to 0 HP meanwhile, leaves the advance and the other rests standing, with its own toast. And Undo takes the gesture back in one step only while it merges (server/rooms/undo.ts): another op between its ops, or a character someone else changed in between, splits it into more steps, as it does for any gesture today.
- A rest of one creature, from its Rest section, never moves the room's clock: two players resting would move it twice. The DM moves the clock for a party's Short Rest with **1 hour**.
- Each character's Long Rest records when it ended (`Character.longRest`, DM only, 6.1). When the DM chooses a Long Rest for a character, or opens the party's card, the card has a line for each character in a window after its stamp. A rest that moves the clock (the party card with its checkbox ticked) starts now, so its window ends at the stamp plus 16 hours. A rest that does not move the clock (one creature's, or the party card unticked) is recorded as it finishes, so it began about 8 hours before now, and its window ends at the stamp plus 24 hours (CAL-R2-3). The line: "Bree finished a Long Rest at Day 4, 6:00 AM. The rules let the next start from Day 4, 10:00 PM." It names times only. It never says whether a rest was taken, or when this one began, which the app does not know. A stamp after the current time, left by Set or an Undo of the clock, reads the same, so it never shows a negative age. It is shown, never enforced, as known forms' limits are.

### 4.6 Fights

- While a fight runs, the current time (5.1) is the stored time plus 6 seconds for each round before the current one. The panel shows minutes, so this shows after 10 rounds. The panel, the lines, the stamps, Set, To dawn, Today in this calendar and Add the date all use it.
- **End the fight** adds 6 seconds for each round it ran, the current one counted whole, in the same op. A fight counts as started when `round > 1 || activeEntryId !== null`. A fight never started adds nothing. The one edge: a fight started and then emptied of every row in round 1 counts as never started, so at most 6 seconds go uncounted. An end that would take the clock past `clockSecondsMax` stops at it rather than refuse the end. Previous needs nothing, since the round it puts back is the count.
- A clock started or Set mid-fight reads the time the DM typed. The reducer stores that time less the fight's seconds so far, so the rounds after it add on and the end counts only them.

### 4.7 Log, toasts and the journal

- Each clock change writes one line, with the date as it read then:
  - "8 hours pass. It is now Day 4, 6:00 AM." ("1 hour passes.", "2 days and 3 hours pass.")
  - "8 hours pass in a Long Rest. It is now Day 4, 6:00 AM."
  - "The DM sets the date and time: Tuesday, Deepwinter 3, 1204 AF, 6:00 AM." (Set, and a calendar save that changed the date.)
  - "The DM starts the clock: Day 1, 8:00 AM."
  - "The DM undid a clock change. It is now Day 3, 10:00 PM." ("redid" for Redo.) The DM's Undo or Redo writes it, as HP corrections write theirs, under the rule of 6.3: both clocks exist, the stored time and the date text both change, and never for an undone fight's end.
- A fight's seconds, a calendar save that kept the date, the sharing switch and Stop write no line.
- A player keeps every clock line that reached them, after a reload too, when sharing goes off later or the clock stops.
- Players and co-DMs get the line as a toast while their Log and Time panel are closed. The DM device that made the change does not.
- The journal editor gains **Add the date** beside Add a secret, while a clock runs: a new text block reading `### Day 4, 6:00 AM`.

### 4.8 Layouts

- **Phone held upright**: Time is a sheet from the Panels list. The four steps sit 2 by 2 and become one column where the sheet is narrower than 360 px of content (320 px at 130%). No top bar chip.
- **Phone held sideways**: the sheet on the right, as other panels. No chip.
- **Tablet held upright**: the sheet stands in the middle of the map, as other panels do there. No chip.
- **Tablet held sideways and computer (900 px and up)**: Time is a side panel tab (in More until the tab row has room). The top bar chip, "Day 4, 6:00 AM" or "Deepwinter 3, 6:00 AM", sits before Undo. From 900 px up the turn strip never moves to the band (TopBar's `measured` is phones only), so the chip's step is the first of the wide row's steps, before the blackout notice folds, and it comes back when the row has room: a wider window, or a shorter date than the one that overflowed. The row's overflow check runs whenever the chip shows, a player's row included, which today checks only with Full screen or the View button (client/pages/Room.tsx `checks`), and the chip's text joins the check's dependencies. A tap opens the Time panel.

## 5. Calendar math (`shared/calendar.ts`, new, pure)

- `t` is whole seconds from the calendar's first moment at midnight: Day 1 for Day count, the first day of year 0 for Months. So a date is `day = floor(t / 86400)`, and for Months `year = floor(day / yearDays)` and the day of the year is what is left, both by floor so years before 0 work. The weekday is `day mod week.length`, kept non-negative.
- The calendar changes only how `t` reads. `t` itself, every rest stamp and every stored line keep their meaning.
- A month of 1 day reads by its name alone ("Midwinter, 1204 AF"). Day count reads "Day N" with `N = day + 1`.
- Exports: `dateOf`, `timeText` ("6:00 AM", "12:00 PM"), `partOfDay`, `dateText(t, cal, "full" | "short")`, `lineDate` (date and time, at most `LIMITS.clockDateChars`), `spanText` ("2 days and 3 hours", minutes the smallest unit shown), `composeDate` (fields to `t`, or the reason it is out of range), `nextDawn`, `fightStarted(encounter)`, `fightSeconds(encounter, ended)`, `clockNow` and `yearDays`.

### 5.1 The current time

`clockNow(clock, encounter)` is the one current time: the stored `t` plus `fightSeconds(encounter, false)`, held within `±clockSecondsMax` for display while a long fight runs near the limit. Every reader of "now" calls it, client and reducer alike: the panel and chip, each line's date, a stamp's `at`, To dawn (`by = nextDawn(now) - now`), the 16-hour note, Today in this calendar and Add the date. An op that names a time (`clock.start`, `clock.set`, `clock.update`'s `t`) carries it as the DM read it, and the reducer stores `t = time - fightSeconds(encounter, false)`, so `clockNow` then returns the time typed. C2's durations end against `clockNow` too.

## 6. Model, ops and versions

### 6.1 State (shared/model.ts)

```ts
export type CalendarMonth = { name: string, days: number }
export type Calendar =
  | { kind: "days" }
  | { kind: "months", months: CalendarMonth[], week?: string[], era?: string }
export type RoomClock = {
  /** A new id at each start, so a rest stamp from an earlier clock reads as none. */
  id: string
  rev: number
  /** Whole seconds from the calendar's first moment (shared/calendar.ts). */
  t: number
  /** Players receive the clock and its lines. */
  shown: boolean
  calendar: Calendar
}
// RoomState.clock?: RoomClock | null. Absent and null are both "no clock".
// Character.longRest?: { at: number, clock: string }. DM only. Written by actor.rest, never by a client patch.
// LogEvent gains { type: "clock", date: string, by?: number, why?: "longRest" | "set" | "start", from?: "undo" | "redo" }.
```

The clock is its own singleton key (`keys.clock`), like the encounter. Rejected: a field of `RoomMeta`, where every step would collide with settings in undo guards (D-261102-117).

### 6.2 Ops and permissions (shared/protocol.ts, shared/permissions.ts)

| Op | Fields | Who | Undo scope |
| --- | --- | --- | --- |
| `clock.start` | `id`, `t`, `shown`, `calendar` | DM | setup |
| `clock.stop` | none | DM | setup |
| `clock.update` | `calendar?`, `shown?`, `t?` | DM | setup |
| `clock.set` | `t` | DM | play |
| `clock.advance` | `by` (1 s to 100 years), `why?: "longRest"` | DM | play |

A `t` in `clock.start`, `clock.set` and `clock.update` is the time as the DM read it (5.1). `clock.start` is refused while a clock exists, the others while none does. Bounds (CAL-ASTRA-08): `clock.start`, `clock.set` and `clock.update` are refused unless both the time named and the stored baseline it makes (`time - fightSeconds(encounter, false)`) lie within `±LIMITS.clockSecondsMax`. `clock.advance` is refused unless both `clockNow + by` and the stored `t + by` lie within it, so a clock already held at the limit by a fight's seconds never takes a step it cannot show. Each refusal reads "The clock can't go that far." The fight's end is the one exception: it clamps the stored `t` at the limit and never refuses (4.6). The calendar schema bounds every list and name (6.7) and uses the name characters rule (`NAME_CHARS`). `characterPatch` gains nothing, so no client writes `longRest`.

### 6.3 Reducer (shared/reducer/clock.ts, new)

- The five handlers write `keys.clock` and the line of 4.7, its `date` from `lineDate(clockNow(...))` after the change. A time an op names is stored less the fight's seconds (5.1).
- `encounterEnd` (shared/reducer/encounter.ts): with a clock and `clockTicks(opVersion)`, adds `fightSeconds(encounter, true)` to `t`, held at `clockSecondsMax`, no line.
- `actorRest` (shared/reducer/actors.ts): a long rest of a character, with a clock and `clockTicks(opVersion)`, writes `longRest: { at: clockNow(...), clock: clock.id }` on the character it already touches.
- An undo or redo restore (`sys.restore`) writes the clock line with `from` and the date after only when a clock exists before and after, its stored `t` changed, and `lineDate(clockNow(...))` reads differently before and after (CAL-R2-1, CALB-O-01). A restore of a round's Next or Previous, or of a calendar rename, leaves `t` alone and writes none, though the date it reads may change. A restore that brings back an ended fight writes none, even where the fight's seconds cross a minute, since the DM undid the fight's end, not a clock change. The line sits beside the correction lines of shared/undoCorrection.ts, whose `correctionViews` today covers only tokens, characters and companion blocks, and it follows their gate in shared/reducer.ts (CAL-R2-2): `writesUndoCorrections(opVersion)`, a `sys.restore` with `correction` and `scope`, no `undid`, and a DM actor. So a player's restore writes no clock line. That gate passes every op version from 34 on (`writesUndoCorrections` in shared/migrate.ts), so it does not by itself keep older restores out. They are safe because a restore stored before op 42 comes from a room with no clock, and the line needs a clock before and after. The replay of a restore from op 42 on writes the same clock line again, as replay reproduces every line. Its audience follows 6.4.
- shared/reads.ts (CAL-1): `satisfies` fails on any read key that is null, so a clock read is added only where the reading view holds a clock. `clock.start` reads nothing. `clock.stop`, `clock.update`, `clock.set` and `clock.advance` read `keys.clock`, and `keys.encounter` when the view holds one. `actor.rest` and `encounter.end` add `keys.clock` only when `state.clock` is non-null. So a rest still predicts in a room with no clock, and a player's own rest predicts with a hidden clock (no clock in their view, no stamp) and with a shared one. A player's predicted copy may hold the stamp until the server's character replaces it, and no player screen reads it.

### 6.4 Projection and privacy (shared/project.ts)

- The DM gets the clock whole. A player and a table display get `{ id, rev: 0, t, calendar }` while `shown` and no blackout is up, else null. Nothing else of the clock reaches them.
- Behind a blackout (`ctx.paused`) a player and a table display get no clock and no clock line, as for the encounter and its lines (D-261102-429). The clock without the fight's rounds would read the wrong time. A blackout's end re-projects every key, so the clock, the encounter and the lines come back together, and a round after it reaches players by the encounter's key, from which every device reads the clock's current time. A clock line's audience stays the one frozen when it was written, so a line written while shared behind a blackout reaches players at the lift even if sharing went off in between (D-261102-530).
- `Character.longRest` is DM only: every player projection drops it, the character's owners included. So no clock change re-projects characters, and the 16-hour note is the DM's (D-261102-121).
- A clock line's audience is frozen when it is written (CAL-2). `lineReader` decides it from `state.clock?.shown` in the state the op leaves, before `projectEventCtx`: shared when shown, the DM's otherwise. `projectEventCtx` then passes a clock event through unchanged, as it does encounter lines, so a reload after sharing goes off, or after Stop, keeps every line a player reached. Its text holds nothing the line's readers could not see then.
- The fight's seconds come from the round, which players already receive, so the derived clock tells them nothing new.
- View as a player projects on the DM's device by the same rules.

### 6.5 Undo (shared/undoScope.ts, server/rooms/undoLabels.ts)

- Play: "Undo moving the clock on 8 hours", "Undo setting the date and time", "Undo the party's Long Rest" (a gesture whose first op is an advance with `why: "longRest"`). Setup history: "Started the clock", "Stopped the clock", "Changed the calendar", "Players see the date and time: off".
- The party rest gesture is play, all of it. While it merges as one step, its Undo restores the clock and every rested character (4.5 for when it splits).
- The DM's Undo or Redo writes the clock line of 4.7 under the rule of 6.3 (the correction gate, both clocks existing, the stored time and the date text changing, never for an undone fight's end), so players see it while the clock is shown.
- One guard covers the whole clock key, for both scopes (CAL-5, kept). An undo is refused as changed since where anything of the clock changed after it. So a play step refuses a Setup history undo before it: the DM saves a new calendar, then taps 10 minutes, and Undo setup on "Changed the calendar" is refused. The DM opens Calendar and changes it back directly, which needs no Undo. The other way, a calendar save refuses Ctrl+Z on an earlier step, and Set fixes the time. A fight's end writes the clock too, so a step taken before the fight ended cannot be undone after it. All of this is accepted.

### 6.6 Versions, replay, migration, export and import (shared/migrate.ts)

- **Snapshot 32**, identity: `clock` and `longRest` are optional, and absent reads as none. The number moves so a v0.3 build refuses a room that has a clock rather than load it and send players a hidden one.
- **Op 42**, identity: the five ops and the line are new, which an older strict schema refuses. `clockTicks(v) = v === undefined || v >= 42` gates the two changes to existing ops. No op before 42 meets a clock, so the gate cannot change a replay today. It stays as the house pattern of `shared/migrate.ts` (CAL-13), so a later step that does reach older ops has its gate in place.
- Deploy: nothing to do. Open pages reload with the new build. Rollback needs the backup for a room with op 42 ops after its snapshot or a clock in it.
- server/rooms/stateSchema.ts accepts `clock`, `longRest` and the clock line, with the bounds of 6.7. Export and the backup zip carry them with the state (server/rooms/exportRoom.ts), and import checks them (server/rooms/importRoom.ts). server/rooms/remap.ts keeps the clock as it is: it holds no ids but its own, and `longRest.clock` is that id.

### 6.7 Limits and performance

- `LIMITS` (shared/limits.ts): `calendarMonths` 24, `calendarMonthDays` 400, `calendarYearDays` 1,000, `calendarWeekDays` 14, `calendarNameChars` 24, `calendarEraChars` 12, `clockSecondsMax` 10^13 (about 317,000 years of 365 days), `clockStepMax` 100 years of 365 days, `clockDateChars` 120.
- The clock is at most about 1.5 KB. server/rooms/sizeGuard.ts counts it in the room-level measure and each DM projection. A stamp is about 60 bytes on a character. Lines live in the existing rings.
- No timer runs: nothing ticks with real time. The chip and panel re-render only on a clock change or a new round. Every date read is a few divisions and at most 24 steps through the months, so a mid-range phone never notices it. The panel loads lazily, as every panel does.

## 7. Files

- **Shared**: shared/model.ts, shared/calendar.ts (new), shared/protocol.ts, shared/limits.ts, shared/keys.ts (the `clock` singleton in parse, read and write), shared/reducer.ts, shared/reducer/clock.ts (new), shared/reducer/tx.ts (singleton write), shared/reducer/encounter.ts, shared/reducer/actors.ts, shared/permissions.ts, shared/project.ts, shared/reads.ts, shared/undoScope.ts, shared/undoCorrection.ts (the undo and redo line), shared/logText.ts (the line's text from its stored date), shared/migrate.ts.
- **Server**: server/rooms/stateSchema.ts, server/rooms/sizeGuard.ts, server/rooms/remap.ts, server/rooms/undoLabels.ts. Fan-out, persistence, export and import need no code of their own beyond these, which the build checks.
- **Client**: client/features/clock/ (new): TimePanel.tsx, StartClock.tsx, StepButtons.tsx, SetTimeDialog.tsx, CalendarDialog.tsx, ClockChip.tsx, useClockToasts.ts, words.ts. client/features/panels.ts (the Time panel, and `panelsFor(role, wide, { clock })`), client/pages/Room.tsx (the chip in TopBar's row and overflow steps, the toasts hook, the `clock` flag for `panelsFor`, and keeping an open Time panel), client/components/Icon.tsx (`time`: Lucide `calendar-clock`), client/features/tokens/CharactersPanel.tsx, client/features/tokens/RestSection.tsx, client/features/journal/JournalEditor.tsx.
- **Credits**: shared/credits.ts (`calendar-clock` in `LUCIDE_ICONS`) and CREDITS.md. No other asset: the panel draws no sun, moon or art.
- **Docs**: FEATURES.md (a new "Date and time" section, and lines in Characters and monsters, Combat, and Journal), docs/dm-guide.md, docs/design/design.md (6, 7.3, 8.1, 9.5, 10.5, 16.2, 16.4), docs/design/mvp.md (section 16, built), docs/design/README.md, docs/design/design-v1-calendar.md.

## 8. Keyboard, touch, accessibility and assets

- No new key or gesture. The Time panel is reached as every panel is, its letter in More's list included. The shortcut sheet registry and FEATURES.md's Shortcuts stay as they are, and the docs commit says so.
- Every control is a button, switch, field or select of the existing components, 44 px tall, with 16 px inputs. Nothing needs hover or a long press.
- The step group has `role="group"` and the name "Move the clock on". Each step's name says what it does: "Move the clock on 10 minutes", "Move the clock on to dawn, 6:00 AM". The date block is a polite live region, so the DM hears the new date after a step. The chip's name is "Time: Day 4, 6:00 AM, Dawn", and so is its tooltip.
- Dialogs trap focus, start on their first field and give focus back to the button that opened them. A refused field names the reason under it, linked by `aria-describedby`.
- Colors are theme tokens only (client/lib/theme.ts), so contrast holds as it does in every other panel, and the coming light theme needs nothing of its own here. Nothing moves, so reduced motion changes nothing.

## 9. UI checklist

- **Loading**: the panel's lazy load uses the shared indicator. Every op is applied at once. A refusal comes back as the existing refusal toast with the server's reason, and the step's line never appears.
- **Keys and focus**: Tab order follows reading order. Escape closes a dialog first, then the sheet. Other amount's row takes Enter as Move on.
- **Screen readers**: names as in section 8. The weekday line under Set's fields is in a polite live region.
- **Large interface sizes**: at 130% on a 320 px phone the steps are one column, the Calendar rows keep Name and Days together and wrap their three buttons under them, and the chip leaves the top bar sooner.
- **Alignment**: the sweep (e2e/alignmentRoom.ts) gains roots for the DM's Time panel with and without a clock, Set, Calendar with 12 months, Pat's Time panel, and the party rest card with its checkbox and note, each at 1440x900, 390x844 and 320x568, at 100% and 130%, and the chip at 1440x900 only, at 100% and 130%, since it never shows below 900 px.
- **The words**: panel "Time". Buttons "Start the clock", "10 minutes", "1 hour", "8 hours", "To dawn", "Other amount…", "Move on", "Set the date and time…", "Set", "Calendar…", "Add a month", "Save", "Stop the clock", "Add the date". Switch "Players see the date and time". Checkbox "Move the clock on 8 hours". Notes and lines as quoted in section 4.

## 10. Cases

| Case | Expected | Test |
| --- | --- | --- |
| DM starts a Day count clock at Day 1, 8:00 AM, shown | Everyone's Time panel reads "Day 1", "8:00 AM, Morning". One shared line | reducer, e2e ck-1 |
| DM taps 8 hours at 10:00 PM | Day 2, 6:00 AM, Dawn. Line "8 hours pass." Pat gets a toast | reducer, e2e ck-2 |
| To dawn at exactly 6:00 AM | The next day's 6:00 AM | calendar unit |
| A step past `clockSecondsMax` | Refused, "The clock can't go that far." | reducer |
| Player sends any clock op | Refused | permissions |
| Clock hidden, DM moves it 3 days | Players receive no clock change and no line. The DM's line only | projection, itest |
| Sharing turned on again | Players get the clock as it is now, and none of the lines written while hidden | projection, itest |
| Pat's Time panel open when sharing stops | It stays open with "The DM isn't sharing the date and time now." and leaves the list once closed | e2e ck-5 |
| Party Long Rest with the checkbox, outside a fight and in round 11 | Advance first, then each rest, each stamp's `at` equal to `clockNow` after the advance (60 s past stored `t` in round 11). "Undo the party's Long Rest" takes all back while it merges | reducer, e2e ck-3 |
| Party rest whose advance is refused at the limit | The rests go through at the old time, the refusal toasts | server (undo.test.ts) |
| Party rest with one character stale (0 HP now) | That rest refused with its toast, the advance and the other rests stand | server (undo.test.ts) |
| Long Rest 6 hours after the last | The DM's card gives the last finish and the earliest next start. The rest still goes through | client unit, e2e ck-3 |
| A rest that moves the clock, now 15 h 59 min and 16 h after the stamp | A line at 15 h 59 min, none at 16 h | client unit |
| A rest that does not move the clock, now 23 h 59 min and 24 h after the stamp | A line at 23 h 59 min, none at 24 h | client unit |
| One creature's rest outside a fight and in round 11 | Its stamp's `at` equals `clockNow` when the rest applies | reducer |
| Stamp after the current time (Set back, or Undo of a step) | The same two times, never a negative age | client unit |
| A player rests their own character | No clock change. The stamp is written but never reaches any player | reducer, projection |
| DM rests, or ends a fight, in a room with no clock | Predicted at once (no clock read) | reads.test.ts |
| Pat rests his own character with the clock hidden, and with it shared | Predicted at once both ways | reads.test.ts |
| Undo and Redo of an 8-hour step while shown | A "The DM undid a clock change" line and a "redid" line, each toasting Pat | reducer, projection |
| Pat reloads after sharing goes off, and after Stop | He keeps every clock line he reached | projection |
| A hidden Months clock started | No clock and no start line reach Pat | projection, e2e ck-4 |
| Set to 9:00 AM in round 11 of a fight | Panel and line read 9:00 AM. The end adds only the rounds after it | reducer |
| To dawn and a rest in round 11 | Both count from the current time, fight seconds included | reducer |
| A fight's end that would pass `clockSecondsMax` | The clock stops at the limit, the end goes through | reducer |
| Set to `-clockSecondsMax` in round 11 | Refused: the stored baseline would be 60 s below the limit | reducer |
| Advance 10 s with stored `t` at `clockSecondsMax - 30` in round 11 | Refused: `clockNow` is already held at the limit | reducer |
| Undo of End the fight, its seconds crossing a minute | No clock line | reducer |
| Undo of an 8-hour step, then a player's own undo, then a replay of a v41 restore (a room with no clock), then a replay of the op 42 undo | A clock line for the DM's undo and the same line again on its replay, none for the player's undo or the v41 restore | reducer |
| Undo of a Next that crosses a minute, and Undo setup of a calendar rename | No clock line: the stored time did not change | reducer |
| Blackout up, then a step, then the blackout lifted in round 11 | Players and the table display get no clock and no line meanwhile, then the clock at the DM's time with the fight's seconds and every line | projection, itest |
| Calendar saved after a 3-round fight with only a rename, and Set pressed untouched | No line, the clock keeps its 18 seconds, and the lower bound saves unchanged | client unit, e2e cf-1 |
| Start, every row removed in round 1, End | Counted as never started, at most 6 s lost (documented edge) | reducer |
| Stop, then start a new clock | Old stamps read as none (other clock id). Undo setup of the stop brings the clock and the stamps' meaning back | reducer |
| Fight ended in round 3 after Start | Clock +18 s, no line | reducer |
| Fight ended before Start | Clock unchanged | reducer |
| Undo of the fight's end | Encounter and clock both back, no clock line | reducer |
| Months calendar of 12 x 30 with a 7-day week, a 1-day festival month | Dates and weekdays read right across year ends and before year 0 | property |
| Calendar saved with the date changed | One setup step and the "sets the date" line. Saved with the date kept, or only renamed: no line | reducer |
| Undo setup of "Changed the calendar" after a 10-minute step | Refused as changed since (one guard for the whole clock) | server (undo.test.ts) |
| Months renamed after lines were written | Old lines keep the names they were written with | logText |
| Replay of a v40 `encounter.end` or `actor.rest` | Writes no clock and no stamp | migrate |
| v0.3 build opens a v32 snapshot | Refused by version | migrate |
| Export and import of a room with a clock | Clock, calendar and stamps come back whole | importRoom |
| Top bar at 1024 px with blackout and a long room name | The chip leaves first, the rest of the row as before | e2e alignment-wide |
| Pat's top bar at 1024 px, no Full screen and no View button, long date | The row still runs its check, and the chip leaves when it would overflow | e2e ck-6 |

## 11. Tests

- **Unit**: shared/calendar.test.ts (every export, the words, bounds, 12:00 AM and PM, negative days, `fightStarted`, `clockNow` held at its bounds), shared/logText.test.ts (the lines, undo and redo included), client/features/clock/words.test.ts (step names, the note's two windows at 15 h 59 min and 16 h and at 23 h 59 min and 24 h, a stamp after now, chip text), client/features/panels.test.ts (the Time panel listed for players only with a clock), shared/reads.test.ts (the cases of CAL-1: a DM's rest and fight end with no clock predicted, a player's own rest with a hidden clock and with a shared one predicted, `clock.start` with no reads).
- **Property** (fast-check): shared/calendar.property.test.ts, over random calendars within the limits and random `t`: `composeDate(dateOf(t)) === t` with its time of day, months and days always in range, a step of N days moves the weekday by N, `lineDate` within its cap.
- **Reducer**: shared/reducer/clock.test.ts (each op and refusal, the two ties, the line audiences, ops during a fight against `clockNow`, a mid-fight start, the end's clamp, the bounds of both the named time and the stored baseline, Advance against `clockNow + by`, each stamp equal to `clockNow` after the party's advance and at a single rest, in and out of a fight, the undo and redo lines and the restores that write none). shared/reducer/clock.random.test.ts runs random sequences of the five ops, steps, fights started and ended, rests, Previous and undo and redo. Invariants: `t` stays within bounds, `t` equals the start plus every step and fight not undone, short of the clamp, no line is shared that was written while the clock was hidden, each DM undo or redo through the correction gate with a clock before and after whose stored time and date text both change writes exactly one clock line and every other restore writes none, an undone fight's end included, a stamp's `at` equals `clockNow` when its rest was applied. A stamp may lie after `t` (Set back, an undone step), so no invariant orders the two.
- **Projection and permissions**: shared/project.clock.test.ts (hidden, shown, table display, stamps dropped, the frozen audience, a reload after sharing off and after Stop keeping the lines), shared/permissions.test.ts cases.
- **Versions**: shared/migrate.test.ts (snapshot 32, op 42, the `clockTicks` gate on replay).
- **Server**: server/rooms/stateSchema.test.ts, server/rooms/sizeGuard.test.ts, server/rooms/importRoom.test.ts, server/rooms/undoLabels.test.ts cases. server/rooms/undo.test.ts: the party gesture with a refused advance, with a stale rest, split by an op between, and Undo setup refused after a step. server/rooms/clock.itest.ts: a player socket receives no clock and no line over the wire while hidden.
- **e2e**: e2e/clock.e2e.ts, steps `ck-1` to `ck-6` (start, steps and Pat's toast, party rest with its note, a hidden Months clock and Set, sharing off with Pat's open panel, the chip in Pat's top bar, Stop and Undo setup). Run with alignment, alignment-wide, paneltabs (a new panel), classresources and layout (the party rest card), notes (the journal button) and reach. `clock` joins e2e/durations.json with its measured seconds.
- Each new test fails with its fix removed. Mutation checks: drop the frozen audience in `lineReader`, the conditional clock read, `clockNow` in Set, the `clockTicks` gate, the floor for negative days, and the stamp's clock id test.

## 12. Build order

Three steps built it, each on the one before. The first fixes what the others read: the types of 6.1, the ops of 6.2, the exports of section 5 with their signatures, `panelsFor(role, wide, opts?: { clock?: boolean })` with `clock` false by default, and the words of section 9.

| Step | Holds |
| --- | --- |
| **Model and rules** | Every shared and server file of section 7, their tests and server/rooms/clock.itest.ts, with shared/undoCorrection.ts (the undo and redo line) and server/rooms/undo.test.ts |
| **Time panel** | client/features/clock/ except ClockChip.tsx and useClockToasts.ts, client/features/panels.ts, client/components/Icon.tsx, shared/credits.ts, CREDITS.md, e2e/clock.e2e.ts, e2e/alignmentRoom.ts and e2e/durations.json |
| **Chrome and ties** | client/pages/Room.tsx, client/features/clock/ClockChip.tsx and useClockToasts.ts, client/features/tokens/CharactersPanel.tsx, client/features/tokens/RestSection.tsx and client/features/journal/JournalEditor.tsx |

The docs (FEATURES.md, docs/dm-guide.md and the notes under docs/design) come last. The e2e steps that test the chrome's work (the toast in `ck-2b`, the party rest card in `ck-3`, the chip in `ck-6`) and the alignment roots for the rest card and the chip land after the chrome does.

## 13. Later phases, and what waits

**C2, time-span durations** (designed in outline, with the next free op and snapshot numbers, and a short addendum reviewed before its build):

- An effect may end at a clock time: `Effect.ends?: { at: number, clock: string }`, apart from `duration`. With a clock, the duration picker offers 1 minute, 10 minutes, 1 hour, 8 hours, 24 hours and Other. Without one, minutes turn into rounds as today.
- It ends on any clock op whose `clockNow` reaches `at`, and in a fight at the start of the round whose `clockNow` reaches it, with today's expiry line and notice. A 1 minute spell cast in round 1 ends at the start of round 11. Turn-exact durations keep the rounds modes.
- With it: "Show the date and time" on the table display's menu, off at first, as "Show whose turn it is" is.

**C3, daylight** (the numbers after C2's):

- A scene's Light gains a fourth choice, **Time of day**: Bright from 7 AM to 6 PM, Dim at dawn and dusk, Dark at night, as the SRD's "Vision and Light" says. Any op that changes `t` writes the new level on every such scene, in the same op, so Undo takes it back. During a fight the light changes when the fight ends. Off on every scene until the DM picks it, so a dungeon never goes dark by itself. "Use these settings on other scenes" copies it.
- A map phase with a light level of its own wins over Time of day: switching to it is the DM's explicit choice, so it sets that level and turns Time of day off for the scene, as a Light picked by hand does (`withPhaseLight`). A phase without a level leaves Time of day on.
- With it, sunrise and sunset times the DM sets, for the parts of the day and the light together.

**Waits, not planned**: "The next dawn" uses that come back at dawn (a new rest kind, which D-261024-28 turned down for now), leap days, seasons and moon phases, notes kept on a date and a month view, a clock that ticks with real time, players' own view of their last Long Rest, travel by pace, and weather by the day (weather has a design of its own).

## 14. Decisions

- **D-261102-115** Scope: C1 is the clock, the two calendars, the steps, the party Long Rest, fights, the 16-hour note, the lines, the toasts and Add the date. Time-span durations are C2 and daylight C3. Rejected: one build of all three (durations change effects and every Next, the riskiest code in the app), durations first (a clock nobody can see the date of is no calendar), daylight in C1 (cost and surprise, D-261102-124).
- **D-261102-116** Home: a Time panel ("In play", after Areas), listed for the DM always and for a player only while their view has a clock, plus a top bar chip from 900 px that leaves the row first. No new key. Rejected: a DM panel section with a line in the Log's header (two homes, and players hunting in the Log), Room settings (setup, not play), a chip on phones (the bar has no room), a key (letters are scarce and the panel is a tap away).
- **D-261102-117** Model: whole seconds `t` on a singleton `clock` key, read through the calendar, with a fight's rounds derived while it runs and added at its end. Snapshot 32 and op 42 (the design's 41 was taken first, As built), identity steps. Rejected: a field of RoomMeta (undo guards collide with settings), minutes (a round is 6 seconds), stored date parts (every step would need calendar arithmetic in the reducer), a write on every Next (op bloat and undo collisions mid-fight).
- **D-261102-118** Calendars: Day count by default, or the DM's Months: up to 24 named months of 1 to 400 days, up to 14 named weekdays, words after the year, no leap days, a 1-day month read as a festival day. Years count from 0. Rejected: published settings' calendars as presets (not SRD content), the real-world calendar (leap years, and it reads oddly in a fantasy game), leap rules in C1, an editable first year (a second number that silently shifts every date).
- **D-261102-119** Sharing: the clock is off until the DM starts it, then shared by default, and "Players see the date and time" off sends players nothing of it. Rejected: on in every new room (a clock nobody moves misleads), always shared (a DM running a dungeon without daylight wants it hidden).
- **D-261102-120** Moving it: DM only, by the four steps, Other amount and Set, each one op, with Undo for mistakes and no negative step. Rejected: players moving it, a clock that runs in real time, a guard against a second quick tap (it would block two quick 10 minutes, and the line and Undo show and fix a stray one).
- **D-261102-121** Rests: the DM's party Long Rest moves the clock 8 hours, ticked by default. A rest of one creature never moves it. Each character's last Long Rest is stamped, DM only. The DM's cards give its finish time and the earliest next start while that is still ahead, never enforced. The party rest stays a gesture of existing ops, advance first. Rejected: a new all-or-nothing party-rest op (a fourth rest path for a rare partial failure the toasts already explain), a note saying how long ago a rest ended (the app cannot tell when this rest began, and a rewound clock would read a negative age), every rest moving the clock (two players would move it twice), enforcing 16 hours (the house shows rules and leaves them to the table), the stamp for players too (every clock change would then re-project every character, a new class of fan-out bug for one line of help), tracking interruptions.
- **D-261102-122** Log: one line per clock change with the date written at the time, its audience frozen then (shared only while the clock is shown), kept by players after sharing goes off or the clock stops, a line for each Undo and Redo that changes the time, a toast for players and co-DMs, nothing for a fight's seconds or a rename, and Add the date in the journal. Rejected: a silent Undo (players would keep a line for time that no longer passed), dropping lines players already read when sharing goes off (a reload would rewrite what they saw), an in-game time on every line (bytes on every line for what the clock lines already mark), lines read through today's calendar (renaming a month would rewrite history, and a hidden clock would leave players' old lines unreadable).
- **D-261102-123** Fights: 6 seconds a round, derived while the fight runs through the one `clockNow`, the current round counted whole at its end, started meaning `round > 1 || activeEntryId !== null`, never started adding nothing, an end clamped at the limit. Rejected: a stored "fight started" mark (a model change and its Previous, Undo and replay rules, to save at most 6 seconds in a round 1 emptied of rows), refusing an end at the limit (a fight that cannot end), not counting fights (C2's durations need the time to move), time per turn (the rules time rounds, not turns).
- **D-261102-124** Daylight waits for C3 and is opt-in per scene, as a fourth Light choice. Rejected: every scene following the clock (an indoor map would go dark at dusk and players' sight would change without a DM choice), a prompt at each dawn and dusk (a Long Rest crosses two at once), any of it in C1.

## As built

Built in three steps (section 12) as phase C1. Every place the build went its own way:

**Versions and the contract**

- **Versions.** OP_VERSION 42 and SNAPSHOT_VERSION 32, both identity steps. The design said op 41 because main stood at 40 when it was written. By the build, an earlier batch had taken 41, so the clock took 42. `clockTicks(v)` is true for an undefined `v` and for `v >= 42`.
- **`at`, not `t`.** The ops that name a time call it `at`, since every op's type is already its `t` (D-261102-320).
- **Undo labels** are the house's gerund phrases: "starting the clock", "stopping the clock", "changing the calendar", "turning off Players see the date and time" and "the party's Long Rest" (D-261102-321), where 6.5 had past-tense setup labels. An Undo setup refused after a step reads the existing blocker's words, such as "Undo the play step first: moving the clock on 10 minutes".
- **A redone End the fight** writes no clock line either, as an undone one does not (D-261102-322).
- **`ProjectedClock`.** A player's and a table display's copy is `{ id, rev: 0, t, calendar }` with no `shown`, and no clock is no field, never null (D-261102-323).
- **Calendar math.** `spanText` under a minute says "less than a minute" (D-261102-324). `composeDate` past the bound says "The clock can't go that far." (D-261102-325). A week may have 1 day (D-261102-326). `fightStarted` also reads a player copy's `started`, since a player's projection names no active row while one they cannot see acts (D-261102-327). `partOfDay` returns "Dawn" to "Night", and `yearDays` takes the month rows.
- **Table displays** get the shown clock but read no clock line at all, by the rule that already keeps them off the log (`projectLogEntryCtx`).
- **Files outside the design's list**, each a small change: shared/reducer/clockTesting.ts (a test helper), the op inventories in shared/undoScope.test.ts and shared/prototypeIds.test.ts, and the snapshot version asserted in shared/reducer/saveOutcomes.test.ts, server/rooms/saveOutcomes.persistence.test.ts and server/rooms/undo.saveOutcomes.itest.ts (now `>= 31` or `SNAPSHOT_VERSION`, so the next step needs no edit there).

**The Time panel**

- **Stop** arms with "Tap again to stop the clock", the house's wording. The first build kept the armed state across the clock going, so a restarted clock showed Stop armed. The browser test found it and it is fixed.
- **Calendar's Cancel and Escape** ask "Discard changes?" through a shared hook (`useDiscard`). Its first version disarmed itself at every render, which the browser test also found.
- **`restNote` takes `movesClock`**, the rest being chosen, because the stamp carries no flag for it (D-261102-333). The panel layout, the Calendar's Today fields (the first day of year 1 after a kind change), the start form's defaults, the note's two windows and the panel's order on a phone (21, after Areas) are the build's choices (D-261102-330 to 334).
- **The icon** is Lucide's `calendar-clock`, credited in shared/credits.ts and CREDITS.md. The panel's Guide link opens the DM guide's "Time and the calendar".
- **Alignment.** Two roots in e2e/alignmentRoom.ts, run by alignment-settings: the DM's Time panel with and without a clock, Other amount with its error, the chip (1440 only), the party rest card with its note, Set and the Calendar with 12 months, and Pat's Time panel and chip, each at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within 1 px. The measure found Calendar rows and Other amount stranding a button on narrow sheets, and both were fixed.

**The top bar and the ties**

- **The chip** is the first step of the top bar's overflow order and shows from 900 px up, with a step of its own (`chipOff`, the width and the text's length it overflowed at, so a shorter date brings it back). The row's check runs whenever the chip shows, and the chip's text is in its dependencies. It has no icon. In a probe at 900 to 1300 px in steps of 25 px, nothing overflowed past the 8 px tuck. With a long room name the DM's chip leaves at 900 px, and a player's stays.
- **Toasts and a device's own line (D-261102-335 to 339, D-261102-502).** A clock line has no author, and the server's answer names no line. So a device claims only the ops that write one (Start, Set, a step, a calendar save with a time, and an Undo or Redo whose stack head moved the clock), and settles each claim in the update that answers it, against the clock lines that update brought. A refused op, or one whose update held no line of its kind, gives its claim up there. Two same-kind lines in one batch, one this device's and one another's, are the one case left to chance.
- **`client/features/clock/ties.ts`** holds the pure helpers of the party gesture and the journal heading, so they are unit tested. It is not in the design's file list.
- **A party Long Rest** is `clock.advance` with `why: "longRest"` followed by the rests, all one gesture, with no op of its own. A rest of one creature never moves the clock.

**Tests**

- **Shared:** calendar.test.ts and a fast-check calendar.property.test.ts (2,000 runs each), reducer/clock.test.ts, clockTies.test.ts, a random clock.random.test.ts (60 seeds of 160 steps, the five invariants of section 11), project.clock.test.ts, and cases in permissions, reads, logText, migrate, undoScope, prototypeIds, stateSchema (an export and import round trip), sizeGuard, undoLabels and undo (the party gesture merged, a refused advance, a stale rest, a split, and Undo setup refused).
- **Server:** clock.itest.ts reads raw frames of a player's and a display's socket, and a restart.
- **Client:** words.test.ts, calendarDraft.test.ts, ties.test.ts, useClockToasts.test.ts and panels.test.ts.
- **e2e/clock.e2e.ts** (`clock` is in e2e/durations.json): ck-0 a room with Pat on a phone, ck-1 start, ck-2 the steps, Other amount and Set, ck-4 a hidden Months clock and its privacy, ck-7 Stop and Undo setup, ck-2b Pat's toast, ck-3 the party's Long Rest and its stamps, ck-5 sharing off with Pat's panel open, ck-6 the chip and a long date, ck-8 no console error.
- **Mutation checks.** Rules put back wrong, each caught by a test: the frozen line audience, the conditional clock read, `clockNow` in Set, the `clockTicks` gate, the floor for negative days, the fight-end clamp, the unwritten never-started fight, the fight-end restore skip, the correction gate, the shown-only projection, the size guard, the stored bound and the stamp's clock id test, among 26 in the model, 5 against the random test and 3 against the integration test, and 9 in the client words (the 24 hour window, the 16 hour boundary, the step limit, the An and A rule, the player gate of `panelsFor`, the year-length limit, empty week names and the time check). Five more, in the toasts and the party's gesture, were put back wrong too: the advance after the rests, `t` for `clockNow` in the heading, a claim never consumed, a claim that never lapses, and the undo kind ignored.

**Review round 1 fixes.** Every finding of the build's first review was adopted, each with its whole class:

- **A clock's seconds (ASTRA-01, CALB-O-02).** The fields read to the minute. A draft keeps the clock's own seconds while its time field still reads the clock's minute (`keptSeconds`), added before the bound check, so a clock at `-clockSecondsMax` saves unchanged. Calendar's Save sends a time only when Today was edited or the kind changed (`calendarUpdate`), and Set only when a field changed (`setAt`).
- **The restore line (CALB-O-01).** 6.3's rule gained "the stored time changed".
- **The start form (ASTRA-02, ASTRA-03).** Its Months calendar is kept apart and only a Months save replaces it. A same-kind save keeps the date chosen, its month followed to its row, and shows at once a day a shorter month no longer has (`savedToStart`, D-261102-505).
- **A date as the calendar changes (ASTRA-04).** Today starts again from the first day on a kind change, keeps its month by its row as rows move, and reads "Pick a month" once its month goes. Set keeps the calendar its fields were made against and follows a month another DM moves by its name, clearing it where the name is gone, renamed or doubled (`remapMonth`, round 2), and starts again from the clock when another DM changes the kind (D-261102-500, 501). The month select names its error under it.
- **Own lines (ASTRA-05, CALB-O-03).** As the toasts paragraph above says.
- **Blackout (ASTRA-06, CALB-O-05).** 6.4.
- **The running controls (ASTRA-07, CALB-O-04).** They sit in a child keyed by the clock's id, so an armed Stop or an open dialog goes with its clock however it went: a local stop, another device's, or an Undo.
- **Smaller ones.** The dialogs' discard question is an alert in their status line (DiscardQuestion). Day count refuses a day under 1 (D-261102-504). lineDate, clockNow, ROUND_SECONDS and the clock's limits say that replay reads them. The chip comes back once its date is shorter (D-261102-503). The rest notes are keyed by character.
- **Tests.** e2e cf-3b moves a month and removes the middle one under an open Set. Reducer cases for the restore rule and the random test's invariant 4, projection and wire tests of the blackout for players and the table display, unit tests of the seconds, the start form, the month rules and the claims (a co-DM's line after a sharing switch and after a calendar-only save, a refused op, a player's token undo), and e2e steps cf-1 to cf-6: the seconds, Today and Set with a month gone and their discard question, the controls after a remote stop, the DM's 1024 px row with a blackout and a long name, and Pat's chip coming back. The chip is required at 1440 x 900 in the alignment sweep. Each rule was put back wrong and a test failed.

**Not covered.** The own-device Undo toast was asserted for the DM only, not for a player's "undid" line. The table display shows nothing new, as 4.4 said.

## Changes from review

### Round 1

- **CAL-1 = CAL-ASTRA-04**: clock reads only where the view holds a clock, none for `clock.start`, reads.test.ts cases (6.3, 11).
- **CAL-2**: a clock line's audience frozen when written in `lineReader`, players keep their lines after sharing off and Stop (4.7, 6.4, cases).
- **CAL-3 with CAL-ASTRA-03**: advance first, label "the party's Long Rest", partial failure and split Undo stated, no new op (4.5, 6.5, D-261102-121).
- **CAL-4**: Undo and Redo that change the time write a clock line while shown (4.7, 6.3, 6.5, D-261102-122).
- **CAL-5**: declined as a split. The whole-clock guard stays, with the setup history refusal and its direct fix in 6.5.
- **CAL-6 = CAL-ASTRA-02**: the "at never passes t" invariant dropped, a stamp after now defined (4.5, 11).
- **CAL-ASTRA-06**: the note gives the last finish and the earliest next start only, with 16 h and 24 h boundary tests (4.5, cases).
- **CAL-7**: the overflow check runs whenever the chip shows, chip text in its dependencies, the chip first of the wide steps since the strip never moves to the band there (4.8).
- **CAL-8 = CAL-ASTRA-05**: started is `round > 1 || activeEntryId !== null`, the round 1 edge documented, the end clamped at the limit (4.6, D-261102-123).
- **CAL-9 with CAL-ASTRA-01**: one `clockNow` for every reader of now, ops that name a time stored less the fight's seconds (4.6, 5.1, 6.2, 6.3).
- **CAL-10**: "A year is N days." computed, no line on a rename (4.3).
- **CAL-11**: section 1 names map phase light, and C3 says a phase's own level wins over Time of day (1, 13).
- **CAL-12**: the steps that test the chrome's work land after the chrome, the chip measured at 1440x900 only, `clock` in e2e/durations.json (9, 11, 12).
- **CAL-13**: the `clockTicks` gate kept as the house pattern (6.6).
- **CAL-ASTRA-07**: Calendar Save returns a draft before the clock starts, only Start the clock creates it (4.1, 4.3).

### Round 2

- **CAL-ASTRA-08**: Start, Set and Update check both the named time and the stored baseline, Advance checks `clockNow + by` and the stored result, the fight's end the one clamp (6.2, cases).
- **CAL-ASTRA-09**: stamps equal `clockNow` after the party's advance and at each rest, in and out of a fight, in the cases and reducer tests (10, 11).
- **CAL-R2-1**: a restore writes the clock line only when the line's date text changes, and never for an undone fight's end (6.3, cases).
- **CAL-R2-2**: the clock line follows the existing correction gate in shared/reducer.ts, so player restores write none (6.3, cases). Round 3 corrects the replay wording (CAL-ASTRA-11).
- **CAL-R2-3**: a rest that does not move the clock shows the two times until the stamp plus 24 hours, tested at 23 h 59 min and 24 h (4.5, 10, 11).
- **Nit**: 4.3 reads "A year is N days." (4.3).

### Round 3

- **CAL-R3-1 and CAL-ASTRA-10**: 4.7, 6.5 and the random test's invariant now state the clock line rule of 6.3. The fight's-end undo case says "no clock line", and the sum invariant holds "short of the clamp" (4.7, 6.5, 10, 11).
- **CAL-ASTRA-11**: 6.3 no longer says the gate keeps older restores out. It passes op 34 on, older restores are safe because their rooms have no clock, and an op 42 or later restore replays its clock line. The case table and the Round 2 line match (6.3, 10, Round 2).
