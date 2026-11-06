# raccoon-vtt: the Scenes panel, reorganized, and where weather and a scene's sound live

Status: built (2026-11-05), from design draft 2 (2026-11-03), lane scenesux, after design review round 1 (its changes and dispositions at the end). "As built" says where the build went its own way. Decisions D-261102-860 to 869 and D-261102-930 to 934 (section 16). Code is cited at main `6ae1693e` (whose diff from `073ab104` touches only the sound engine, Join and FEATURES `:51`, so the line numbers hold), and the step 0 kit at `42970941` (amb0, `dbe4c9293` to `429709416`, the `SceneWeather` lift `4bc3a898c`). Builds on docs/design/design-v1-panel-groups.md draft 5 ("Build baseline (round 4)"), and section 10 lists every edit its draft 6 needs.

Amended by docs/design/design-v1-sound-layout.md 6: Ambiance is gone, so the Weather row (4.2) and the Scene sound row go, and Use what's playing stays in the Sound panel with the scene's line as help text. The Scene sound group in Scenes keeps Play it, Use silence and Clear.

The owner (2026-11-03): "im also starting to wonder if scene is actually where weather settings should be instead of as their own tab? open to ideas here. open to your thoughts here. regardless i think we could use a design ui/ux pass and fixed to cleanup/reorganize the scenes tab as there is a ton of stuff there now that could be condensed a bit better/reorganized". Then, on sound and time: "how does this also apply to sounds and time? do we think these are scene dependent as well? or are they different for some reason?". Then, on headings: "I also think our headings could be more direct overall. Rather than "What players see" we should do "Player vision" as an example. open to feedback on this but this feels easier to use and should maybe be our general posture on headings?"

The coordinator's rules, built on here: what belongs to a scene lives in its settings in Scenes, and what is live for the whole room lives in Ambiance. Weather is a scene's setting, beside Light. Time is room-wide and stays in Ambiance. Sound now playing stays in Ambiance, and a scene's own sound (the preset Move players starts) joins the scene's settings. Headings and group names are direct noun phrases of one to three words in the table's terms, help lines explain, buttons stay verbs, and no short name clashes with a nearby one. Organization and words only: no new op, setting, stored data or feature.

## 1. Summary

- **Six groups for the scene in view, by what the DM is doing:** Light and weather (in play, open everywhere), Scene sound, Fog and vision, Map and grid, Walls and movement, Size and view (setup, folded on a phone, open from 900 px), then Export. The panel's top is unchanged: All scenes, then New scene (the folding group of panel-groups 6.2), then This scene with the name.
- **Weather lives in Scenes**, rows in the Light and weather group right under Light, with no fold of its own. Its rules on rolls fold into one row: the switch, with the rules as its help.
- **Ambiance keeps Time and Sound.** Its Weather becomes one row between them, for the scene in view, that opens Scenes at that scene's weather (the reverse of panel-groups draft 5).
- **A scene's own sound joins its settings** as the Scene sound group, with Play it, Use what's playing, Use silence and Clear. Ambiance's Sound keeps a Scene sound row that opens it, and Use what's playing beside what plays.
- **Direct headings:** What players see becomes Fog and vision, Map image and grid becomes Map and grid, the Weather and the Fog and party vision folds go or become Switches, Export as image's label becomes Export. "Player view" and "Player vision" were weighed and rejected (16, D-861).
- **Fog and vision folds on a phone** but never hides its no-walls warning: a warning tag, "No walls", stands on its folded row. Light says when it does nothing (party vision off).
- **Condensed:** the phone's panel with nothing stored is 26% shorter (3,331 to 2,473 px at 390 x 844, 4,017 to 2,867 at 320 x 568 and 130%), Light rises from 1,602 to 1,178 px and Weather from 1,787 to 1,312. The duplicate Delete section goes (the scene's ⋯ menu keeps Delete).

## 2. Audit at 073ab104

A room of 7 scenes (one folder of 2), Goblin cave in view with players there, a map, fog and party vision on, Dim light, heavy rain with a strong wind, its own sound, music and a background sound playing, a clock running. Shot as it is, phone and computer, dark and light (16). Depth is the control's top in the panel's scroller, px from the content's top, with nothing stored. The phone's half sheet shows 444 px of body at 390 x 844, 201 px at 320 x 568 and 130%, and the side panel 855 px at 1440 x 900.

| Control (where today) | What it does | Use | Phone 390, before | After |
|---|---|---|---|---|
| All scenes: a row | Shows the DM that scene | Mid-play | 65 to 850 | Same |
| Move players, Players here | Moves the party, plays the scene's sound | Mid-play | Under each row | Same |
| Reorder, folder headers, Rename | Order and folders | Between sessions | 4, 666 | Same |
| ⋯: Duplicate…, Move to folder…, Update thumbnail, Delete | Per scene | Setup | Each row | Same, now the only Delete |
| New scene: kinds, form, starter packs, Generate a dungeon, From a Universal VTT file | Makes a scene | Setup | 993, open (211 px) | 977, folded, 1 tap (panel-groups 6.2) |
| This scene: Scene name | Renames | Setup | 1,204 | 1,042 |
| What players see: Players see (cards), no-walls warning | Explore, Reveal by hand, Everything | Setup, rare in play | 1,368, open | Fog and vision, 2,079 + 1 tap |
| Light, unlit note | Bright, Dim, Dark | Mid-play | 1,602 | Light and weather, 1,178 |
| Light with each map phase | Per phase | Setup | Under Light | Under Light |
| Weather fold: Weather, Strength, Wind, Blows toward | The scene's weather | Mid-play, sometimes | 1,787 (fold opens on weather, else +1 tap) | 1,312, never a tap |
| Weather rules on rolls, rules line, devices line | Rolls follow it | Between scenes | 2,225 | 1,750 |
| Sight, Who sees for themselves, Who lends the party sight, mount notes | Vision setup | Setup | 2,523 to 2,658 | Fog and vision + 1 tap |
| Fog and party vision fold: Fog, Party vision | The two switches | Setup | 2,746 + 1 tap | Switches fold, + 2 taps on a phone |
| Use these settings on other scenes… | Copies Players see, Light, Sight | Setup | 2,798 | Copy to other scenes…, in Fog and vision |
| (Sound panel) the scene's sound line, Play it, Use what's playing, Use silence, Clear | The preset Move players starts | Between sessions | Another panel, under Now playing's volumes | Scene sound, 2,030 + 1 tap, and Ambiance's row |
| Map image and grid: Map image row, Map phases (Show a phase, Edit, Add a phase), grid look, Grid shape, Line up, Find, count | The map | Setup, Show a phase mid-play | 2,859 + 1 tap | Map and grid, 2,128 + 1 tap |
| Walls and movement: block moves, Automatic walls, Open the builder, Clear the build | Walls | Setup | 2,908 + 1 | 2,177 + 1 |
| Size and view: size, Background, Starting view, Suggested view | Size and camera | Setup | 2,957 + 1 | 2,226 + 1 |
| Export as image | A PNG | Rare | 3,046 | 2,315, label Export |
| Delete: Delete scene | Duplicate of the ⋯ menu's | Rare | 3,190 | Gone (⋯ keeps it) |

