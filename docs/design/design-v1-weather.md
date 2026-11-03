# raccoon-vtt: weather over the map

Status: built (2026-11-02). Draft 3, revised after design review rounds 1 and 2, whose findings the "Design review" section at the end sums up. Decisions D-261102-125 to D-261102-134 (section 13). The "As built" section at the end says where the build went its own way, and the numbers in sections 9.4 and 10 are the design's, so read them with it.

Asked for in docs/design/mvp.md section 11, Later: "Weather overlays." The project owner's order for the Later list (D-261102-007) puts weather fourth, after snap off, join requests and the calendar, and before the light theme.

## 1. Summary

- **One weather per scene, set by the DM.** Rain, Snow, Fog, Falling leaves, Ash or Sand, each Light or Heavy, or Clear, with a wind (Calm, Moderate or Strong) that blows toward one of eight directions on the map. A wind can stand alone on a clear day. It lives in the scene's What players see settings, in a Weather fold after Light, and applies at once.
- **A look, plus the SRD's roll rules where they need no judgment.** Weather never changes what anyone can see on the map: sight, fog and light work as they do today. Heavy rain, heavy snow and a sandstorm put Disadvantage on Wisdom (Perception) checks, and strong wind on attacks the app knows are with a ranged weapon, for creatures whose token stands on that scene, as a condition's preset does. The rest shows as text (section 2). A "Weather rules on rolls" switch, on by default, drops the rolls' part for an indoor scene and keeps the look.
- **Drawn in code on one extra Konva layer.** In Top-down it lies on the ground: over the map and the board layer, under every creature, the darkness, the fog and every token's name, chips and HP bar. In Isometric it falls through the air: over the ground and the standees, under the drag and upright layers. No image files.
- **Cheap by design.** Particles in screen space at 1 device pixel per CSS pixel, 30 ticks a second owned by one controller, counted by the screen's area and capped. It stops whenever nobody can see it.
- **Every device decides how it looks.** This device, Weather: Moving (the default), Still or Off, and the same three in the table display's tap menu. Reduced motion and Low power keep it still, and a device that cannot keep up steps itself down to half the particles, then to still.
- **Nothing new reaches a player** but the weather of the scene they are on, which names nothing of the map.
- **Versions:** the next free op and snapshot versions, both identity steps, so an older build refuses a room that may hold weather (section 9.4). As built they are 43 and 33.

## 2. The rules (SRD 5.2.1)

What the SRD 5.2.1 says (CC BY 4.0, from the PDF whose SHA-256 `scripts/srd-import.ts` pins):

- **Playing the Game, "Vision and Light", "Obscured Areas" (page 11):** "In a Lightly Obscured area, such as an area with Dim Light, patchy fog, or moderate foliage, you have Disadvantage on Wisdom (Perception) checks that rely on sight." "A Heavily Obscured area, such as an area with Darkness, heavy fog, or dense foliage, is opaque. You have the Blinded condition ... when trying to see something there." And under Light: "Even gloomy days provide Bright Light."
- **Gameplay Toolbox, "Environmental Effects" (page 195):** "Heavy Precipitation. Everything within an area of heavy rain or heavy snowfall is Lightly Obscured, and creatures in the area have Disadvantage on all Wisdom (Perception) checks. Heavy rain also extinguishes open flames." "Strong Wind. Strong wind imposes Disadvantage on ranged attack rolls with weapons. It also extinguishes open flames and disperses fog. A flying creature in a strong wind must land at the end of its turn or fall. A strong wind in a desert can create a sandstorm that imposes Disadvantage on Wisdom (Perception) checks." Extreme Cold and Extreme Heat on the same page are about temperature over hours, not the map.
- **Equipment, "Weapons" (page 91):** the Simple Ranged Weapons (Dart, Light Crossbow, Shortbow, Sling) and Martial Ranged Weapons (Blowgun, Hand Crossbow, Heavy Crossbow, Longbow, Musket, Pistol), and the melee weapons with the Thrown property (Dagger, Handaxe, Javelin, Light Hammer, Spear, Trident).
- **Control Weather (page 120)** names the stages the app's words follow: wind as "Calm", "Moderate wind", "Strong wind", "Gale" and "Storm".
- **No weather tables.** The DMG's weather tables are not in the SRD 5.2.1, so the app rolls no random weather.

What the app does with them (D-261102-125, D-261102-132):

| Weather | Rule | On the map | On rolls |
|---|---|---|---|
| Heavy rain, Heavy snow | Heavy Precipitation | Unchanged. Lightly Obscured ground still shows, as Dim Light does today | Preset: Disadvantage on Wisdom (Perception) checks |
| Sandstorm (Sand, Heavy, which needs Strong wind) | Strong Wind's sandstorm | Unchanged | Preset: Disadvantage on Perception checks, plus Strong wind's |
| Strong wind (alone or with any kind but Fog) | Strong Wind | Unchanged | Preset: Disadvantage on an attack known to be with a ranged weapon (2.1). Any other ranged or thrown attack: a note. Flames, fog and fliers: text |
| Patchy fog (Fog, Light) | Lightly Obscured | Unchanged | Note on Perception checks: "Patchy fog: Lightly Obscured. Disadvantage on Perception checks that rely on sight." |
| Heavy fog (Fog, Heavy) | Heavily Obscured | Unchanged | Note on Perception checks and attack rolls: "Heavy fog: Heavily Obscured. A creature trying to see something in it has the Blinded condition." |
| Light rain, Light snow, Falling leaves, Ash, Blowing sand, Moderate wind, Calm | None | Unchanged | Nothing |

- **Why sight stays as it is.** Lightly Obscured ground is visible ground with Disadvantage, as the app's sight already treats Dim Light. Heavy fog over a whole scene would, by the rule, black out the map for every player but a creature with Blindsight. A DM uses heavy fog as an area (Fog Cloud) far more than as a scene's weather, and hides what the party cannot see with the tools that exist. A sight distance cap is a later choice (section 14).
- **Why presets, not only notes.** The roll reminders' rule (shared/rules/rollReminders.ts) presets a roll only where it holds without a judgment the app cannot make. "All Wisdom (Perception) checks" needs none, and "ranged attack rolls with weapons" needs none once the app knows the weapon (2.1). Patchy fog's "that rely on sight" and heavy fog's "trying to see something" need one, so they remind only.
- **Fog and strong wind refuse each other**, since strong wind "disperses fog". A sandstorm is a strong wind, so Sand, Heavy needs Strong. The schema refuses both mixes and the picker never offers them.
- **Which creatures.** A creature is in the weather when its token stands on that scene: a token target's own scene, or for a character the scene of its token on the players' scene, else on the viewer's scene. A creature with no token there gets nothing. For an indoor scene the DM turns off "Weather rules on rolls" (4.1), or picks a light kind, and the roller can still change any preset, as with a condition's.
- **The words are the SRD's.** `scripts/srd-import.ts` adds Obscured Areas, Heavy Precipitation, Strong Wind and the two weapon lists to `shared/srd/rules-text.json` under a new `environment` key, and every rule's `quotes` must be found there, as the reminder rules' are. The Obscured Areas paragraph holds two em dashes, which `assertNoEmDash` refuses, so the import adds two `EM_DASH_FIXES` entries: `"Lightly Obscured area\u2014such as an area with Dim Light, patchy fog, or moderate foliage\u2014you have"` becomes `"Lightly Obscured area, such as an area with Dim Light, patchy fog, or moderate foliage, you have"`, and `"Heavily Obscured area\u2014such as an area with Darkness, heavy fog, or dense foliage\u2014is opaque"` becomes `"Heavily Obscured area, such as an area with Darkness, heavy fog, or dense foliage, is opaque"`. Each entry matches the paragraph as the import joins its lines, and the quotes above are the rewritten words.

### 2.1 Which attacks are with a ranged weapon

Today every attack test is `{ kind: "attack" }` or `{ kind: "attack", spell: true }` (RollOptions.tsx, GroupOptions.tsx), and `D20Test.attack.range` is never written. A 2024 "Ranged Attack Roll" alone is not a weapon: the SRD's Stone Golem (Force Bolt), Spirit Naga (Necrotic Ray) and Ape (Rock) make one too. So the preset needs a positive weapon signal:

- `D20Test`'s attack (shared/dice/bonus.ts) gains `weapon?: true`, and its `range` may be `"either"`. `NamedRoll` gains `range?: "melee" | "ranged" | "either"`, `weapon?: true` and `spell?: true`, each kept through parsing, so a 2014 spell attack under Actions stays a spell.
- **A stat block's roll** (shared/dice/named.ts, from its entry's text, read once in `blockActions`): 2014's "Ranged Weapon Attack" is a ranged weapon. 2024's "Ranged Attack Roll" is ranged, and a weapon only when the action's name is one of the SRD's ranged weapons or Thrown weapons, compared without case, its parenthetical or a "+1", as the whole name or its last words ("Elven Longbow" and a Javelin thrown as a "Ranged Attack Roll" count, "Bone Bow" does not). "Melee or Ranged Attack Roll" and 2014's "Melee or Ranged Weapon Attack" are `"either"`. 2014's "Ranged Spell Attack" and "Melee Spell Attack" set `spell`, whatever the section. `rangedOf` moves from client/features/pcstats/fromBlock.ts into named.ts, so the import and the rolls read one rule.
- **A character's roll** (shared/rules/pcStats.ts `namedRollOf` and the `namedRoll` behind it, and `pcNamedRolls`): a `weapon` roll named for a ranged weapon is a ranged weapon, one named for a Thrown weapon is `"either"`, and any other weapon has no range.
- **The tests built from them:** `attackTest(named)` in named.ts gives `{ kind: "attack", spell?, range?, weapon? }`, with `spell` from `named.spell` or `section === "spells"`. RollOptions.tsx's named attack (its line 1116) passes it, and so do GroupOptions.tsx's attack and its preset note (lines 380 and 396), for each creature's named roll. The Dice panel's bare d20 and a typed formula carry nothing.
- **The rule:** strong wind presets Disadvantage only on `range: "ranged"` with `weapon: true` and no `spell`. An `"either"` attack, a ranged attack not known to be a weapon and a weapon with no range get the note "Strong wind: Disadvantage on ranged attack rolls with weapons." and never a preset.

## 3. How other VTTs do it (ideas only)

- **Foundry VTT** sets one weather effect per scene in the scene's settings, drawn over the map as particles and shaders, and can keep it out from under roofs. It is a look only. Each player can turn effects down on their own client.
- **Owlbear Rodeo's weather extension** attaches an effect to a map, with a type, a direction, a speed and a density.
- Taken from them: one per scene, set where the scene is set, a direction, and a per-device way down. Left out: masks and roofs (section 14), free sliders for speed and density, and lightning, since a flash over the whole map risks photosensitive seizures (WCAG 2.3.1).

## 4. What the DM and players see and do

### 4.1 The DM's control

In a scene's settings, **What players see**, a fold named **Weather** after the Light row (and after "Light with each map phase" when the scene has phases), before Sight. It opens chevron first like the Fog and party vision fold. Folded, it reads "Clear" or the weather's name, such as "Heavy rain · Strong wind" or "Strong wind". Like that sibling fold, its open state is the component's own (VisionSettings.tsx): it opens on a scene with weather and folds on a clear one, fresh each time the page opens. The group's own folded summary gains the weather: "Explore · Dark · Heavy rain".

Inside, top to bottom:

1. **Weather**, a native select: Clear, Rain, Snow, Fog, Falling leaves, Ash, Sand.
2. **Strength**, a segmented pair named for the kind: Light and Heavy (Rain, Snow, Falling leaves, Ash), Patchy and Heavy (Fog), Blowing and Sandstorm (Sand). Hidden while Clear.
3. **Wind**, segmented: Calm, Moderate, Strong, shown with every kind, Clear included. Clear with Calm is no weather at all. With Fog, Strong is disabled and its help says "Strong wind disperses fog." In a sandstorm, Calm and Moderate are disabled and it says "A sandstorm is a strong wind."
4. **Blows toward**, with any wind but Calm: a compass of eight radio buttons around a small square that stands for the map, each the app's new `windToward` arrow turned to its direction, named "Toward the top", "Toward the top right" and so on round to "Toward the top left". One Tab stop, and the arrow keys move between them as in every radio group in the app. Its help: "The map's edges as Top-down shows them." The default is toward the bottom right.
5. **Weather rules on rolls**, a switch, on at first, shown while the weather has a rule: "Rolls here follow the rules below. Turn it off where the party is indoors: the weather still shows."
6. **The rules line** (Help, or Note for heavy fog), from `weatherRules`. Heavy rain: "Everything here is Lightly Obscured, and creatures have Disadvantage on all Wisdom (Perception) checks. Heavy rain puts out open flames. Perception checks here roll with Disadvantage." Strong wind: "Disadvantage on ranged attack rolls with weapons. Strong wind puts out open flames, and a flying creature must land at the end of its turn or fall. Attacks with a ranged weapon here roll with Disadvantage, and other ranged attacks remind." Heavy fog: "Heavily Obscured: a creature trying to see something in it has the Blinded condition. The map still shows what light and walls allow, so hide what the party could not see." With the switch off, the line ends "Rolls here ignore it." The rest: "A look only. The rules stay as they are."
7. Last: "Players see it at once. Each device can show it still or turn it off in This device."

Each change sends one `scene.update` with the whole weather, composed valid by `buildWeather` (WeatherSettings.tsx) under these rules, each tested:
- Clear from a heavy kind drops `heavy`. Clear with Calm sends null.
- A kind picked from Clear keeps the wind and its direction, light.
- Fog picked while the wind is Strong, Clear's included, drops it to Moderate.
- Sandstorm picked while the wind is Calm or Moderate raises it to Strong. Leaving Sand for another kind keeps Strong unless that kind is Fog.
- Calm drops the direction, and a wind picked again starts toward the bottom right.
- "Weather rules on rolls" off stays off across kind changes until the DM turns it on or picks Clear with Calm.

Each forced change says so in the wind's help ("The wind is moderate now: strong wind disperses fog."). It goes on the Play history as "changing the weather of Forest road", so Undo puts the old weather back. Co-DMs have it too. Players have no control.

On every form factor this is the same fold in the same page: a phone's sheet held upright, the right-hand sheet held sideways, the tablet's centered sheet, and the side panel on a computer. Every control is 44 px tall at least, and the compass is 3 by 3 buttons of 44 px, 140 px across with its gaps, which fits the 320 px phone at 130%.

Not built (D-261102-131): a top bar chip like the Phase menu, a DM panel row, a tool. The light level, which DMs also change in play, lives in this same group, and the project owner keeps asking for less clutter over the map.

### 4.2 What players see