Findings, each answered in section 3 to 8:
- Weather open on a scene with weather is the panel's largest block (about 750 px on a phone), nested two levels down (group, then fold), and its rules say what they do twice: the switch's help and the rules line.
- Light, the in-play setting, sits under the setup cards of Players see, 400 px into the group.
- New scene's kinds and the Universal VTT hint push the scene's settings down by 211 px.
- Delete appears twice, the settings' Delete section and the row's ⋯ menu, with the same rules (`SceneMenu.tsx` DeleteScene, `deleteBlocked`).
- Export's label repeats its button ("EXPORT AS IMAGE", "Export as image").
- A scene's own sound is set from the Sound panel, for the scene on the DM's screen, away from the scene's other settings.
- At 1440 x 900 every group is open (5,300 px): the setup rule, kept (D-862).
- Pre-existing, not this design's: measureAlignment over the whole list reports the chosen row's `li` 5 px out (6.2 at 130%), the accent border the row wears, at every size before and after. Lane D checks whether a sweep root takes the list whole, and reports it apart if so.

## 3. The panel after

Top to bottom, the DM's Scenes panel:

1. **All scenes** (section, Reorder): unchanged.
2. **New scene** (group, no icon, `reserve="icon"`): as panel-groups 6.2 has it, folded on a phone, open from 900 px and while the room has no scene. Its kinds, form, starter packs, Generate a dungeon and From a Universal VTT file are unchanged.
3. **This scene** (section): Scene name.
4. **Light and weather** (group, icon `weather`, key `light`, in play: open everywhere): Light with its note and the unlit note, Light with each map phase, then Weather, Strength, Wind, Blows toward, Weather rules on rolls (4.1), and last "Players see it at once. Each device can show it still or turn it off in This device."
5. **Scene sound** (group, icon `music`, key `sound`, setup): section 5.
6. **Fog and vision** (group, icon `shown`, key `players` kept, setup): Players see with its warnings and questions, Sight, Who sees for themselves, Who lends the party sight, mount notes, the **Switches** fold (Fog and Party vision, open while Custom, as today), and **Copy to other scenes…** with the help "Copies Players see, Light and Sight."
7. **Map and grid** (key `map`): unchanged inside, Map phases and its Show a phase included.
8. **Walls and movement** (key `walls`): unchanged.
9. **Size and view** (key `scene`): unchanged.
10. **Export** (section, never folds): Export as image and its help, unchanged.

**Starts with nothing stored** (`SCENES_SECTIONS` in `lib/folds.ts`, `42970941` `:222-231`): `light` open on every width, `sound`, `players`, `map`, `walls`, `scene` folded below 900 px and open from 900 px, `new` as panel-groups. A device's stored values carry over by key: a DM who folded What players see finds Fog and vision folded.