- The weather on the map, as their device draws it (section 5), on the scene they are on.
- Rolls: a preset shows as a condition's does, named for its weather, such as Disadvantage from "Heavy rain" or "Strong wind", and the roller can change it the same way. Notes show with the roll's other reminders, on the Dice panel and on a request's card.
- A screen reader hears it in the room's polite status, the one `sayView` speaks through (features/view/choice.ts): "Weather here: Heavy rain, Strong wind." when they arrive on a scene with weather or its weather changes, and "The weather here is clear now." when it clears. That status holds one line, so a weather line that comes within 500 ms of a view line joins it, view first ("Isometric view. Weather here: Heavy rain."), through `sayJoined` beside `sayView`. No log line and no toast (D-261102-134).
- The DM's device draws the same: under the DM's translucent fog in Top-down, over it in Isometric (5.1). View as a player and the table display draw it too.

### 4.3 This device and the table display

A new section **Weather** after Map detail, a radio card group named "Weather on the map":

- **Moving** (default): "Rain falls, snow drifts and fog rolls. Uses more battery."
- **Still**: "Shows the weather without moving it."
- **Off**: "No weather on this device. Rolls still follow it."

A help line under it when something else decides: "Reduced motion is on for this device, so weather stays still.", "Low power keeps weather still.", or "Weather was slowing the map, so it stays still until you reload." Kept as `rvtt.weather` ("moving", "still", "off", anything else reads as moving) through `setting()` in features/device/settings.ts. Low power's help becomes "Draws the map at a lower resolution, skips small animations, keeps weather still and shows rolls without dice, to save battery on long sessions. Text on the map looks softer."

The table display's tap menu gains **Weather**: Moving, Still or Off, kept with the display's other choices (features/display/remember.ts), apart from a member's setting in the same browser, as its view is. It also follows its browser's reduced-motion setting and the step-down of 6.3.

### 4.4 While the DM sets up

On the DM's device, weather hides while the Builder, Fog, Line up grid or Traps tool is in use, the four tools that already show Top-down, and comes back with the next tool. Painting and lining up need the map clear, and a big builder stroke should not share its frames.

## 5. Drawing

### 5.1 Where it sits

**Top-down** (D-261102-128). The stage's layers become map, board, **weather**, tokens, overlay. Weather lies over the map image and everything the board layer draws, and under every token body, the party's sight, the fog, and the token decor on the overlay layer. So the fog hides it from players where they have not explored, the darkness dims it where they cannot see, and no token's name, chips, badge or HP bar sits under it. Konva warns past five layers on a stage (`MAX_LAYERS_NUMBER`), so this is the stage's last spare one, and a test holds the count.

The board layer's own text does lie under it: area names, trap pills, map labels and the DM's drawn text. Areas' and traps' pills already publish their boxes (TemplateLayer.tsx and TrapLayer.tsx through `usePublishPills`), so a later build could mask the weather around them, but map labels and drawn text publish none, and a mask is extra work on every tick. Masking is deferred (section 14): they stay under the rain, and the shot pass checks them. With each kind at Heavy and Still, an area name and a trap pill read at 4.5:1 or better against their own backing, measured from pixels, and a kind that misses lowers its veil until it passes. In Isometric those names stand upright, above the weather.

**Isometric.** The ground stage keeps its one layer. The main stage becomes relief, **weather**, drag, upright. Rain falls down the screen in front of the ground, raised ground and standees, and under the drag layer's moving marks, ruler readings and other members' drags, and the upright layer's names, chips, labels, pins and silhouettes. It lies over the ground's fog too, the DM's included, clipped to the scene's ground outline (the bounds through the view's turn and squash), so it falls over black where a player has not explored. That shows nothing: it is the same rain everywhere inside a shape players already hold. A standee this device drags rises into the drag layer, above the rain, until it drops. Raised ground at the map's far edge rises past the outline, so its tops above that edge get no rain. That seam is accepted and recorded, since growing the clip by the relief's height would draw rain past the map.

Splitting the ground stage's layer to put the rain under the ground fog was weighed and left out: the ground layer is the copy source of raised tops and runs on the isometric scheduler, the most tuned code on the board.

### 5.2 How it draws

- **One room-scoped controller, two mount points.** `WeatherController` joins `CONTROLLERS` (features/layers.ts), mounts once outside both trees, and owns the particles, the clock and the mode. `WeatherLayer` mounts in Top-down's stage and in the isometric main stage. Each is a `<Layer listening={false}>` holding one `<Shape sceneFunc>`, mounted only while the scene has weather and the device draws it, and it registers with the controller only while its tree shows (`TreeShownContext`). So a hidden tree's layer never draws, and a clear scene has no fifth canvas.
- **Screen space, 1x.** On mount the layer calls `layer.getCanvas().setPixelRatio(1)` (Konva 10.7.1, `Canvas.setPixelRatio`), so a 3x phone draws one ninth of its native pixels. The sceneFunc resets the context with `setTransform(1, 0, 0, 1, 0, 0)` and draws in CSS pixels, clipped to the scene on screen.
- **One owner of time.** Only the controller's tick steps the field. It runs on requestAnimationFrame while Moving, and on a frame 30 ms or more after its last tick, by its own tick time, it steps the field by the time since, clamped to 50 ms, and calls the weather layer's `draw()` at once, in that frame. So a 60 Hz phone ticks every second frame and a 120 Hz one every fourth: 30 a second. `batchDraw()` is never used for a tick, since it would defer the draw a frame and gate a 60 Hz clock down to 20.
- **The sceneFunc only reads.** It draws the field as it stands and never steps it. It reads the camera from its own stage's attributes (`x`, `y`, `scaleX`) as it draws, in both views, so the pan it anchors to is the one that stage draws with. The draw's own cost is timed inside it, for the step-down.
- **Camera draws, outside the gate, one source in both views.** The camera sits on the weather layer's own stage in both: Top-down's stage takes it as props (Stage.tsx:1710-1713), and in Isometric the applier sets `x`, `y` and scale on the main stage as well as the ground stage (IsoBoard.tsx:488-494). The scheduler takes over `batchDraw` on the ground and relief layers only (scheduler.ts), so a camera change makes Konva `batchDraw` the main stage's other layers, the weather's included, once. That stage's own `batchDraw` is the only camera draw. The controller subscribes to no camera at all (the slot's `drawn` is null in Top-down, liveCamera.ts), so nothing draws a second time. A sceneFunc run that no tick started counts as a camera draw, apart from ticks, and neither steps the field, so a pan never speeds the rain.
- **Anchored to the map on a pan.** Each particle's spot is its own drift plus the stage's pan, wrapped into the screen and a margin, so a pan carries the weather with the ground. Zoom keeps particles their screen size. Fog's noise sheets scale with the zoom, held within half and twice their size.
- **Wind on screen.** Top-down: particles move along the wind on the map, with a steady screen-down part so calm rain still falls (15 degrees off vertical). Isometric: they fall down the screen and drift with the wind turned by the view's turn and squashed as the ground is. Moderate wind drifts at the table's speeds, Strong at twice them.
- **Batched.** Rain, sand, ash and wind streaks are one path and one stroke or fill a tick, snow one path of arcs. Leaves are one `drawImage` each from a small atlas. Fog is two pattern fills of a tiling noise sheet. A heavy kind's veil is one `fillRect`.
- **Still** has no ticks: it draws one frame of the field and redraws it only on camera draws. **Off**, a setup tool, a clear scene or a hidden page mount no layer.
- **Stops when unseen**: the page hidden (`visibilitychange`), the room's map tree frozen, a panel filling the whole screen, a scene still loading, the room closed, or View as a player standing over the DM's room (features/dm/PlayerPreview.tsx), whose own board draws its weather while the covered room's loop waits. A table display in another window on the same computer keeps its own loop, since both windows show. It starts again within one frame of the map showing.
- **Loaded when needed.** The drawing code is a lazy chunk through `retryableLazy` with no roles, so it is never preloaded, fetched the first time a scene with weather shows. It sits in the same `LoadBoundary` and quiet failure report `quietLazy` uses (lib/quietFailures.ts), named "The weather". Until it loads nothing draws.