**Why Fog and vision can fold on a phone** (SCN-O-05): in play the DM changes fog with the Fog tool (`F`, `dm-guide.md:578-590`), never in this panel, and Players see is picked when a scene is made (New scene's own Players see row) and rarely after. The cost: the Fog and Party vision switches go from 1 tap to 2 on a phone (the group, then Switches), and Players see, Sight and Copy from 0 to 1.

**Folded summaries** (`sceneSummary.ts`, `wholeSummary` off, as Scenes' groups keep the 4em floor, dp-1a):

| Group | Summary | Examples |
|---|---|---|
| Light and weather | The light's label while party vision is on, then `weatherParts`, else "Clear" | "Dim · Heavy rain · Strong wind", "Bright · Clear", and with party vision off "Heavy rain · Strong wind", "Clear" |
| Scene sound | The names `sceneSoundNames` gives, joined by ", ", "Silent" for silence, "None of its own" with none | "Tavern night, Cave drips" |
| Fog and vision | Players see's word, then "Per player" while Sight is | "Explore", "Explore · Per player" |
| Map and grid, Walls and movement, Size and view | As today | "Map image · Squares, 40 px" |

**The no-walls warning, folded** (D-261102-932, SCENESUX-ASTRA-02, SCN-O-09). Today the warning ("This map has no walls yet, so party vision shows players all of it at once…", `playersSeeRules.ts:32`) is always in view on a phone, since What players see starts open there. Folded, a summary word could be cut by the summary's 4em floor and "…" (`Panel.tsx` `:321-336` at `42970941`). So while the warning holds and the group is folded, Fog and vision's row carries a `Tag` in the warning tone, "No walls", as the `Group`'s `action`: it never shrinks, and where it does not fit beside the name and summary it wraps whole under the name, as the Token panel's Take a shape does. The fold button is described by the summary and the tag (`Group`'s new `describedBy`, 9). Open, the full warning shows under Players see as today, and the tag goes. SceneSettings works out `wallless` once (`walllessImage(scene, sceneWalls(scene, chunks).sightPotential)` from the view's `buildChunks`, as `VisionSettings.tsx:91-92` does) and passes it to the tag and to VisionSettings, so the two never disagree.

**Light when it does nothing** (D-261102-933, SCN-O-04). The light level matters only while party vision is on (`dm-guide.md:483`, `rules/vision.ts:1761` reads `vision.light`). Before, Players see stood just above Light, so the reason was in view. Now Light is open first and Fog and vision folded. While party vision is off, Light's help (and Light with each map phase's) reads "Light works only with party vision, which is off here. Choose Explore in Fog and vision to use it.", in place of the level's note, and the group's summary leaves the light out. The level is still stored and still picks as today.

Rejected: Light kept in the vision group (it is the in-play setting, and weather design D-261102-131 already puts "the light level, which DMs also change in play" with weather), a group per Light and per Weather (a fold over a one-tap Segmented), Fog and vision kept open on a phone (with Light out, it is setup), everything folded at 1440 x 900 (the setup rule the DM knows, panel-groups D-753), Scene sound inside Light and weather (the name would not say it).

## 4. Weather

### 4.1 In Scenes (D-261102-860, D-261102-863)

- The Weather fold goes. `SceneWeather` (amb0 `4bc3a898c`) renders inside Light and weather after the light rows, keyed by the scene, its rows unchanged: Weather (select), Strength while not Clear, Wind, Blows toward while not Calm.
- **Rules on rolls fold into one row.** While the weather has a rule, the switch "Weather rules on rolls" takes the rules line as its help (in the warning color for heavy fog's note), and its own help, "Rolls in this scene follow the rules below. Turn it off when the party is indoors. The weather still shows.", goes: the rules line already ends "Rolls here ignore it." with the switch off, and the guide keeps the indoors advice. With no rule, the line "A look only. The rules stay as they are." stands alone as today.
- The devices line stays last. Moving it into the Weather row's help was tried and rejected: at 320 x 568 and 130% the select's row wrapped it to ten lines, taller than the half sheet.
- Rejected: a Rules sub-fold (a nested level), the rules line dropped (the DM reads what a roll will do), weather apart from Light (both are what the scene is like now, changed in play).

### 4.2 In Ambiance (D-261102-860)

Amended by docs/design/design-v1-sound-layout.md 6.2: there is no Weather row. Weather is set in Scenes, Light and weather, and shows on the map.

- Ambiance's first page: **Time** (fold), **Weather** (one row), **Sound** (fold). The Weather row is a `Group` with `onOpen` (section 9): no chevron (`reserve="chevron"`), the `weather` icon, the name "Weather", the summary always shown at its end (`weatherSummary`, or "No scene"), with `wholeSummary`, and a trailing `chevronRight`. Its name lines up with Time's and Sound's (measured, 11 and 16). It never folds and holds nothing. Its button carries a new mark, `data-group-open`, apart from folds' `data-group-fold`, which the sweep and `openGroup` find folds by.
- Its button is named "Weather: Heavy rain · Strong wind, in Goblin cave's settings" ("Weather: no scene, in Scenes" with none).
- A tap calls `openSceneSettings(scope, ui, "weather", { from: "ambiance" })` (section 7): Scenes opens on the scene in view with Light and weather revealed, scrolled, and focus on the Weather select. With no scene in view it only opens Scenes, where New scene starts open: no target, no reveal (7).
- Nothing about weather is stored in Ambiance: `AMBIANCE_SECTIONS` becomes `time`, `sound` (at `42970941` it is still `["time", "weather", "sound"]` with `weather: false` in its starts, `lib/folds.ts:196-203`, step 0b removes it, 14). A stored `weather` key in `rvtt.ambianceFolds` is ignored.
- Rejected: Weather as a folding group in Ambiance (draft 5: a second place to set a scene's setting), a `SettingRow` with `onOpen` between the group headers (its name would start 41 px left of Time's and Sound's), no weather in Ambiance at all (the coordinator's answer to the owner keeps a glance at the scene's weather beside the live room).

## 5. A scene's own sound (D-261102-864)

Amended by docs/design/design-v1-sound-layout.md 6.2: the Sound panel's Table sound holds Use what's playing under the scene's line ("Goblin cave's sound: Tavern night."), and no row opens Scenes.

The rule: what plays now is the room's, in Ambiance. What a scene starts when the players move there (`Scene.sound`, music design 4.6) is the scene's. Time has no per-scene part and stays whole in Ambiance.

- **In Scenes, the Scene sound group** holds `SceneSoundLine` (`NowPlaying.tsx:89`, pure, unchanged) for the scene in view, through a new `SceneSoundSettings({ scene })`: the line ("Goblin cave's sound: Tavern night, Cave drips.", "Goblin cave is silent.", "Goblin cave has no sound of its own."), Play it, Use what's playing (disabled with "Play something first." while nothing plays), Use silence, Clear, and "It plays when you move the players to this scene." Every op is today's (`scene.update` with `sound`, `sound.scene`).
- **In Ambiance's Sound**, where the line stood (panel-groups D-766: under What players hear), a `SettingRow` with `onOpen`: name "Scene sound", help the same line, named "Scene sound, in Scenes" and described by the line (`aria-describedby` on the help, step 0b, SCN-O-01: at `42970941` the onOpen button sets only `aria-label`), opening Scenes' Scene sound group revealed with focus on its fold. Under it **Use what's playing** stays, the one deliberate duplicate, since it captures what Ambiance is playing at that moment, with "Play something first." while nothing plays. It is described by the row's line, so it says which scene it saves to (SCN-O-12: its old description, "It plays when…", leaves Ambiance). Play it, Use silence, Clear and the "It plays when…" help leave Ambiance.
- The group and the Ambiance row show only while the server offers sound files (`useServerRoomSoundState() === "on"`), as the line does today: with the switch off the Sound panel draws no Now playing (`SoundPanel.tsx:101`). Its folded summary then has nothing to say, so the group is not drawn, and Fog and vision follows Light and weather.
- Rejected: all of it in Ambiance (it is a scene's preset), all of it in Scenes with no shortcut (the coordinator kept Use what's playing beside what plays), Play it in Ambiance (it plays the scene's preset, which lives with the scene, and Move players already plays it), a subpage of Scenes (it unmounts the settings, cutting a map upload short, map-discovery 8.4), a "Playing now" line in Scenes (new words for what Ambiance shows).

**Music design changes** (design-v1-music.md, "Amended by" lines): 4.1 item 1's "The scene's sound" bullet moves to Scenes' Scene sound group, and Now playing keeps the Scene sound row and Use what's playing. 4.6 gains: "Set in the scene's settings, Scene sound, or with Use what's playing in Ambiance's Sound." FEATURES.md `:609` follows (15).

## 6. Headings (D-261102-861)

| Old | New | e2e names that move | Guide (anchors stay, passages move) | FEATURES.md (`073ab104`) |
|---|---|---|---|---|
| All scenes, New scene, This scene | Unchanged | | | |
| What players see (group) | **Fog and vision** | harness `sceneGroupFold`/`openSceneGroup` callers with it, scenesetup `section(panel, "What players see")`, alignmentRoom `SCENE_GROUP_NAMES` (`:6559`), layout ms2-1 (`:2472`) and 8. (`:2648`), dp-1a GROUPS (`:831`) | `#light-and-party-vision` (`:471-486`), `#using-one-scenes-settings-on-others` (`:505`), `#sight-for-each-player` (`:513-535`), `#a-scenes-settings` (`:198-209`), `#a-dungeon-crawl-in-the-dark` (`:1999`) | `:95`, `:193` (to Light and weather), `:296`, `:301`, `:310` |
| Weather (fold in it) | Rows in **Light and weather** | scenesetup wx-ui-1 (`:720-767`), wx-ui-2 (`:779-822`), alignmentRoom weather roots (`:6661`) | `#weather` (`:556`, `:572`) | `:338`, `:342` |
| Fog and party vision (fold) | **Switches** | scenesetup ss-1 (`:397`), ss-4 (`:575`), dp-1a (`:951`) | `:486` | `:95`, `:296` |
| Map image and grid | **Map and grid** | `table.e2e.ts:180-181`, `desk.e2e.ts:369`, every `openSceneGroup(…, "Map image and grid")`: animmap am-1/10/11, maps fu43fix3, fu43fix5, fu43h-2, FU38-B, LP24-B-FIND-1, hex HX4-2…5, dp-2a, hx9c, fu44c, layout, dmphone, swipe, alignmentRoom `:1243`, `:6657`, `:6797` | `:203`, `:273`, `:282`, `:287`, `:309`, `:696` | `:95`, `:97`, `:100`, `:102`, `:109` |
| Walls and movement, Size and view, Map phases | Unchanged | | | |
| Export as image (section label) | **Export** (button keeps "Export as image") | hex `exportSection` (`:350`), desk 8. (`:389`) | `:207`, `:690` | `:95` |
| Delete (section) | Gone | layout ms2-1 label list, settingsFolds.test `:181` | `:207` | `:95` |
| Use these settings on other scenes… | **Copy to other scenes…**, help "Copies Players see, Light and Sight." | scenesetup ss-3 (`:484-516`), ss-a (`:1041`) | `:505-511` | `:301` |
| Use Forest road's settings on… (sheet title) | Copy Forest road's settings to… | ss-3, `copyRules.test.ts:8,50` | `:511` alt text | `:301` |
| (Sound panel line) | **Scene sound** (group and Ambiance row) | soundpanel sp-6 (`:324-358`) | `#music-and-sound` (`:1753`) | `:609` |
| (Ambiance) Weather group | **Weather** row | am-4, am-5 (panel-groups 11) | | panel-groups 15's `:338` line |

Names weighed for What players see: **"Player view"** (the coordinator's) clashes with Size and view's "view" (Starting view, Suggested view, the View button's Top-down and Isometric) and with Export's "Player view" choice. **"Player vision"** (the owner's) sits beside the "Party vision" switch inside it, two near-names for different things. "Visibility" is abstract, "Fog of war" clashes with the Fog switch inside. "Fog and vision" names the two systems the group sets, Fog and Party vision. Its fold of those two switches then cannot say either word without echoing the group, so it is "Switches", its summary naming them ("Fog on · Party vision on").

Noted for the coordinator, outside Scenes: Ambiance's "What players hear" (panel-groups D-766), the Dice request's "What players see" fold (FEATURES `:462`, `:472`) and the token group sheet's "What players see" (`tokens/GroupMoreSheet.tsx:123`) read in the old style. Suggested: "For everyone" and "Players see" (one line, it is a fold's name). Not designed here.

## 7. Reached from elsewhere (D-261102-865)

- **`openSceneSettings(scope, ui, target, { from })`** in a new `client/features/scenes/request.ts`, after panel-groups' `openAmbiance` (4.3): `target` is `"weather"` or `"sound"`. With a scene in view (the room store's `sceneId` names a scene in the view) it reveals the group (`light` or `sound`) in the Scenes fold slot (a reveal, never written, ended as panel-groups 6.1 ends reveals) and sets the target with a new `seq` in `sceneRequestSlot`. Then, scene or none, it calls `ui.openPanel("scenes", { from })`. With two panels Scenes opens in the other pane, and on a phone it takes the sheet.
- **No scene in view sets nothing** (D-261102-934, SCENESUX-ASTRA-01, SCN-O-03). `SceneSettings` mounts only for a scene in view (`ScenesPanel.tsx:34`), so a target set with none would wait, and the first scene the DM makes would scroll and pull focus to its Weather select. So with no scene in view there is no target and no reveal. An untaken target is also cleared when Scenes goes from open to closed, by `useEndSceneRequestOnClose(wide)` (step 0b, after `useEndRevealsOnClose`, `lib/folds.ts:294`), wired by lane A in Room.tsx beside Scenes' reveals. And the settings take a target as they mount even where it is not drawn (Scene sound with the server's switch off), dropping it without a scroll.
- **The settings act on it once** (a `take()` that clears the target), in a layout effect, as the panel mounts or on a new `seq`: for weather, Light and weather's header goes to the top of the panel's body when the Weather row still shows whole under it, else the Weather row does, and focus goes to the Weather select. For sound, Scene sound's header goes to the top and its fold takes focus. Both count as the viewer taking the scroller (`PanelScrollKeeper.takeOver`).
- **Scroll by `scrollIntoView({ block: "start" })` with a `scroll-margin-top`**, comparing only rects with rects. The prototype first scrolled by `scrollTop += rect.top − paneTop`: at 130% the page is zoomed and `scrollTop` is not in the rects' pixels, so the Weather row landed half above the sheet (coordinator shot `17-after-weather-opens-320-130`). Fixed in the prototype (`17-v3-…`).
- **The scene in view** is the one both panels show (`s.sceneId`), so there is nothing to pick. A scene switch while Scenes is open re-keys the settings as today and drops nothing (a reveal is per group, not per scene).
- Callers: Ambiance's Weather row, Ambiance's Scene sound row. No toast, chip or key gains one. `openAmbiance` loses its `focus` option, since its one caller, the Scenes Weather row, is gone (SCN-O-02).
- Rejected: writing the fold (a DM who folded Light and weather would find it open after every tap from Ambiance), a Scenes subpage for Weather or Scene sound (unmounts the settings and cuts an upload short), opening Scenes at its top (the list is a screen or more on a phone).

## 8. What goes, what stays (D-261102-866, D-261102-867, D-261102-868)

- **Goes:** the settings' Delete section (the row's ⋯ menu keeps Delete, same `deleteBlocked` and `sceneAfterDelete` rules and help, `SceneMenu.tsx:286-333`), the Weather fold and its own open-on-weather rule, the rules switch's explanatory help, Export's echoing label. The Delete section was the only caller passing `unavailable` and `describedBy` to `scenes/controls.tsx` ConfirmButton (SCN-O-07): lane B searches for another, and with none removes both props and their test (`scenes/ConfirmButton.test.ts`), else keeps them and rewrites the test's comment, which names "The scene's Delete group".
- **Moves in:** a scene's own sound, from the Sound panel.
- **Moves out of Scenes:** nothing. Export stays in the settings: it reads the viewed scene's sight and build (`MapExport.tsx` `fromServer`), so the ⋯ menu of any row is the wrong home.
- **Stays:** the scene list and Move players on every row. Show a phase stays in Map phases with the phase list it switches. New scene stays after the list, and the Universal VTT entry stays inside it.
- Rejected: Move players only on the scene in view, with "Move players here" in each other row's ⋯ (350 px shorter at 7 scenes, but the most used in-play action would cost a second tap for a scene not in view, a feature change the owner did not ask for), Show a phase beside Light (splits the phase list from its switcher), Universal VTT as a fourth kind of scene (adds a tap before the file picker).

## 9. The kit: `Group`'s `onOpen` (D-261102-865)

`Group` gains three props (step 0b, each off by default, so no existing user changes):
- `onOpen()` and `openLabel`: the header is one native button in the h3, named by `openLabel` (else the name), described by the summary, its lead as a group's (`reserve`, icon), the name, the summary always shown, and a trailing `chevronRight` (`sm`, muted) in a third grid column as tall as the name's line. No body and no `aria-expanded`. The button carries `data-group-open`, a new mark (folds keep `data-group-fold`), and the name `data-group-name` as every group's. It takes a group's 48 px row and line, so it reads as a peer of folding groups.
- `describedBy`: more ids for the fold button's description after the summary's, for a tag in `action` (Fog and vision's "No walls"), and for panel-groups 6.1's attention badge alike.

`SettingRow`'s `onOpen` (amb0) is the same idea among setting rows, and Ambiance's Scene sound row uses it. Step 0b gives its button `aria-describedby` on the help (SCN-O-01) and its chevron the size `sm` (was `md`), so both kinds of row that open elsewhere wear one chevron (SCN-O-11).

## 10. Edits panel-groups draft 6 needs

- **1 Summary**, bullet 2: "One Ambiance panel takes the place of Time and Sound. It holds two folding sections, Time and Sound, and between them a Weather row for the scene in view that opens that scene's weather in Scenes (designs/scenes-reorg 4.2)." "Scenes keeps a one-line Weather row" goes. Bullet 4: Scenes' groups are scenes-reorg 3's.
- **4.1 The panel:** Weather is the row of scenes-reorg 4.2, not a `Group` with `SceneWeather`. Drop "For Goblin cave, the scene you're viewing.", the no-scene body line "Weather belongs to a scene. Make one in Scenes first." and "Weather in the DM guide". The Sound list's item 3 "the scene's sound" becomes the Scene sound row and Use what's playing (scenes-reorg 5). The phone bullet's "The Scenes Weather row's reveal scrolls Weather's header…" goes. The subpage bullet's "Weather's forced note… starts fresh" goes. Rejected list: "keeping Weather in Scenes" is now the choice, and "Weather as a folding group in Ambiance" joins the rejected.
- **4.2 Summaries:** Weather's row stays in the table, always shown on the row, not a folded summary.
- **4.3:** the Scenes Weather row bullet becomes "Ambiance's Weather and Scene sound rows call `openSceneSettings` (scenes-reorg 7)". `openAmbiance`'s callers are the chip alone, and its `focus` option goes.
- **6.1:** Ambiance's starts are Time and Sound only, and `AMBIANCE_SECTIONS` loses `weather`. `SCENES_SECTIONS` gains `light` (open everywhere) and `sound` (setup), and `players` moves from play to setup. Reveal callers add `openSceneSettings`. `Group` gains `onOpen`, `openLabel` and `describedBy` (scenes-reorg 9), and `SettingRow`'s `onOpen` button its `aria-describedby` and an `sm` chevron.
- **6.2:** Ambiance's Weather line leaves the table. Scenes' rows become scenes-reorg 3's list, and its D-261102-757 paragraph (the Scenes Weather row as a `SettingRow`) is replaced by scenes-reorg 4 and 5. Delete leaves "never fold".
- **7:** "its groups link those anchors" and guide.test's three anchors become two, Time's and Sound's (`#weather` stays a guide anchor, linked by no group).
- **8:** the D-767 bullet's "the Scenes Weather row is a setting row" goes. "Three lines are new" becomes one: a player's empty Ambiance line. "The Weather fold's own rule… gives way" stays, now because the fold is gone.
- **9 Keys and focus:** "The Scenes row moves focus to the Weather fold" and the scene-switch focus line go (Ambiance's rows move focus into Scenes, scenes-reorg 7). **Large sizes:** "The Scenes row is at least 44 px" goes.
- **9 Words:** remove "For Goblin cave, the scene you're viewing.", "Weather belongs to a scene. Make one in Scenes first.", "Weather in the DM guide", "Weather: Heavy rain · Strong wind, in Ambiance". Add scenes-reorg 11's words.
- **10 Cases:** replace "Scenes' What players see: The Weather row unraised…", "Scenes Weather row → Ambiance's Weather open…", "Scene switch with Weather open…" and the no-scene row's "Weather 'No scene' with its line" with scenes-reorg 12's rows.
- **11 Tests:** am-4 becomes Ambiance's rows opening Scenes (scenes-reorg 13). The Scenes row's alignment root and the "Weather's 'No scene'" root go, Ambiance's Weather row joins `groupNameEdges`. `weather.e2e.ts` needs no Scenes change (it sets weather by ops).
- **12 Lanes:** step 0 gains 0b (scenes-reorg 14). Lane A drops `SceneWeather` and gains the Weather row and the Scene sound row. Lane B is replaced by scenes-reorg 14's lane B. The `weather` icon moves from lane A into step 0b, since both lanes draw it.
- **14:** D-757 is superseded by D-860, D-864 and D-865. D-751 loses the Weather group (its `cloud-rain` icon stays, for the row and Light and weather), D-752's Weather summary is the row's, D-754's "focused only from the Scenes row" becomes Ambiance's rows into Scenes, and D-767's Scenes-row bullet goes. D-760's "Weather folded on every width" no longer applies, and D-764's rejected "drawing no Weather group without a scene" becomes moot.
- **15:** FEATURES `:338` and the guide's Weather follow scenes-reorg 15 instead.

## 11. UI checklist

- **Loading:** nothing new waits on the network. A reveal and a request are local. Scene sound's buttons send today's ops, and `sound.scene` keeps its own status lines.
- **Keys and focus:** no new keys and no new shortcut-sheet row (the sheet lists no plain taps). The Weather row moves focus to the Weather select, the Scene sound row to Scene sound's fold. A fold tap keeps focus on its button. Panel-groups 4.3's blur-before-leave rule needs nothing here: Scenes has no subpage.
- **Screen readers:** Ambiance's Weather row is a button in an h3 named "Weather: Heavy rain · Strong wind, in Goblin cave's settings". The Scene sound row is a button named "Scene sound, in Scenes", described by the line (`aria-describedby`, new in step 0b), and Use what's playing is described by the same line. The rules switch is described by the rules. Group summaries describe their folds as today, and Fog and vision's fold is also described by "No walls" while the tag shows.
- **Large sizes:** measured in the prototype (16). Every group name in Scenes and in Ambiance at one left edge, 0 px spread, at 390 x 844 and 320 x 568 at 100% and 130% and 1440 x 900 at 100% and 130%. Every group row and opening row measured by `measureAlignment` at those sizes: none over 1 px. The scroll target is whole in the 201 px sheet at 320 x 568 and 130% (7). Not yet measured, so the build measures it: Fog and vision folded with the "No walls" tag at every sweep size, the tag whole and in view at 320 x 568 and 130%, on Explore and on Explore · Per player.
- **Words, exactly:** "Light and weather", "Scene sound", "Fog and vision", "Switches", "Map and grid", "Export", "Copy to other scenes…", "Copies Players see, Light and Sight.", "Copy Forest road's settings to…", "None of its own", "Silent", "Bright · Clear", "No walls" (the tag), "Light works only with party vision, which is off here. Choose Explore in Fog and vision to use it.", "Weather" (row), "Weather: Heavy rain · Strong wind, in Goblin cave's settings", "Weather: no scene, in Scenes", "Scene sound, in Scenes". Removed: "What players see", "Fog and party vision", "Map image and grid", "Use these settings on other scenes…", "Use Forest road's settings on…", "Rolls in this scene follow the rules below. Turn it off when the party is indoors. The weather still shows.", the Delete section's label.

## 12. Cases

| Case | Expected | Test |
|---|---|---|
| Phone, nothing stored, scene with weather | Light and weather open, the rest folded, Export last, no Delete section | settingsFolds/folds.test, scenesetup dp-1a |
| 1440 x 900, nothing stored | Every group open | folds.test, layout ms2-1 |
| Stored `players: true` from before | Fog and vision open on a phone | folds.test |
| Clear, calm scene | Light and weather: Light, Weather, Wind, "A look only…", devices line | WeatherSettings.test |
| Heavy rain, rules on and off | One switch, its help the rules, ending "Rolls here ignore it." when off. No separate rules line | WeatherSettings.test, wx-ui-1 |
| Heavy fog | The switch's help in the warning color | WeatherSettings.test |
| Folded summaries | "Dim · Heavy rain · Strong wind", "Bright · Clear", "Tavern night, Cave drips", "Silent", "None of its own", "Explore · Per player" | sceneSummary.test |
| Party vision off (Reveal by hand) | Light's help is the party-vision line, the summary leaves the light out ("Heavy rain · Strong wind") | LightSettings test, sceneSummary.test |
| Explore on a map with no walls, Fog and vision folded, 320 x 568 at 130%, with and without Per player | The "No walls" tag whole and in view on the row, the fold described by it. Open: the full warning, no tag | Panel.test, scenesetup (new step), alignment |
| Ambiance Weather row, phone 390 and 320 at 130% | Scenes takes the sheet, Light and weather open (not written), Weather row whole in view, focus on the Weather select | am-4 |
| Same, two panels | Scenes opens in the other pane, Ambiance stays | am-4 |
| Same, room with no scene | Row says "No scene", opens Scenes, New scene open, no target and no reveal set | request.test, am-4 |
| No scene, Weather row, then a first battle mat made with Scenes still open | The new scene's settings show at their top: no scroll to Weather, focus stays where the form left it | am-4 |
| No scene, Weather row, Scenes closed and opened again, then a scene made | The same: nothing pending | request.test, am-4 |
| A target set, Scenes closed before its settings drew | The target is cleared on open to closed | request.test |
| Reveal then reload | Light and weather follows its stored or start value | folds.test, am-4 |
| Ambiance Scene sound row | Scenes with Scene sound open and focused | am-4 |
| Use what's playing in Ambiance, nothing playing | Disabled, "Play something first." | sound panel.test |
| Scene sound group: no sound, silence, a sound | Use what's playing and Use silence, then the line with Play it and Clear, as today's line | panel.test, soundpanel sp-6 |
| Copy | "Copy to other scenes…", the help, the sheet titled "Copy Forest road's settings to…" | PlayersSee.test, ss-3 |
| Delete | Only in the row's ⋯ | settingsFolds.test headings, layout ms2-1 |
| Group `onOpen` | One button, summary shown and describing it, `sm` chevron at the end, `data-group-open`, no `aria-expanded`, name at its peers' edge | Panel.test, alignment `groupNameEdges` |
| SettingRow `onOpen` | Described by its help, `sm` chevron | Panel.test (SettingRow) |

## 13. Tests

Unit (`node:test`):
- `client/lib/folds.test.ts` (amb0's): `light` open at 899 and 900 px, `sound` and `players` folded at 899 and open at 900, the old `players` value kept, unknown keys ignored. Mutation: `light` on the setup rule fails. Ambiance's cases at `:73-176` and `:219` drop `weather` (they test the store with it as a sample section, so they take `sound`), and `AMBIANCE_SECTIONS` reads `["time", "sound"]`.
- `client/features/scenes/sceneSummary.test.ts`: each summary of 3, the old players summary's light and weather gone, the light left out with party vision off. Mutation: keep the light with party vision off, or drop "Clear", and it fails.
- `client/features/weather/WeatherSettings.test.ts`: no fold wrapper, the rules as the switch's help, no rules line beside a switch, the look-only line without one, the devices line last.
- `client/features/vision/VisionSettings.test.ts`: no Light and no Weather, the "Switches" fold, the copy button's words and help. A new `LightSettings` render: Light, the unlit note, Light with each map phase, and with party vision off the party-vision line in place of the level's note.
- New `client/features/scenes/SceneSettings.test.ts` (in place of settingsFolds.test's render part): headings ["This scene", the six groups, "Export"], the order inside Light and weather, no Delete section.
- `client/components/Panel.test.ts`: `onOpen` markup (one button, summary describing it, trailing `sm` chevron, `data-group-open`, no `aria-expanded`), `describedBy` added after the summary on a fold, and without either as today. `SettingRow` `onOpen`: `aria-describedby` on the help. Mutation: summary only while folded, or no `aria-describedby`, and it fails.
- New `client/features/scenes/request.test.ts`: with a scene, reveal not written, `seq` bumped, `take()` once, `openPanel` called with `from`. With no scene in view, `openPanel` alone: no target, no reveal. `useEndSceneRequestOnClose` clears an untaken target on open to closed and leaves one set while closed for the opening it asked for. Mutation: set the target with no scene, or skip the clear, and it fails.
- `client/features/ambiance/request.test.ts` (amb0's): the "Scenes row" cases (`:59-100`, `:117-118`) take the chip's or a plain caller's shape, since `focus` goes.
- `client/features/sound/panel/panel.test.ts`: Ambiance's scene part (the row and Use what's playing only), Scenes' `SceneSoundSettings` (all four buttons as today's line).

e2e (each file on its own): the paths of section 6's table move with their names. Phone steps that reach Players see, Sight, the holders, the Switches or Copy now open Fog and vision first with `openGroup` (harness `openSceneGroup`): scenesetup ss-1, ss-3, ss-4, ss-a, dp-1a, pervision pv-1, pv-5, pv-6, pv-7, vision pv4-1, pv4-2, pv4-3 (Light needs no tap). The build runs each and adds the call only where a step fails for a fold. One constant, `SCENE_GROUP_NAMES` in `e2e/helpers/`, names the groups for every file. New steps in `ambiance.e2e.ts` am-4 (12's rows), soundpanel sp-6 split between Ambiance (Use what's playing) and Scenes (Use silence, Clear, the lines), scenesetup wx-ui-1 and wx-ui-2 on the Light and weather group, and a new scenesetup step for the folded "No walls" tag at 320 x 568 and 130%. Plus `reach`.

Alignment sweep (`e2e/alignmentRoom.ts`, run by `alignment`, `alignment-wide`, `alignment-settings`): ms2-a's start check and `SCENE_GROUP_NAMES`, Light and weather open on heavy rain with a strong wind and on a clear calm scene (replacing `weather-folded`, `weather-clear-wind`, `weather-heavy-rain`, `weather-heavy-fog`, which become the same four states in the group), Scene sound open in its three states, Fog and vision open with Switches open (the `vision-section` root, now opened first), Fog and vision folded with the "No walls" tag, Ambiance's Weather row and Scene sound row (panel-groups' Ambiance roots), and `groupNameEdges` over Scenes (New scene's reserve) and Ambiance (the Weather row's reserve). 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%.

## 14. Lanes (D-261102-869)

- **Step 0b** (amb0, before lanes A and B): `Group`'s `onOpen`, `openLabel` and `describedBy`, `SettingRow`'s `onOpen` button described by its help with an `sm` chevron, with Panel.test, the `weather` icon (Lucide cloud-rain) with `CREDITS.md`'s Feather line, `SCENES_SECTIONS`' `light` and `sound` and `players` on the setup rule, Ambiance's `weather` out of `lib/folds.ts` (`:196-203`) and its tests, `openAmbiance`'s `focus` out of `features/ambiance/request.ts` with its doc comment and tests (SCN-O-02), and `client/features/scenes/request.ts` (`openSceneSettings` with its no-scene branch, `sceneRequestSlot`, `useEndSceneRequestOnClose`) with its test. One commit, `feat(ui): a group that opens elsewhere and the scenes request`, tests in the next.
- **Lane A** (Ambiance, panel-groups): the Weather row instead of the Weather group, `NowPlaying.tsx`'s scene part as the Scene sound row and Use what's playing (described by the line), `useEndSceneRequestOnClose` wired in Room.tsx beside Scenes' reveals, `soundpanel` sp-6's Ambiance half, am-4 and am-5.
- **Lane B** (Scenes, replacing panel-groups' lane B): `features/scenes/SceneSettings.tsx` (order, groups, the request effect, no Delete section), `panels/ScenesPanel.tsx` (New scene group), `features/vision/VisionSettings.tsx` (`LightSettings` split, Switches), `features/weather/WeatherSettings.tsx` and its test (the fold wrapper goes, the rules row), `features/vision/CopySettings.tsx` and `copyRules.ts` (words), `features/mapexport/MapExport.tsx` (label), `features/scenes/sceneSummary.ts` and its test, `features/scenes/settingsFolds.ts` onto `lib/folds.ts` (as panel-groups B), a new `features/scenes/SceneSoundSettings.tsx` over the exported `SceneSoundLine`, `scenes/controls.tsx` and `ConfirmButton.test.ts` (8), the unit tests of 13, `copyRules.test.ts`, the e2e paths of 6 and 13 except layout and the sweep (`table.e2e.ts:180-181` and `desk.e2e.ts:369` included), and the comments that name the old groups (SCN-O-08): `vision/settings.ts:6,74,116,133`, `vision/sources.ts:8`, `vision/senses.ts:26`, `phases/PhasesSection.tsx:35`, `scenes/sceneSummary.ts:55`, `vision/CopySettings.tsx:14`, the `WeatherSettings.tsx` header and `SceneSettings.tsx`'s top comment. Commits: `feat(scenes): light and weather, scene sound and fog and vision groups`, `feat(scenes): new scene folds`, `test(scenes): …`.
- **Lane C** unchanged. **Lane D** (sweep and docs): 13's sweep roots, `layout.e2e.ts` ms2-1 and 8., then FEATURES.md, the guide and its shots, the older notes' lines, this note into `docs/design/` beside panel-groups.
- A and B meet only through step 0b and `SceneSoundLine`, which neither changes. No lane touches shared/, db/ or server code.

## 15. FEATURES.md, the guide and the older notes

FEATURES.md (lane D's last commit, lines at `073ab104`): `:95` rewritten for 3's list, starts and summaries, Delete only in ⋯. `:97`, `:100`, `:102`, `:109` "Map image and grid" to "Map and grid". `:193` "the scene's Light and weather settings tell the DM…". `:296` "each scene's Fog and vision settings start with…", "The Fog and Party vision switches sit in the Switches fold". `:301` "**Copy to other scenes…**, at the end of Fog and vision". `:310` "in a scene's Fog and vision settings… Light and weather sets the light". `:338` "The DM sets it in the scene's settings, **Light and weather**, under Light. The folded group names the light and the weather. Ambiance shows a Weather row for the scene in view that opens it." `:342` the rules switch's help is the rules. `:609` "set in the scene's settings, Scene sound… Ambiance's Sound keeps Use what's playing and a row that opens it."

The guide (guide voice): "A scene's settings" (`:198-217`) lists the six groups as what each is for, with "Delete is in the scene's ⋯ menu". "Light and party vision" (`:471-486`) says Light sits in Light and weather and the rest in Fog and vision. "Using one scene's settings on others" (`:505-511`) names Copy to other scenes…. "Sight for each player" (`:513-535`) finds Sight in Fog and vision. "Weather" (`:552-576`) opens with "the **Light and weather** group of a scene's settings, under Light", explains the rules row and the indoors advice the switch's help dropped, and mentions Ambiance's row. "Music and sound" (`:1753`) moves A scene's own sound to Scenes with the shortcut. `:203`, `:273`, `:282`, `:287`, `:309`, `:673`, `:690`, `:696`, `:1999` follow the names. Shots retaken: `scene-settings-folded.webp`, `scene-settings-map.webp`, `vision-settings.webp`, `copy-settings.webp`, `vision-per-player.webp`, `weather-settings.webp`, `sound-panel.webp`.

"Amended by docs/design/design-v1-scenes-reorg.md" lines: map-discovery 8.4, design-pass 4.1, weather 4.1, music 4.1 and 4.6, panel-groups 4.1 and 6.2 (or draft 6 itself).

## 16. Preview and decisions

**Preview** (done, draft 1): a throwaway prototype on `073ab104` with amb0's kit as it then stood (since landed as `42970941`: Group props, `SettingRow` `onOpen`, `SceneWeather`), a minimal Ambiance panel, nothing committed (workspace abandoned). Shots in the `scenes-reorg-preview` folder, dark and light each: `01`, `02`, `03`, `06`, `07` before and `v2` (after), `08` and `10` Ambiance, `11` Scene sound opened from it, `12` Ambiance on a computer, `14-v2` a clear scene, `15-v2` and `16-v2` the Weather row opening Scenes, `18` and `19` before and after side by side. The `after` set (not v2) has the devices line beside the Weather select, rejected in 4.1. Draft 2 differs from the shots in three small ways, none reshot: Fog and vision's folded row gains the "No walls" tag where the map has no walls (the preview's Goblin cave was on Explore with no walls, so its folded row would show it), Light's help changes with party vision off (the preview's Yawning Portal, `14-v2`, would show it), and the Scene sound row's chevron is `sm` (`10` shows `md`).

**Show the owner first** (12): `18-compare-phone-whole-before-left-after-right-light`, `01-before-phone-top-dark` with `14-v2-clear-scene-settings-phone-dark`, `08-after-ambiance-phone-dark`, `15-v2-ambiance-weather-opens-scenes-phone-dark`, `10-after-ambiance-scenesound-row-phone-light`, `11-after-scenesound-opens-scenes-phone-dark`, `02-v2-phone-whole-light`, `12-after-ambiance-computer-light`, `16-v2-ambiance-weather-opens-scenes-computer-dark`, `19-compare-computer-whole-before-left-after-right-dark`, `03-v2-phone-allopen-dark`.

**Decisions** (D-261102-860 to 869 and 930 to 934, logged with their rejected options in the decisions file):
- **860, weather:** in Scenes' Light and weather group, no fold, Ambiance a Weather row that opens it.
- **861, names:** Fog and vision, Switches, Light and weather, Scene sound, Map and grid, Export, Copy to other scenes…. Player view and Player vision rejected (6).
- **862, order and starts:** Light and weather first and open everywhere, then Scene sound, Fog and vision (now setup), Map and grid, Walls and movement, Size and view. Summaries of 3.
- **863, rules on rolls:** the rules line as the switch's help, the devices line last.
- **864, a scene's sound:** a Scene sound group in Scenes, Ambiance a row and Use what's playing.
- **865, reaching Scenes:** `openSceneSettings`, a reveal never written, `scrollIntoView` for zoom, `Group` `onOpen`.
- **866, duplicates:** the Delete section goes, Export stays with a short label.
- **867, the list:** unchanged, Move players on every row.
- **868, stays:** Show a phase in Map phases, Universal VTT inside New scene, nothing leaves Scenes.
- **869, delivery:** step 0b, then lanes A and B at once on it, C as panel-groups, D last.
- **930, "Scene sound" kept** (the coordinator's call on SCN-O's question 1): the Scenes group keeps "Scene sound". "Sound" would clash with Ambiance's Sound section, which plays for the whole room, while this group holds the scene's own preset. The echo with "This scene" that D-261028-07 avoided was the group repeating the label over it, which "Scene sound" does not do.
- **931, "Switches" kept** (the coordinator's call on SCN-O's question 2), its summary "Fog on · Party vision on" saying what it holds.
- **932, the folded no-walls warning:** a warning `Tag` "No walls" as Fog and vision's `action` while folded, describing its fold, worked out once in SceneSettings (3).
- **933, Light with party vision off:** its help says it works only with party vision and points to Explore in Fog and vision, and the summary leaves the light out (3).
- **934, no scene, no request:** with no scene in view `openSceneSettings` sets no target and reveals nothing, and an untaken target clears when Scenes closes (7).


**After round 2:** SCN-O-14 is adopted: step 0b adds a `Tag` `id` prop, the fold button's `describedBy` points at the No walls tag, and Panel.test asserts the description resolves to "No walls" (panel-groups draft 6, 12).
## As built

Built in step 0b and lane B, with lane A's half of Ambiance and lane D's sweep, as section 14 plans. Where the build went its own way:

- **The request's scroll** runs in a microtask after the commit's own layout effects, since the panel's scroll restore runs in the parent's layout effect after the settings' and would put the old place back. It counts as the viewer taking the scroller by a zero-distance wheel event the scroller already listens for (D-261102-820). Light and weather and Scene sound each sit in a one-column box with a scroll margin, which the request scrolls into view, and the Weather row scrolls in alone where the group's header and the row do not fit the pane together, as at 320 x 568 and 130% (D-261102-821).
- **Copy to other scenes…**'s help is a help line under the button, which describes it (D-261102-822).
- **Scene sound's tests** are in `scenes/SceneSoundSettings.test.ts`, and its line takes ids of its own, so Ambiance's row and Scenes' group on one page share none (D-261102-823).
- **The scene settings' summaries** keep the 4em floor row by row: "Map and grid" leaves room for its summary's floor beside the name at 320 x 568 and 130%, cut there, which the floor rule allows (D-261102-824).
- **The No walls tag** wraps under the header row at the row's left edge where it does not fit, as the Group's action does for Take a shape, rather than under the name.
- **The Delete section's ConfirmButton props** (`unavailable` and `describedBy`) had no other caller, so they went with their test (8).
- The chosen scene row's 5 px `li` finding of section 2 does not show in the sweep: ms2-a measures the whole panel, list included, and reports nothing at any size.

- **Amended by the sound layout** (docs/design/design-v1-sound-layout.md 6): the Weather row and the Scene sound row were removed with Ambiance, and `features/scenes/request.ts` went with its last callers. `SCENES_PANEL` lives in `features/scenes/ids.ts`.

## Design review round 1

Reviewers: astra (SCENESUX-ASTRA) and Opus (SCN-O), code at `6ae1693e` and `42970941`. Each finding was checked against that code.

Changes in draft 2: the no-scene request (7, 12, 13, 14), the folded no-walls tag (3, 9, 11, 12, 13), Light with party vision off (3, 11, 12, 13), `aria-describedby` and one chevron size for rows that open elsewhere (5, 9, 11), Ambiance's weather and `focus` out of the step 0 contract (4.2, 7, 13, 14), the rationale for folding Fog and vision (3), panel-groups edits added (10), the Delete section's ConfirmButton props (8), rename paths and comments (6, 14), the kit re-cited at `42970941` (status, 3, 16), D-930 to 934.

- SCENESUX-ASTRA-01 (P2): adopted with SCN-O-03, one fix. Verified: `ScenesPanel.tsx:34` mounts the settings only for a scene in view. No target and no reveal with none, an untaken target cleared on close, two am-4 cases (7, D-934).
- SCENESUX-ASTRA-02 (P2): adopted. Verified the 4em floor and "…" at `Panel.tsx:321-336`. The warning is a `Tag` that never shrinks, not a summary word, with a step at 320 x 568 and 130% (3, D-932).
- SCN-O-01 (P2): adopted. Verified: the onOpen button sets only `aria-label`. Step 0b adds `aria-describedby` on the help (5, 9).
- SCN-O-02 (P2): adopted. Verified `AMBIANCE_SECTIONS` and its starts at `lib/folds.ts:196-203`, the tests and the comment. Step 0b removes them, and `focus` goes with its last caller (7, 13, 14).
- SCN-O-03 (P2): adopted, as ASTRA-01. The Scene sound target with its group not drawn is taken and dropped (7).
- SCN-O-04 (P2): adopted. Verified `dm-guide.md:483`. Light's help and the summary change with party vision off (3, D-933).
- SCN-O-05 (P3): adopted, the Fog tool and the 1 to 2 taps stated (3).
- SCN-O-06 (P3): adopted, each missing panel-groups edit added (10).
- SCN-O-07 (P3): adopted, lane B removes or keeps the props by a search, and rewrites the test's comment (8).
- SCN-O-08 (P3): adopted. Verified the e2e lines, `copyRules.test.ts:8,50` and the comments, all given to lane B (6, 14).
- SCN-O-09 (P3): adopted, `wallless` worked out once in SceneSettings (3).
- SCN-O-10 (P3): adopted, re-cited, and "6 below" now points at 11 and 16.
- SCN-O-11 (P3): adopted, `data-group-open` named a new mark, both chevrons `sm` (4.2, 9).
- SCN-O-12 (P3): adopted, Use what's playing described by the row's line (5).
- SCN-O-13 (P3): adopted, verified `GroupMoreSheet.tsx:123`, added to the note (6).
- SCN-O questions for the owner: answered by the coordinator, D-930 and D-931.