### 5.3 The kinds

Counts are per 100,000 CSS px² of map on screen (a phone held upright shows about 330,000), light / heavy, with the cap for any screen. Sizes and speeds are CSS px and px per second.

| Kind | Particles | Cap | Look | Motion |
|---|---|---|---|---|
| Rain | 40 / 100 streaks | 250 / 600 | 1 / 1.5 px wide, 10 to 18 / 14 to 26 long, `#c8d8f0` at 35% / 45%. Heavy adds a `#1b2a3a` veil at 12% and, in Top-down, a 6 px ring where 1 drop in 200 lands | 700 to 1,100 |
| Snow | 25 / 70 flakes | 150 / 400 | Discs of 1 to 2.5 / 1.5 to 3.5 px radius, `#f4f8ff` at 85%. Heavy adds a white veil at 10% | 30 to 70 / 60 to 140, swaying 8 px |
| Fog | none | none | Two tiling noise sheets in `#d9dee4`: patchy at 18% and 12%, heavy at 35% and 25% | 3 to 8, along the wind |
| Falling leaves | 6 / 16 | 40 / 100 | 6 to 12 px, six shapes drawn in code in four autumn colors | 40 to 120 with the wind (150 to 250 strong), turning 0.5 to 2 times a second |
| Ash | 30 / 80 flakes | 200 / 500 | 2 to 4 px gray flakes (`#8a8a8a` to `#c9c9c9`) at 80%. Heavy adds a `#3a3330` haze at 12% | 15 to 40, swaying |
| Sand | 60 / 160 grains | 400 / 900 | 2 to 7 px streaks of `#d6b77a` at 80%, a haze at 8% / 30%, and in a sandstorm a fast noise sheet | 250 to 500 along the wind |
| Clear, with a wind | 8 / 20 streaks (Moderate / Strong) | 60 / 150 | Faint 1 px streaks, 30 to 60 px long, white at 15% | 300 to 600 along the wind |

No kind ever flashes: nothing changes brightness faster than its drift, and no veil passes 35%. The builder may tune colors and speeds by eye with screenshots for the project owner, within the contrast check of 5.1, and records each change in As built.

## 6. Performance

### 6.1 Budget

The main risk is a mid-range phone held upright for a four-hour session with the screen kept awake. `scripts/bench-weather.ts` follows bench-iso's pattern and room, but on a 390 by 844 page at 3x on purpose, where bench-iso uses 2x (bench-iso.ts:94): the weather layer's fixed 1x and the other layers' cap at 2 are what a 3x phone tests. The processor is slowed 4 times. Targets:

- At rest with Heavy rain and Strong wind moving, the main thread is busy at most 60 ms a second (6%) more than with no weather, in Top-down and Isometric.
- A pan's and a drag's 95th percentile frame grow by at most 2 ms.
- Still and Off: no loop at rest, no busy time.

A kind that misses lowers its caps until it passes, and As built says so.

### 6.2 Measured for this design

A throwaway page outside the repository drew each kind at its heavy count in a 1x canvas over a still 2x one, in desktop Chrome at 390 by 844 and 3x, slowed 4 and 6 times, and at 1440 by 900, 2x, slowed 4 times, at the desktop caps. The script per draw was under 0.1 ms at the median in every case and at most 0.4 ms at the 95th percentile on the phone page (0.6 ms at the desktop caps, 900 sand grains). Frames held 16.7 ms with none over 20 ms in 120. A 2x canvas cost the script nothing more: the cost that grows with pixels is the GPU's raster, which a laptop's GPU does not show. So, as for the dice (docs/design/design-v1-roll-animation.md 8), only a phone can say what the GPU pays: the live play review on a phone is the check, and the switch and the step-down are the way out.

### 6.3 The step-down

The controller watches its own ticks while Moving, in 3 s windows. If the median gap between ticks is over 50 ms (under 20 a second), or the 95th percentile draw time inside the sceneFunc is over 4 ms, it steps down once, from all the particles to half, then to Still. Fog has no particles to halve, so it steps straight to Still, and every other kind, a heavy one's veil and all, halves first. A step lasts until the page reloads, so it never swings back and forth, and This device says so (4.3). Nothing is stored.

A 2 s warm-up comes before the first window and again after every start, every resume (the page or the tree shown again, a panel off the screen, a setup tool put away), every scene load and every remount (a Low power or interface size change remounts the stage). A window that holds a pause or a remount is dropped, so one stall, such as a tab coming back or a scene's map decoding, never counts.

### 6.4 Sizes and caps

- One weather per scene, about 60 bytes. No cap needed beyond the scene count.
- The weather canvas at 1x: 1.3 MB on a 390 by 844 phone, 5.2 MB at 1440 by 900, 5.6 MB on a 1366 by 1024 tablet. Konva keeps a non-listening layer's hit canvas at 0 by 0 (`Layer._syncHitCanvasSize`), so none is allocated. The stage's other layers stay at min(devicePixelRatio, 2).
- Textures made in code on a kind's first use: two 256 by 256 noise sheets (512 KB) for Fog and Sand, a 144 by 24 leaf atlas. Released when the scene clears or the device turns weather off.
- At most 900 particles on any screen.

## 7. Privacy

- A player's device receives a scene's `weather` only with that scene, and a player receives only the players' scene, and nothing while blacked out (`projectSceneCtx`). So weather the DM prepares on another scene never leaves the DM's devices.
- The weather names a look and its rules, nothing of the map. Drawing it reads the scene's bounds and the camera, never fog, walls, tokens or the build, so it cannot outline anything hidden: in Top-down it sits under the fog, and in Isometric it is the same everywhere inside the bounds players already hold.
- Presets read only the weather of a scene the viewer holds and the viewer's own view of the creature and its stat block.
- No log line, no op, no event carries weather to anyone else. A screen reader's status speaks only on the viewer's own device.

## 8. Accessibility and the UI checklist

- **Loading:** nothing waits on a person. The lazy chunk and the textures take a moment once, and the weather simply starts.
- **Keys and focus:** no new key or gesture, so no shortcut sheet or FEATURES.md shortcut change. The fold and its controls are in Tab order like every setting. The compass is one radio group, one Tab stop.
- **Screen readers:** the fold says its state ("Weather, Heavy rain · Strong wind, collapsed"), the compass group is named "Wind blows toward", each radio "Toward the top right", the switch "Weather rules on rolls", the canvas is `aria-hidden` with no pointer events, and the polite status speaks the weather (4.2).
- **Large interface sizes:** the fold and This device's cards wrap at 320 px and 130%, the summary moves under the name as the group summaries do, and particles keep their map size whatever the interface size.
- **Contrast:** no token's name, chips, badge or HP bar sits under the weather, the densest veil is 35%, and the board's own text keeps 4.5:1 by the check in 5.1. Rules lines use Help, and Note for heavy fog's warning.
- **Reduced motion** keeps it Still, read live through `matchMedia("(prefers-reduced-motion: reduce)")` and its change event.
- **Words shown**, all in section 4: the kind and strength names, "Calm", "Moderate", "Strong", "Moderate wind" and "Strong wind" alone, "Blows toward", the eight "Toward the …" names, "Weather rules on rolls" and its help, the rules lines, the three This device cards and their help, the display menu's Weather, the status lines, the Play history's "changing the weather of <scene>".

## 9. The model

### 9.1 State

In a new `shared/weather.ts`, the contract the rest of the build reads:

```ts
export const WEATHER_KINDS = ["clear", "rain", "snow", "fog", "leaves", "ash", "sand"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];
/** A scene's weather (Scene.weather). Only what differs from the default is stored. Clear and calm is no weather. */
export type SceneWeather = {
  kind: WeatherKind;
  /** Heavy rain or snow, heavy fog, a sandstorm, or more leaves or ash. Never with "clear". Absent reads as light. */
  heavy?: true;
  /** Absent reads as calm. "clear" always has one. */
  wind?: "moderate" | "strong";
  /** Degrees clockwise from the map's top edge, a multiple of 45 under 360. Only with a wind. Absent reads as 135. */
  toward?: number;
  /** "Weather rules on rolls" off: the look stays, presets and notes go. Absent reads as on. */
  rules?: false;
};
export const DEFAULT_TOWARD = 135;
/** Why a weather cannot be, in the picker's words, or null: fog with strong wind, a sandstorm without it, clear with heavy or no wind. */
export function weatherProblem(w: SceneWeather): string | null;
/** The one stored form: drops `toward` without a wind or at 135. */
export function normalWeather(w: SceneWeather): SceneWeather;
/** "Heavy rain", "Patchy fog", "Sandstorm", "Strong wind", for summaries, sources and the status. */
export function weatherName(w: SceneWeather): string;
```

`Scene` (shared/model.ts) gains `weather?: SceneWeather`, absent as clear and calm, so every scene from before reads as it was. The picker sends null, never a clear and calm weather, which `weatherProblem` refuses.

### 9.2 Ops and permissions

- `scene.update`'s patch gains `weather: sceneWeather.nullable().optional()`, a strict object refined by `weatherProblem`. Null removes it. `scene.create` takes none: a new scene starts clear. No new op.
- The reducer (shared/reducer/room.ts) stores `normalWeather` of what it is given, so one weather has one stored form.
- `scene.update` is the DM's already (shared/permissions.ts `forPlayer` refuses it), so players and the table display cannot set it.
- Undo: a patch of only `weather` is Play (shared/undoScope.ts, beside `suggestedView`), labeled "changing the weather of <scene>" (server/rooms/undoLabels.ts).

### 9.3 Copies

- Duplicate keeps the weather, since it copies the scene whole (shared/reducer/duplicate.ts).
- "Like <scene>" and Use these settings on other scenes… do not copy it: they copy the rules of what players see, and weather is a place's mood at a moment. Their words already name what they copy.
- A room backup carries it in the scene. `server/rooms/stateSchema.ts` gains the field with the same `weatherProblem` refinement, so an import refuses a hand-made impossible weather, and the import stores `normalWeather` of each, so a backup's weather lands in the one stored form. Export as image and thumbnails draw their own canvases, so they never show weather.

### 9.4 Versions, replay and migration

- **OP_VERSION 41**, an identity step: `scene.update` may carry `weather`, a new optional field, so no stored op changes shape, and nothing the reducer writes on its own changes, so no rule is gated.
- **SNAPSHOT_VERSION 32**, an identity step: a v31 room is a v32 room as it is.
- The numbers move only because an older build's strict schemas refuse the field: such a build refuses the room cleanly, and going back is the backup's restore (README, Updating), as for `suggestedView`.
- They are the next free pair when this builds: if another Later-list build ships first, this takes the pair after it, and if several ship in one deploy, they share one bump made by the first build, as wave 7 did.
- Deploy: back up first and reload open pages, since an old page drops the field from its view and draws no weather. Rollback needs the backup for a room with a version 41 op after its snapshot or a v32 snapshot.

## 10. Files

**Shared and server.** `shared/weather.ts` (new), `shared/model.ts`, `shared/protocol.ts`, `shared/reducer/room.ts`, `shared/project.ts` (`SCENE_FOR_PLAYERS.weather: "copied"`, with "It names a look and its rules, nothing of the map", and `projectSceneCtx`), `shared/migrate.ts`, `shared/undoScope.ts`, `server/rooms/undoLabels.ts`, `server/rooms/stateSchema.ts` and the import's normalizing, `shared/rules/weather.ts` (new: `weatherRules`, the presets and notes, each with `quotes`), `shared/rules/rollReminders.ts` (`reminderPreset` and `rollReminders` take an optional weather, and a reminder's key may be a weather rule's), `shared/dice/bonus.ts` (`D20Test` and `NamedRoll` of 2.1), `shared/dice/named.ts` (range and weapon, `rangedOf` moved in, `attackTest`), `shared/rules/pcStats.ts`, `client/features/pcstats/fromBlock.ts` (reads the moved helper), `scripts/srd-import.ts` (the `environment` entries, the weapon lists and the two `EM_DASH_FIXES`), `shared/srd/rules-text.json` and `shared/srd/rules-text.ts`.

**The drawing core.** All new, in `client/features/weather/`: `looks.ts` (5.3 as data), `sim.ts` (the field: counts by area and caps, seeded spots, the step, the wrap with the pan, a resize that keeps the first particles, half density), `draw.ts` (each kind into a 2D context, reading the field only), `textures.ts` (the noise sheet and the leaf atlas, made in code), `mode.ts` (the mode of 5.2, the tick gate and the step-down of 6.3 with its warm-ups, as one pure state machine).

**The board and the devices.** `client/features/weather/WeatherController.tsx`, `WeatherLayer.tsx` and `store.ts` (new), one mount line each in `client/canvas/Stage.tsx` and `client/canvas/relief/IsoBoard.tsx`, the controller's line and the five-layer comment in `client/features/layers.ts`, the covered-room signal in `client/features/dm/PlayerPreview.tsx`, `client/features/device/settings.ts` (`rvtt.weather`), `client/features/device/ThisDevice.tsx`, the display's menu in `client/features/display/DisplayRoom.tsx` and `remember.ts`, `scripts/bench-weather.ts` (new), `e2e/weather.e2e.ts` (new, E2E_PORT + 33, the first free offset today).

**The DM's controls and rolls.** `client/features/weather/WeatherSettings.tsx` (new, the fold), `client/features/weather/WeatherVoice.ts` (new, the status lines), `client/features/view/choice.ts` (`sayJoined`), `client/features/weather/forCreature.ts` (new, 2's "which creatures"), `client/components/Icon.tsx` (`windToward`, drawn for the app, so no credit changes), `client/features/vision/VisionSettings.tsx` (the fold's mount), `client/features/scenes/sceneSummary.ts`, `client/features/dice/presets.ts`, `client/features/dice/RollOptions.tsx` and `client/features/dice/groupSave/GroupOptions.tsx` (`attackTest`), `client/features/dice/options.ts` and `client/features/rolls/card.ts` (the sources' names), `client/features/rolls/PlayerRolls.tsx` (a request's reminders), steps in `e2e/scenesetup.e2e.ts` and `e2e/dice.e2e.ts`, roots in `e2e/alignmentRoom.ts`, and the docs: FEATURES.md (a "Weather" section after Fog and vision, This device's line, Low power's, the table display's menu), `docs/dm-guide.md` (a short Weather section in guide prose, with a screenshot), `docs/design/design.md` 14.2 (five layers, and the one loop at rest) and its quote of Low power's help, this note and its README line.

## 11. Cases

| Case | Expected | Test |
|---|---|---|
| DM picks Heavy rain on the players' scene | Pat's map shows rain within a second, the DM's too, Play history "changing the weather of Forest road" | weather.e2e wx-1, scenesetup.e2e wx-ui-1 |
| DM picks Clear with Strong wind | Stored as clear with a wind, named "Strong wind", faint streaks, the wind's rules | weather.test, WeatherSettings test |
| DM picks Clear with Calm | The fold sends null, no weather stored | WeatherSettings test, reducer test |
| DM sets weather on a scene the players are not on | Pat's socket never receives `weather` | weather.e2e wx-2, project test |
| DM moves players to that scene | Pat's map shows it, the status says "Weather here: …", joined after the view's line when both come | weather.e2e wx-2, choice test |
| Fog chosen while wind is Strong | Wind drops to Moderate, help says why | WeatherSettings test, scenesetup.e2e wx-ui-2 |
| A hand-made op or backup with fog and strong wind, a sandstorm with calm, or clear and calm | Refused by the op schema and the state schema | weather.test, stateSchema test |
| `toward` 135, `toward` with no wind | Stored without it, by op and by import | reducer test, itest |
| Undo right after | The old weather comes back on every device | scenesetup.e2e wx-ui-1 |
| Pat's Perception check in heavy rain | Disadvantage, named Heavy rain | dice.e2e wx-ui-3, rules tests |
| Strong wind: Scout's Longbow, Goblin Warrior's Shortbow, a PC's Longbow | Disadvantage, named Strong wind | named test, pcStats test, dice.e2e wx-ui-3 |
| Strong wind: Stone Golem's Force Bolt, Spirit Naga's Necrotic Ray, Ape's Rock, Ogre's Javelin, a PC's Javelin | A note, no preset | named test, pcStats test |
| Strong wind: a melee Scimitar, a spell attack, the bare d20 | Nothing | rules tests |
| A group attack of three Goblin Warriors' Shortbows in strong wind | Each takes the preset, the group's note says so | GroupOptions test |
| "Weather rules on rolls" off | The look stays, no preset and no note | rules tests, scenesetup.e2e wx-ui-2 |
| Restrained creature's DEX save in a sandstorm | Restrained's Disadvantage only | rollReminders test |
| Heavy fog, Pat's attack | A note, no preset | rules tests |
| A character with no token on the scene | No weather preset | forCreature test |
| Reduced motion emulated | No ticks, a draw only on camera changes | weather.e2e wx-3 |
| This device Still, Off, and Low power | Still: camera draws only. Off: no weather canvas. Low power: Still | weather.e2e wx-4 |
| The display's menu set to Off | No weather canvas on the display, the member's setting in the same browser unchanged | weather.e2e wx-8 |
| A pan or zoom while Moving, in Top-down, in Isometric and after switching views | One camera draw per stage draw, from the stage's own `batchDraw`, the particles do not advance, ticks stay 30 a second | controller test, weather.e2e wx-1 and wx-6 |
| A 2014 Ranged Spell Attack under Actions in strong wind | A spell attack: nothing | named test, rules tests |
| Page hidden, a panel over the whole screen, View as a player over the DM's room | No ticks in the covered board until shown again, then within one frame. The preview draws its own | weather.e2e wx-5, mode test |
| Isometric | The weather canvas is the main stage's second layer, clipped to the ground outline, drawn with its stage's camera | weather.e2e wx-6 |
| Top-down | Third of five layers, no Konva warning in the console | weather.e2e wx-6 |
| The DM picks the Builder | Weather hides, Select brings it back | weather.e2e wx-7 |
| A device too slow | Half the particles, then Still, This device says so | mode random test |
| One stall on resume, a remount, a scene load | No step-down | mode random test |
| Turn the phone, resize the window | Particles recounted by area, none jump | sim test |
| Tab back after a minute away | Particles continue from where they were, not thrown | sim test (step clamp) |
| Backup and import | The weather comes along, in its stored form | server itest |
| An older build loads a v32 room | Refused cleanly | migrate test |
| Duplicate a rainy scene | The copy rains. "Like" and the copy sheet do not | reducer test, copyRules test |
| View as a player, table display | Both draw it | weather.e2e wx-8 |
| Area names and trap pills under each heavy kind, Still | 4.5:1 or better | weather.e2e wx-9 |
| Every screen at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130% | Nothing over 1 px out of line | alignment roots |

## 12. Tests

**Unit** (`node:test`):
- `shared/weather.test.ts`: `weatherProblem` for every kind, strength and wind, Clear included, `normalWeather`'s one form, the schema's refusals in its words, `weatherName` for each.
- `shared/rules/weather.test.ts`: every rule's quotes are in `rules-text.json`'s `environment` text, each preset and note of section 2's table, and nothing with `rules: false`. `shared/rules/weather.random.test.ts` (fast-check, every weather by every D20Test): weather adds only Disadvantage, only to Perception checks and to ranged attacks with `weapon`, never to saves, death saves, Initiative, spell attacks or `"either"`, and a light kind adds nothing.
- `shared/dice/named.test.ts` additions, on the SRD's own blocks: one case per source of 2.1 (2024 ranged weapon by name, 2024 Thrown weapon by name as a "Ranged Attack Roll", 2024 ranged not a weapon, "Melee or Ranged", 2014 "Ranged Weapon Attack", 2014 "Melee or Ranged Weapon Attack", 2014 "Ranged Spell Attack" under Actions through `attackTest` and the weather rule, a melee weapon), with the creatures of section 11. `shared/rules/pcStats.test.ts` additions, through `namedRollOf`, for a PC's ranged, Thrown and other weapon. A test on GroupOptions' rolls that each creature's attack carries its `attackTest`.
- `shared/rules/rollReminders.test.ts` additions: weather with conditions, each source once.
- Reducer, projection (`SCENE_FOR_PLAYERS` is a `Record<keyof Scene, …>`, so the new key cannot be missed), undo scope and label, migrate identity steps and the refusal of a newer version, the state schema with its refinement.
- `client/features/weather/sim.test.ts`: counts by area and caps at the three alignment sizes and a 2048 px tablet, the same seed gives the same field, after any pan every particle is inside the wrap box, a 10 s step moves as 50 ms, a resize keeps the first particles.
- `client/features/weather/draw.test.ts`, on a recording fake context: one path a tick for rain, sand, ash, wind and snow, one `drawImage` a leaf, two pattern fills for fog, nothing outside the clip, and two draws of the same field and camera record the same calls, so a draw never steps it.
- `client/features/weather/textures.test.ts`: the noise sheet tiles (its edges match), alpha stays in range.
- `client/features/weather/mode.random.test.ts`, the state machine rule: 2,000 random sequences of frame times, draw times, camera changes, setting changes, reduced motion and Low power flips, page hides and shows, tree switches, panels over the screen, the preview over the room, tool changes, scene loads, remounts and weather changes. Invariants:
  - No loop while the mode is not Moving or nothing shows.
  - No two ticks within 30 ms, and only ticks step the field.
  - Camera draws are counted apart and never step the field.
  - A step-down only goes down within a session, and never from a window holding a pause or a remount, or within 2 s of a start, resume, scene load or remount.
  - A hide stops ticks within one frame.
  - Liveness: with Moving, the map shown and a weather, a tick comes within 100 ms.
- A controller test with a real Konva stage and the isometric scheduler: ticks call `draw()` in their own frame, never `batchDraw()`. A camera change on either stage, and one after switching views, runs the sceneFunc once, through the stage's own `batchDraw`, with the stage's camera, counts it as a camera draw, and makes no extra `draw()`.
- `forCreature.test.ts`, `settings.test.ts` (`parseWeatherMode`), display `remember.test.ts` (its weather apart from the member's), `choice.test.ts` (`sayJoined`, with the view's line first and the weather's first), `WeatherSettings` render tests (every `buildWeather` rule of 4.1, Wind under Clear, disabled winds and their help, the compass's names, the switch), `sceneSummary.test.ts`.
- Mutation check: remove the fog and wind refusal, the weapon signal, the projection's copy, the 30 ms gate, the read-only sceneFunc, the step clamp, the warm-up restart and the step-down's one-way rule, and say which test fails.

**Integration** (`server/rooms/weather.itest.ts`): the DM's weather reaches a player on that scene and not one elsewhere, a player's `scene.update` is refused, a stored version 40 op then a version 41 op replay, a backup round trip keeps it in its stored form, and an import of an impossible weather is refused.

**e2e:** `weather.e2e.ts` steps `wx-1` to `wx-9` (table above), with weather set through the DM's socket so they need no UI, the canvas read through test hooks: its `data-weather` ("rain heavy strong", set on change) and `weatherTicks` and `weatherCameraDraws` properties, counted apart, so no attribute changes 30 times a second. `scenesetup.e2e.ts` `wx-ui-1` and `wx-ui-2` and `dice.e2e.ts` `wx-ui-3` drive the fold and the rolls. Run with `reach`, `iso` (the main stage gains a layer), `display`, `scenesetup` and `dice`. Alignment: the Weather fold folded and open (Clear with Strong wind, Heavy rain with its compass and switch, heavy fog's note) joins `sceneSettingsTests`, and This device's Weather section joins the settings roots, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%.

**Bench:** `scripts/bench-weather.ts`, each kind heavy with strong wind and none, Top-down and Isometric, at rest, panning and dragging, gated by 6.1.

## 13. Decisions

- **D-261102-125** Weather never changes sight. It is a look, plus roll presets and notes. Rejected: a sight distance cap for heavy fog (no SRD rule gives a distance, it changes what the server sends each player, so it needs op gating, golden fixtures and per-player vision work), and a look with no rules at all (the SRD gives two clear ones).
- **D-261102-126** One weather per scene, on the scene. Rejected: areas or masks of weather (a mask over unexplored rooms would send players their shapes, and a client-derived one is a project of its own), weather per map phase (later), one weather for the whole room (scenes are different places).
- **D-261102-127** Six kinds and Clear, two strengths, three winds, eight directions, and a wind that can blow on a clear day. Rejected: hail, embers, birds and a storm with lightning (lightning flashes, and embers can come later), free sliders for density and speed, Gale and Storm (no SRD rule tells them apart from Strong), wind only with a falling kind (a windy clear day is common, and strong wind has its own rules).
- **D-261102-128** On the ground in Top-down (between the board and the tokens), in the air in Isometric (between the standees and the drag layer). It never covers token names, chips or HP, and the board's own text stays under it with a contrast check. Rejected: over everything in screen space (it would cover names, HP and readings, and fall over the fog's black in Top-down), between the creatures and the fog (rain over monsters but not the party, who draw above the fog), under the ground fog in Isometric (it splits the scheduler's ground layer), holes around board text for now (pills publish their boxes, but map labels and drawn text do not, and a mask costs every tick, so it is deferred).
- **D-261102-129** Canvas 2D on one Konva layer at 1x, 30 ticks a second owned by the controller, which alone steps the field and draws at once, and camera draws outside that gate, made only by the weather layer's own stage, whose camera the sceneFunc reads. Rejected: a camera subscription of the controller's (it draws twice in Isometric, and the slot's `drawn` is null in Top-down), three.js or WebGL shaders (a second GL context beside the dice and a large chunk), CSS or DOM particles, image sprites, a gate on `batchDraw` (it defers a frame and runs at 20 on 60 Hz).
- **D-261102-130** Moving by default on every device, with Still and Off in This device and in the table display's menu, Still under reduced motion and Low power, and a one-way step-down with warm-ups after every start, resume, load and remount. Rejected: Still by default on phones (the DM picks weather for its motion), a room switch the DM sets for everyone (battery and motion are each device's), an automatic step back up (it would swing).
- **D-261102-131** The DM's control is a Weather fold in What players see, applied at once, on the Play history, its open state the component's like its sibling fold. Rejected: a top bar chip or menu like Phase, a DM panel row, a tool, a draft to publish like fog edits (nothing is secret), a stored fold state (the sibling keeps none).
- **D-261102-132** Presets only where the SRD needs no judgment: Perception checks in heavy rain, heavy snow and a sandstorm, and in strong wind only attacks with a positive ranged weapon signal, for creatures with a token on the scene, with a "Weather rules on rolls" switch for indoor scenes. Rejected: notes only (presets are how the app carries a clear rule), any ranged non-spell attack (Force Bolt and Necrotic Ray are not weapons), putting out torches on their own (which lights are open flames is a call), a turn-end reminder for fliers (a reducer change with op gating, later), Passive Perception minus 5 (later).
- **D-261102-133** The next free op and snapshot versions as identity steps, or one shared bump. Rejected: no bump (an older build would meet a field its strict schemas refuse and fail on the room instead of refusing it cleanly).
- **D-261102-134** Players learn of weather by seeing it, by their rolls and by the polite status, joined with the view's line when both come. Duplicate copies it, Like and the copy sheet do not, new scenes start clear. Rejected: a log line or a toast on every change (the DM may adjust it several times while setting a mood), a second live region (two lines at once would talk over each other), copying it with Use these settings.

## 14. Later

- Weather kept out of built rooms, read from the build each device already holds.
- Weather masked around area and trap pills in Top-down, from the boxes `usePublishPills` already publishes.
- Weather per map phase, as Light with each map phase does.
- A sight distance in heavy fog, if the project owner asks for it.
- A turn-end reminder for fliers in strong wind, a "Put out open flames" button, and Passive Perception minus 5 in heavy precipitation.
- Rain and wind sounds, with the ambient sound design. Animated maps can reuse the loop and the step-down.
- The calendar picking weather by season, should the calendar design want it.

## As built

Where the build went its own way, by part.

**Model, ops and rules.**
- The versions are OP_VERSION 43 and SNAPSHOT_VERSION 33, after the calendar's 42 and 32, both identity steps (9.4 says 41 and 32).
- The Play label reads "changing the weather of the scene Forest road", the form every scene label uses.
- The rules lines for heavy snow, a sandstorm and patchy fog, and the form with "Weather rules on rolls" off, are the build's words. Heavy rain's, heavy fog's and strong wind's are section 4.1's.
- The SRD bows not named for a weapon (Great Bow, Bone Bow, Enchanting Bow, Necrotic Bow) only remind, as 2.1 accepts.
- `server/rooms/remap.ts` holds the import's one line of normalizing.
- A weapon imported from D&D Beyond keeps D&D Beyond's own word on its range on its roll (`PcRoll.range`, ranged or either, in the same version step), so a magic bow named for itself counts for strong wind. A roll the player edits goes by its name again. The range is outside re-sync's hash, so a re-sync brings D&D Beyond's range to a linked roll the player has not changed, one imported before the range was read among them, with nothing to review, and leaves an edited roll as it is. D&D Beyond's 2014 names such as "Crossbow, Light" read as the SRD's Light Crossbow.

**The drawing core and the board.**
- Konva is 10.9.0, not 10.7.1. `setPixelRatio` and the 0 by 0 hit canvas hold.
- The controller's clock is tested in Node with hand-run frames (`store.test.ts`), and the real Konva stage is tested in the browser (`weather.e2e.ts` wx-1 and wx-6), since Node has no canvas.
- A full-screen sheet is a signal of the bar dock (`sheetFull`), and each layer registration counts as a remount for the step-down's warm-up. The mode has no input for a frozen map tree or a closed room: neither has a layer registered, which `layer` already says.
- A scene edit anywhere sends the whole scene, so the room keeps its look and its particles while the weather draws the same. The same weather blowing another way keeps the particles, turns their motion, and redraws a layer held still once.
- This device's help line sits under the group's name, where the radio cards put help, and shows only while Moving is chosen. The table display keeps its choice under its own key, apart from the member's.
- wx-9's contrast check reads each pill's words from the screen, held still, at 2x and at 1x, and first with no weather, so a failure says whether the words or the weather lost the contrast. With no weather they read about 13:1 at both. A sandstorm read 4.2:1 at 1x and 4.5:1 at 2x, so its haze is 24% and its noise sheet 14%, under 5.3's 30% and 20%, and it now reads 5.4:1 or better at both. Every other heavy kind reads 8:1 or better.
- **The step-down (6.3) also judges what each tick adds to its whole frame, paint included.** On a canvas with no GPU the sceneFunc took 0.1 ms and the cost landed in painting after it, so each loop frame is timed from its start to a message task that runs after its paint, and a measure that comes back after the next frame has started counts nothing. A tick's cost is its frame less the mean of the frames on either side of it that have no tick, each within one and a half frames of it, and a tick with no such neighbour says nothing. So a pan, a drag, the dice or the isometric board's background work, which the frames beside the tick pay too, cancels out within a frame. At 33 frames a second or fewer every frame ticks, so the loop holds one tick in four, which leaves a frame to measure against, shows the particles one frame longer and, with the step's 50 ms clamp, moves them about an eighth slower there. A window steps down when the median of its ticks' costs is over 2 ms, section 6.1's 60 ms a second at 30 ticks, beside 6.3's 4 ms draw and 50 ms gap. Where ticks were held, two ticks share each held frame as their measure, so one window can read slow by chance on a board whose frames vary by several ms, and the frame cost steps down only after two slow windows in a row. A step's slow window counts toward the next level's two. With the 2 s warm-up and 3 s windows, a particle kind halves about 5 s after it starts and holds still about 10 s after, a window later at 33 frames a second or fewer, and fog holds still at about 5 s.
- The bench (`scripts/bench-weather.ts`, 3x phone, processor slowed 4 times, and `--software` for a canvas with no GPU) reads each kind's rest once the step-down has settled, held still or two windows past its last step, and the level a fresh page is left at after 11 s of panning. With a GPU no kind steps down, panned or not, ticks add 0.1 to 0.8 ms to their frames, rest costs 13 to 51 ms a second over no weather, and pan and drag frames stay within 0.1 ms of none. With no GPU every kind holds still in both views, its ticks having added 1.7 to 8.6 ms to their frames, and rest is then within 0.2 ms a second of none. Its Isometric pan read 33.4 ms at the 95th percentile with rain and 16.8 with none, one frame's step that earlier software runs showed with no weather too, so with `--software` the bench prints the pan and drag rows as information and gates only rest and the ticks at rest, which follow the level the step-down leaves.

**The controls and rolls.**
- `buildWeather` lives in `client/features/weather/buildWeather.ts`, apart from the fold's component, so its rules test as plain functions. A pick the weather cannot hold (Strong in fog, Calm or Moderate in a sandstorm) changes nothing, since the fold disables those.
- A new kind always starts light, so a sandstorm or heavy fog is a pick of its own, and Clear drops the strength. Wind and direction carry over.
- Calm needs no code to forget the direction: the stored weather keeps `toward` only with a wind, and the picker is rebuilt from it.
- The compass is nine 44 px cells, the centre one holding the small square, so a row of it is as tall as its buttons.
- The folded What players see summary names the weather after the light, before Sight.
- The status speaks through the View button's voice (`useWeatherVoice` beside `useViewVoice`), joined by `sayJoined` within 500 ms of a view line, the view's line first in either order. A change of the wind's direction or of the rules switch names nothing new, so it says nothing. What it last said is the Room page's (`weatherSeenSlot`), so a View button that mounts again says nothing again. The table display speaks the weather in its own polite status too.
- The wind's forced reason ("The wind is moderate now: strong wind disperses fog.") shows only while the scene holds the weather that pick sent, so an Undo or a co-DM's change takes it away.
- `presetFor` reads the weather of the scene the creature stands on (`forCreature.ts`), for which `DiceView` gained the viewer's scene. A request's card passes the same weather to `rollReminders`.
- `options.ts` and `card.ts` name a weather source through `WEATHER_RULE_NAMES`, as "Dis: Heavy rain".
- 4.2's notes show on the Dice panel, as words before a tap. Every reminder a roll's preset holds, a condition's or the weather's, shows in a Help line under the name of each group it bears on, each said once there: Saves and checks, Skills (patchy fog's Perception reminder), and a group of attacks, which also says what bears on them all and what only some weapons bring ("Longbow Dis: Strong wind"). On the card, Initiative's and the death save's show under their buttons, and Initiative's leaves out what the death save's already said. Each reminder also joins its option's name for a screen reader. This reverses round 1's notes in names only, which a sighted phone user never saw (D-261102-656). An attack's button shows the Disadvantage its own weapon brings, where it showed none before, since the group's label no longer says every weapon's preset. A shared attack for several creatures says its attackers' preset words and reminders under it.
- A shared attack's rolls are built by `attackPanelRolls`, so each creature's attack takes its own test.

## Design review

Two rounds of design review changed this note before the build, and every finding was adopted:
- 2.1: a positive ranged weapon signal on `NamedRoll` and `D20Test`, from the entry's text and the SRD's weapon names, with notes for every other ranged attack. `NamedRoll` gains `spell`, and the character's path is `namedRollOf`.
- 4.1 and 4.2: Clear with a wind is a weather of its own, and the fold's open state is the component's. `sayJoined` puts the view's line and the weather's in one announcement.
- 5.1 and 5.2: the board's own text stays under the rain with a measured contrast check, the controller alone steps the field and calls `draw()`, one camera source serves both views, View as a player stops the covered room's loop, and the lazy chunk is a `retryableLazy` inside the quiet failure report.
- 6.1 and 6.3: the bench runs at 3x on purpose, and the step-down's warm-up restarts after every start, resume, scene load and remount.
- 2 and 9.3: two `EM_DASH_FIXES` entries, and the state schema refines with `weatherProblem` while the import stores `normalWeather`.
