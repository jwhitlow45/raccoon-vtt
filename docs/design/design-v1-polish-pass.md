# raccoon-vtt: the polish pass for the Later-list features and this feature run

Status: built (2026-11-06). Draft 2 at review consensus, with the two notes of round 2 adopted. Base main `188e60bc`. Decisions D-261106-065 to D-261106-079 (section 9). The "As built" section at the end says where the build went its own way, and the measured numbers in sections 3 and 8 are the design's, so read them with it.

The project owner (2026-11-03): "ultimately i want to make sure all of these new features are polished (including their ui/ux) and look as done as the rest of the app which took a lot of ui passes to ensure consistent spacing, etc." On headings, the same day: they should be more direct ("Player vision" for "What players see"), as the general posture. From the look pass (2026-10-18): "these aren't necessarily hard rules either i just want things that make sense given a design review." And 2026-11-06: "overall just make the app quicker to use", and "i just want these things to feel intuitive to use and not too weirdly layed out".

## 1. Scope

**In** (D-261106-065): the Scenes tab (its six groups, Light and weather with the scene's weather and its rules, New scene, the scenes list), the dungeon generator dialog, join requests (the join page's cards, the DM panel's Join requests), snap-off (Place freely and Snap to grid), animated maps (the Map image row's buttons, This device's Moving and Still), the DM panel's folding groups, This device (its groups and the dice set tiles), the side panel's edge and Reset width, the sheets' step arrows, the light theme across all of these, and the heading sweep (HEADINGS-SWEEP, AMBC-HEAD) for every surface not listed under Out. Follow-ups folded in: DICESET-ALIGN, LP30FIX-S-1, and live play 31 lane A's three polish notes (the pin pane's swatches, Map detail's Low power summary, the chosen scene row).

**Out**, owned by the layout redesign lane (2026-11-06): the panel list's groups, Ambiance, Time, the Weather row, Sound, the Music window and the maker. Their notes went to that lane: the step buttons' mixed sizes, "Month 3 1", the hollow Stop squares and PLR-23, "for everyone" on the volumes, the player's plain Sound lines, the backup card's wrap and PLR-24. Nothing here edits a file under `client/features/sound`, `client/features/ambiance`, `client/features/clock` or `client/features/panels.ts`'s groups. Scene sound stays a Scenes group here, its name a noun already.

## 2. How it was measured

Two throwaway prototypes on main, never committed: draft 1's, and draft 2's on `188e60bc` with the changes below. Both build one room with `ROOM_SOUND=1 ANIMATED_MAPS=1`: Goblin cave (16 × 9, heavy rain and a strong wind, the e2e fixture `map-loop.webm` as an animated map with a still, the players' scene), a second scene Crypt with the same video map (so the DM can stand where the players are not), Bree placed a quarter square off her box, a goblin, Pat as a player, and in draft 1 Rowan asking to join. Each root is measured with `measureAlignment` and `measureSpacing`. Rows of buttons are read as lines: each button's words, width, the lines its words take, and whether they overflow.

**The matrix.** M is a browser measurement, C a calculation from measured widths, a dash not checked.

| Surface | 1440 × 900 | 1280 × 720 | 1440 at 130% | 390 × 844 | 390 at 130% | 320 at 130% |
|---|---|---|---|---|---|---|
| Scenes, Light and weather open (heavy rain and wind, then heavy fog), and folded | M | M | M | M | M | M |
| Map image row: players here unarmed, armed, players elsewhere, Remove armed | M | M | M | M | M | M |
| Map image row while an upload is busy | M | - | - | - | - | - |
| Dungeon dialog | M | M | M | M | M | M |
| Dungeon dialog either side of 736 px of body (3.4) | 794 and 806 wide at 100%, M | | 1032 and 1048 wide at 130%, M | | | |
| DM panel, Preview open | M | M | M | M | M | M |
| This device, Map detail and Rolls open, and the dice set | M | M | M | M | M | M |
| Token bar, every button's words on one line | M | M | M | M | M | M |
| New scene, side edge and Reset width (520 px), sheet arrows (700 × 900 with a mouse) | M (draft 1) | M (New scene, draft 1) | M (New scene, draft 1) | - | - | - |
| Join cards, ask card, waiting card, swatches (pin pane, join page) | - | - | - | M (draft 1) | - | - |

Draft 1 claimed the dungeon, the DM panel and This device at 1280 × 720 and at 1440 at 130%. Its script never opened them there: those figures were calculations. Draft 2 measured them (appendix A). The armed Remove's longest words ("… all 12 phases") were set in the armed button itself for a moment and measured, since the test room has one phase. Paste's busy words were not measured: 3.3 rests on how flex wraps, not on a width.

Every surface measured 0 over 1 px in draft 1's audit, except: the dice set tiles (8 findings at 100%, 9 at 130%), the join page's waiting card (its spinner line 1.1 px left of the card's words), and two findings that are the design's own (the join page's header stands at the card's edge, 17 px left of the cards' words, and the side panel's More tab carries its count badge at the corner, as the Panels button does). The problems below are mostly ones the geometry check cannot see: lines that wrap alone, text that cuts or runs long, labels that break inside a button, and names.

## 3. Surfaces and fixes

Each fix reuses what the app already does for the same kind of thing, named in its line.

### 3.1 Scenes: the six groups' folded summaries (D-261106-066)

**Wrong.** At 1440 × 900 the side panel's 327 px of content cuts two of six summaries with "…": "Map image · Squares, 40 …" and "Walls block mo…". At 320 × 568 at 130% four cut. The DM panel and This device never cut a summary that fits on its own line (`Group`'s `wholeSummary`, D-261102-767). Scenes keeps the 4em floor (scenes-reorg 3, dp-1a).

**Fix.** Scenes' six groups take `wholeSummary`, as the DM panel's and This device's do: a summary stands beside the name where it fits whole, else whole on its own line under the name, cut only where that line is too short. `SceneSettings.tsx` `group()` adds `wholeSummary: true`. The token panel, the character page and the dice options keep the floor: they are play panels where a two-line header pushes the HP entry and the rolls down. Measured at 1440: Map and grid and Walls and movement each take a second line (+19 px each), the other four stay one line.

### 3.2 Light and weather: the weather rules (D-261106-067)

**Wrong.** With heavy rain and a strong wind, "Weather rules on rolls" carries one paragraph as its help: 422 characters, 11 lines in the 269 px beside the switch at 1440, "Perception" three times. It mixes what the SRD says with what rolls here do.

**Fix.** Split the two. The switch's help says what rolls here do, in one sentence. Under the switch, one short line per weather part, its name in weight 600 and the SRD's words after it, at the full width of the panel, as the dice sheet's reminder lines already name each rule ("Heavy rain: …", `WEATHER_RULES[].text`, read by `rollReminders.ts`). A new pure `weatherRuleLines(weather)` in `shared/rules/weather.ts` returns `{ lines, rolls }`, each line `{ name, text, advice?, tone, quotes }`. `weatherRules` goes once nothing reads it (WeatherSettings is its one caller).

**The rolls sentence.** With the rules on, it names exactly the tests `weatherPreset` presets and then the ones it reminds:

| Weather | Rules on |
|---|---|
| Heavy rain or heavy snow, calm or moderate wind | "Perception checks here roll with Disadvantage." |
| Heavy rain or heavy snow with a strong wind, and a sandstorm (always a strong wind) | "Perception checks and ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder." |
| A strong wind with anything else (clear, light rain or snow, leaves, ash, blowing sand) | "Ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder." |
| Patchy fog, calm or moderate | "Perception checks here get a reminder." |
| Heavy fog, calm or moderate | "Perception checks and attacks here get a reminder." |

Heavy fog reminds on Perception checks and on every attack (`applies: PERCEPTION || ATTACK`, `does: "note"`). Fog with a strong wind cannot be (`shared/weather.ts:40` `weatherProblem`, "Strong wind disperses fog."), so it has no sentence. With the rules off the sentence is "Rolls here ignore these rules." for every weather, and the lines stay. With no rule (a light kind, a moderate wind, clear) there is no switch and the line stays "A look only. The rules stay as they are."

**The lines and their SRD words** (SRD 5.2.1, Gameplay Toolbox, Environmental Effects, and Playing the Game, Vision and Light, Obscured Areas):

- Heavy rain: "Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks. Puts out open flames." Quotes: "Everything within an area of heavy rain or heavy snowfall is Lightly Obscured", "creatures in the area have Disadvantage on all Wisdom (Perception) checks", "Heavy rain also extinguishes open flames."
- Heavy snow: "Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks." The first two quotes.
- Sandstorm: "Disadvantage on Wisdom (Perception) checks." Quote: "A strong wind in a desert can create a sandstorm that imposes Disadvantage on Wisdom (Perception) checks."
- Patchy fog: "Lightly Obscured: Disadvantage on Wisdom (Perception) checks that rely on sight." Quote: "In a Lightly Obscured area, such as an area with Dim Light, patchy fog, or moderate foliage, you have Disadvantage on Wisdom (Perception) checks that rely on sight."
- Heavy fog: "Heavily Obscured: a creature trying to see something in it has the Blinded condition." Quotes: "A Heavily Obscured area, such as an area with Darkness, heavy fog, or dense foliage, is opaque.", "You have the Blinded condition", "when trying to see something there". Then the app's own advice, kept apart in `advice`: "The map still shows what light and walls allow, so hide what the party could not see."
- Strong wind: "Disadvantage on ranged attack rolls with weapons. Puts out open flames, and a flying creature must land at the end of its turn or fall." Quotes: "Strong wind imposes Disadvantage on ranged attack rolls with weapons.", "It also extinguishes open flames", "A flying creature in a strong wind must land at the end of its turn or fall."

**The look.** A line is `Help` with its name in weight 600 in the text color. Heavy fog's line is a `Note` (components/Panel.tsx: Help in the warning tone, the look a setting's cost wears), its name in weight 600 in the same tone, then its text and its advice. Today's warning-colored span in the switch's help is the same color, so the tone does not change.

Measured in the prototype (1440, heavy rain and a strong wind): the switch's help 3 lines (114 characters), then the two lines, 9 lines in three parts against 11 in one, "Perception" twice. Heavy fog: 2 lines of switch help, then a 4-line Note (shot 20). At 320 at 130% the switch's help takes 8 lines beside the switch, and heavy fog's 4.

### 3.3 Map and grid: the Map image row's buttons (D-261106-068)

**Wrong.** With an animated map, Replace map image (158 px), Remove map image (158) and Use the still only (137) stand one per line, three lines of different widths, though two fit side by side in 327 px.

**Fix.** Two rules, the same in every state. Use the still only (for a video) stands last on the picker's line, after Replace map image or Add a map image (or Choose the image) and Paste an image. Remove map image stands alone on its own last line. Both lines fill (the local `Row` in SceneSettings.tsx takes `fill`: a grid cell per child that grows to share its line, as the Initiative panel's fight buttons and the token window's rows do, design-v1-polish R6). A label that changes under the pointer then never moves its own button. Flex places an item only by what stands before it, so a button whose words shrink stays put: Paste's busy words ("Pasting…") are shorter than "Paste an image", and only what follows it can move. Remove's armed words ("Tap again to remove", or "… all N phases") are longer, and alone on its line nothing reflows beside it. Where even its own line is too short, Remove's words wrap inside it: the scenes `ConfirmButton` (scenes/controls.tsx) takes `wrap`, as the token panel's (tokens/ui.tsx) already does. Today at 320 × 568 at 130%, "Tap again to remove all 3 phases" needs 216 layout px in a 211 px line and overflows the panel's edge by 5 px. With `wrap` it takes two lines inside the same 57 px button, its top unmoved (measured). Of the other scenes `ConfirmButton`s, Clear the build's words are short, a phase's Remove already shrinks, This device's "Tap again to reset all keys" (ShortcutSheet.tsx) is five characters shorter than Remove's longest (a calculation, not measured), and the Music maker's belongs to the layout redesign lane. This supersedes design-v1-animated-maps 4.2's "below the row's buttons" and SceneSettings.tsx:758-767's comment, which PA rewrites.

The lines in each state, as main's SceneSettings.tsx:768-810 keeps every button reachable in each:

| State | Lines (1440, 327 px), measured |
|---|---|
| Players elsewhere | Replace map image + Paste an image, then Use the still only, then Remove map image |
| Players here, unarmed | Replace map image (the ask) + Use the still only, then Remove map image |
| Players here, armed | The players' Note, the first map's fog choice where it shows, Choose the image + Paste an image, then Use the still only, then Cancel at its own width, then Remove map image |
| Busy (an upload running, either scene) | On the players' scene their Note first. The busy picker (its step and spinner, disabled) + Paste (disabled), then Use the still only (disabled), then Remove map image, then the upload's Cancel for a video. Measured with the players elsewhere: Uploading… + Paste, then Use the still only, then Remove |

Use the still only is disabled while an upload runs, as today. Remove is not, as today. The players' scene keeps its ask: on the players' scene nothing takes a paste until the DM confirms (`unconfirmed`). Arming Remove with Paste shown moved no button by 0.5 px or more at all six sizes (measured). At 390 at 130% and 320 at 130% every button takes its own full line in every state, the busy state not measured there.

### 3.4 The dungeon generator: the preview's empty column (D-261106-069)

**Wrong.** At 1440 × 900 the dialog is 720 px (`dialog.lg`) and the preview a 335 px square, so 282 px of the left column stand empty under it while the choices scroll beside it.

**Fix.** The dialog takes `dialog.xl` (1040 px, the Music window's width, already in `theme.layout.dialog`). The preview's side comes from a new pure `previewSide(width, height)` beside `useBodyLayout`, where `width` is the body's content width and `room` is that less the 16 px gap:

- side = the smaller of the body's height and the larger of `room / 2` and `room − 360`, floored.
- So half the room is the preview's floor, as today. The choices keep 360 px (`theme.layout.sidePanelWidth`, the width every panel's Segmented rows are designed at, the widest here Small to Custom at 299 px) only once the width allows it: from a body width of 736 px. Below it the two columns split evenly, as today.
- In the window: the card is `min(1040, window − 32)` and the body's content 34 px narrower (its padding and border), so the boundary is a window 802 layout px wide (802 px at 100%, about 1043 px at 130%). Two columns still start at a body of 640 px with its padding (`TWO_COLUMNS_PX`), a window of 674 layout px. A phone, and any card under `TWO_COLUMNS_PX`, is unchanged.

Measured, in layout px:

| Window | Card | Body | Preview | Choices |
|---|---|---|---|---|
| 1440 × 900 | 1040 | 1006 × 601 | 601 (the height caps it) | 389 |
| 1280 × 720 | 1040 | 1006 × 529 | 529 (the height caps it) | 461 |
| 1440 × 900 at 130% | 1040 | 1006 × 502 | 502 (the height caps it) | 488 |
| 794 × 900, and 1032 × 900 at 130% | 762 | 728 | 356 | 356, even |
| 806 × 900 | 774 | 740 | 364 | 360 |
| 1048 × 900 at 130% | 774 | 741 | 365 | 360 |

Draft 1's figure for 1440 at 130% (choices 360, preview 448) was a calculation, and wrong. On the smallest phone at 130% (320 × 568) the stacked preview is 73 px, 40% of a 184 px body, as today: a follow-up for the dungeon lane, since a taller one pushes the choices under the fold.

### 3.5 Snap-off: Place freely and Snap to grid (D-261106-070)

**Wrong.** On a computer's 317 px bar Roll, Attach and Place freely share a line and Snap to grid wraps alone, stretched to 291 px. On a 390 phone all four fit one line.

**Fix.** The two placement buttons wrap as one unit in the play row: a flex unit that grows like a button (`ROW_BUTTON_FLEX`) and wraps inside itself (`flexWrap: "wrap"`), so each takes half its line, and where the two do not fit side by side each takes a line of its own. At 317 px: Roll and Attach on one line, Place freely and Snap to grid on the next. At 320 × 568 at 130% they fall to one per line. The grouping is a pure helper (`barButtons.ts` `rowUnits`), so a test holds it. Snap to grid still shows only for a placed token, and Place freely alone is a plain button as today. Draft 1's unit had no wrap, and its saved 320 at 130% shot shows "Place / freely" and "Snap to / grid" broken inside their buttons, which `measureAlignment` cannot see. Draft 2 measured every bar button's words on one line at all six sizes. Rejected: one Segmented "Grid | Free" (Place freely is a toggle for one drag, Snap to grid a one-off action, so a chosen "Free" would lie about the next drag of a placed token, which snaps).

### 3.6 This device: the dice set tiles (DICESET-ALIGN, D-261106-071)

**Wrong, measured.** `measureAlignment` reports each tile's name 26 px low (33.8 at 130%), and at 130% the chosen tile's padding 1.3 px less than its neighbors'. On screen the tiles are centered: 9 px over the die and 9 under the name. Two causes. The die's canvas is placed absolutely inside its 48 px box, and the check measures absolutely placed content only when nothing else flows, so it sees the name alone. And the chosen tile pays for its 2 px ring out of its padding.

**Fix, nothing visible.** The canvas takes the flow in its box (it and the drawn fallback die never show together). The chosen ring's second pixel is an inset shadow, so every tile has the same 1 px border and padding, as `theme.shadow.markInside` draws a second line inside a box. Then the alignment sweep measures This device with Rolls open (`e2e/alignmentRoom.ts` around :6807 drops its "Rolls stays folded" exception).

### 3.7 This device: Map detail's Held still (lp31a, D-261106-072)

Folded, Map detail says "Phone size · Moving" while something holds every animated map still. Weather says "Moving · Held still" in the same case. Map detail mirrors Weather exactly: `DeviceValues` takes `animatedHeld`, which `ThisDevice.tsx` sets to `animatedStill !== null` (`useDeviceStillReason()`, AnimMapController.tsx:178: Low power, reduced motion or the step-down), beside `weatherHeld: weatherStill !== null`. `summaries.ts` adds "Held still" after Moving only while Moving is chosen and `animatedHeld` holds. Draft 1 checked Low power alone, so under reduced motion Map detail would have said Moving while Weather said Held still. Moving and Still themselves measured 0 and match Map images' cards: no change.

### 3.8 Swatches in a column (lp31a, D-261106-073)

The pin pane's color disks start 8 px right of its other rows (10.4 at 130%), since each 28 px disk sits in a 44 px target. The same holds wherever a row of swatches stands in a column of rows: Your color on the join page, the ask card, Members, and the Icons tab's Disk color (`images/IconsTab.tsx`, under the icon grid). `Swatches` takes `flush`: the row starts `(touch − 28) / 2` = 8 px out, so the disks' edge is the column's edge, as a checkbox's box is, and the chosen ring stands 4 px out, as a focus ring does. The 8 px lands in the dialog's or pane's 16 px padding, inside its scroller, so nothing clips the ring (a calculation for the Icons tab, whose root PE1 adds). A tool's options and the popovers keep today's place: their slots measure the 44 px targets (`OptSwatches`, `PopoverSwatches`, and the drawing, area, measure, stamp and pin tool options).

### 3.9 Join requests (LP30FIX-S-1, D-261106-074)

- The waiting card says "Waiting for the DM" three ways: its title, "You asked to join as Rowan.", and the spinner's "Waiting for the DM…". The spinner's line takes the sentence instead ("You asked to join as Rowan.", or `LETTING_IN`, "The DM is letting you in…", while the DM decides, both unchanged in askToJoin.ts), one line fewer. Before, the spinner line stood 1.1 px left of the card's words (measured at 390). With the sentence moved into it, the card measured 0.
- LP30FIX-S-1: `pages/Join.tsx` ~145 to 159 wraps Ask again in a one-child grid. A grid of one adds no gap, so the space comes from the card. Drop the wrapper. Nothing moves.
- The DM panel's Join requests measured 0, its name on its peers' edge: no change.

### 3.10 The scenes list's chosen row (lp31a, D-261106-078)

Lane A measured the chosen row 5 px left of the others with the DM on a Map image scene the players are not on. Draft 1's battle mat scene in that state measured 0, at 1440 dark and light, the list and the whole folded panel. Draft 2 did not measure the list again. The build reproduces lane A's exact state (a Map image scene made from New scene, Fog and vision folded with its No walls tag), finds the cause in `SceneList.tsx` if there is one, and adds a sweep root in that state either way.

### 3.11 No change, measured

The side panel's edge and Reset width (1440 at 520 px: 0, the More tab's corner badge is the Panels button's), the sheets' step arrows (700 × 900 with a mouse: 0), New scene (0. "From a Universal VTT file" opens a dialog, so it stays a button of its own rather than a fourth kind), the DM panel's groups other than one name (0), the dungeon dialog on a phone (0), and the light theme: every preview shot was taken in both looks and nothing reads differently in light.

## 4. The heading sweep (HEADINGS-SWEEP, AMBC-HEAD)

### 4.1 What is a heading here (D-261106-075)

Renamed when clause-style: section labels, group names, panel and subpage titles, card and dialog titles that name a place, and setting row names. An accessible name that only repeats its heading follows it (the trap pane's "Goes off when" group and "Hits" radiogroup, the request's "Who rolls" chip row). One that says more than its heading keeps its words (the compass's "Wind blows toward"). Kept as they are, each a class with its reason:

- **Titles that name the one action they perform**, mostly the words of the button that opens them: Generate a dungeon, Crop the image, Export the log, Attach a stat block, Take a shape, Discard this step, Create a room, Join a room, Ask to join, Sign in, and the danger section Delete this room. A title named for its act tells the DM what Done will do.
- **Questions that ask the user to decide** (Forget this room?, Who are you?, Is this you?, No password?) and **status and error titles** (Waiting for the DM, The DM said no, Page not found, This link looks cut off).
- **One word that is a noun too and names the only act below it**: End, Remove. (Clean up becomes the noun Cleanup, 4.2.)
- **Adjective labels that sort a list**: Recent, Same name, Farther away.
- **Gerunds that read as nouns**: Joining, Finding and disarming.
- **Captions that say where a strip came from**: `<Help>From starter packs</Help>` under "Or use a map already in this room" (NewScene.tsx:612, HandoutsSection.tsx:497). They are Help, not headings, and say where each strip's art came from, as the From starter packs button beside them does.
- **Control labels**: Switch labels (a switch is named by what On means, design-v1-visual 3.7), RadioCards and Segmented legends whose options answer them, field labels, and tool option labels. HEADINGS-CONTROLS is offered as a follow-up for the project owner: Room settings' wh- legends and the tool options' Clear or add fog, When players see edits, Nudge the box, Start from, Point on, Cube reaches and Stairs point.

### 4.2 The renames (D-261106-076, D-261106-077)

33 headings at 45 sites (draft 1 said 41: it missed the second sites of Goes off when, Who rolls and Who it is for, and two of Adding an image's three, and Blows toward's compass now keeps its name). Refs: FEATURES.md lines, guide lines (none is a guide heading, so no anchor moves), e2e files with counts. Every new name was checked against its screen's siblings ("Screens and siblings" in headings-inventory.md, the full inventory with every cross-reference by line).

The project owner's own example was "Player vision" for "What players see". It was flagged that it clashes with Fog and vision (then "Fog and party vision") and suggested "Player view" (next-plan, 2026-11-03 16:58). Scenes-reorg renamed the Scenes group Fog and vision (D-261102-861). The three sites left say what players see of a roll's result or a token, not their sight, so "Player view" fits them, and "Player vision" would promise sight rules those sections do not hold.

| Today | New | Where (client), sites | FEATURES | Guide | e2e | Clash checked against |
|---|---|---|---|---|---|---|
| Start a fight with | New fight | TrackerPanel.tsx:629 | - | 147, 903, 2041 | combatuses 3, tokenpanel-summaries 3 | This device |
| Add to the fight | More creatures | TrackerPanel.tsx:723 | 207, 208, 414 | 851, 910, 1292, 1744 | combat 4, combatuses 7 | the bar's Add to the fight button stays a verb |
| Join the fight | Your creatures | TrackerPanel.tsx:792 | 399 | 910, 1744, 2144 | combat 6 | Group HP, HP changes |
| Several at once | Group HP | TrackerPanel.tsx:555 | - | 968, 2136 | combat 3, alignmentRoom 1 | HP changes, the Multi-select switch inside |
| Place on the map | Placement | EncountersPanel.tsx:340 | - | 139, 756, 770, 779, 2031, 2111 | combatuses 1, smoke 1 | Monsters, Party, XP budget |
| Clean up | Cleanup | LibraryGrid.tsx:365 | 238 | - | layout 2, pdf 2 | Maps, Token images, Handouts |
| From starter packs (N) | Starter packs (N) | library.ts:169 | 98, 233, 238, 582 | 138, 194, 249, 250, 263, 1590 | desk 1, maps 1, scenesetup 1, size 1, tokenpanel 3 | Starter maps (a dialog) |
| Check these | Warnings | PcStatsEditor.tsx:612, SyncReview.tsx:118 | - | - | resync 1 | |
| Also set | Other fields | PcStatsEditor.tsx:623, SyncReview.tsx:146 | - | 1711, 1716, 1722 | resync 2 | |
| Your changes, kept (N) | Kept changes (N) | SyncReview.tsx:162 | - | 1712 | resync 3 | Changes from D&D Beyond (N), Overwritten changes (N) |
| Different from D&D Beyond (N) | Unmatched values (N) | SyncReview.tsx:170 | - | 1722 | resync 1 | Changes from D&D Beyond (N), Kept changes (N) |
| Replaces your changes (N) | Overwritten changes (N) | SyncReview.tsx:191 | - | 1678 | pcstats 1, resync 2 | Kept changes (N) |
| Check what was read (dialog) | Import review | PcStatsEditor.tsx:385 | - | 1678 | pcstats 2, resync 3 | |
| Check what changes (dialog) | Re-sync review | Resync.tsx:324, :348 | - | 1708, 1714, 1718 | resync 7, alignmentRoom 1 | Re-sync <name> |
| What to roll | Roll | RequestSheet.tsx:324 | - | 1103 | playerphone 3, reach 1, reachRoom 1, rolls 2 | Recent |
| Or the second | Second choice | RequestSheet.tsx:324 | - | - | attach 1, combat 1, rolls 2, tools 1 | First choice |
| Who rolls (and its chip row) | Creatures | RequestSheet.tsx:273, :275 | 477 | 1093, 1105 | tools 1 | |
| What players see (×3) | Player view | RequestSheet.tsx:283, GroupSave.tsx:542, GroupMoreSheet.tsx:123 | 468 | 468, 679, 1106, 1203 | rolls 2 | Look, Owners (GroupMoreSheet) |
| Played by (×2) | Players | CharacterCard.tsx:276, CharactersPanel.tsx:496 | 502 | 1665, 1667 | characters 1, tokenpanel-lines 4 | The party, Room settings' Players is another screen |
| At <Class> <level> | <Class> <level> | ResourceSheet.tsx:288 | - | - | - | Remove |
| Check their view | Preview | ViewControls.tsx:91 | 539 | 1588, 1595, 1602, 1612 | layout 6, dmphone 2, joinrequests 1, lighttheme 1, alignmentRoom 1 | Players' screens, Player link (D-261106-077) |
| Goes off when (and its group) | Trigger | TrapPane.tsx:245, :247 | 383 | 1501, 1523 | traps 5 | |
| Afterwards | Aftermath | TrapPane.tsx:286 | 383 | 1502 | hex 2, traps 4 | |
| Hits (and its radiogroup) | Targets | TrapPane.tsx:312, :634 | 383 | 1503 | traps 8, alignmentRoom 5, lighttheme 1, shortcuts 2 | Save and damage |
| Players read | Message | TrapPane.tsx:320 | 383 | 1505 | traps 2 | its field "What players read" stays |
| It also | Map effects | TrapPane.tsx:341 | 383 | 1506 | traps 1 | |
| Or count the squares | Square count | SceneSettings.tsx:463 | - | 219, 298, 342, 344 | hex 1 | Map grid |
| Light with each map phase | Light per phase | VisionSettings.tsx:77 | 97 | 216, 505, 697 | - | Light |
| Blows toward | Direction, help "Where it blows toward, by the map's edges as Top-down shows them." | WeatherSettings.tsx:100 (the compass at :132 stays "Wind blows toward") | 342, 346 | 584 | scenesetup 2, alignmentRoom 1 | Wind |
| Who lends sight / Who lends the party sight | Sight sources | VisionSettings.tsx:498 | 97, 336 | 218, 507, 510, 557 | - | Sight |
| Who it is for (and its Segmented) | Version | MapExport.tsx:216, :225 | - | - | - | its options Player view and DM view |
| Adding an image (shortcut sheet) | Images | state/shortcuts.ts:762, :1279, :1317 | 884 | - | shortcuts 2 | the sheet's other surfaces |
| For your players (Home card) | Player link | Home.tsx:451 | - | - | - | the DM panel's Player link names the same link |

The re-sync review can show Changes from D&D Beyond, Kept changes, Unmatched values and Overwritten changes on one screen. "Differences" beside "Changes from D&D Beyond" read as two names for one thing. "Unmatched values" says only that they differ from D&D Beyond, which is all the app knows of them (`differentIntro`: "a change of yours cannot be told from one there"), and the row ticks still say what each does ("Overwrite with D&D Beyond's", "Take these", "Keep mine").

Unit tests that hold these words move with them: `panels/DmPanel.test.ts`, `features/dm/summaries.test.ts`, `features/pcstats/SyncReview.test.ts`, `features/images/LibraryGrid.test.ts` and `library.test.ts`, `state/shortcuts.test.ts`, `features/vision/VisionSettings.test.ts`, `features/weather/WeatherSettings.test.ts`, `features/scenes/SceneSettings.test.ts`. `lib/folds.test.ts` stays: its names describe the move from the old scene heading to Fog and vision, which is accurate history. The e2e files that assert whole heading orders break first: combat.e2e.ts :980, :1004, :1287, layout.e2e.ts :2431, :2104, resync.e2e.ts :842, characters.e2e.ts :529, shortcuts.e2e.ts :152 to :155 and :258 to :260, traps.e2e.ts :769, :1199. Fold keys, ids and `data-` marks never change.

Comments that name an old heading as the screen's words move with it, in the lane that owns the file (comment-only files included): ViewControls.tsx:24, dm/summaries.ts:29, tokens/groupEdit.ts:227, tokens/companions.ts:208, TrackerPanel.tsx:676, TrapPane.tsx:640 and :888, GroupSave.tsx:1262, traps/rules.ts:673 and :678, traps/TrapTool.tsx:113 and measure/controls.tsx:1188 (PH1), LibraryGrid.tsx:82, :233, :241 and :770, images/library.ts:243, handouts/pdf/live.ts:148, handouts/pdf/job.ts:258 and animmap/upload.ts:140 (PH2a), SyncReview.tsx:15 to :19, :27, :50 and :74, pcstats/resync.ts:16 and :271, pcstats/flow.ts:108 and :325, tokens/panelOrder.ts:220 and components/Row.tsx:210 (PH2b), and SceneSettings.tsx:758 to :767 (PA). They stay where an old name is the code's own name for a part, beside identifiers that keep theirs as fold keys do (`AlsoItem`, `alsoLine`, `checkLines`, `keptRow`): pcstats/resync.ts:306, :350, :378 and :392, shared/rules/pcSync.ts, pcFill.ts and resourceSync.ts, and shared/ddb/resources.ts, each citing a design note's section by that note's words. They stay too where they keep history (settingsFolds.ts:17, lib/folds.ts:225), where they only describe (form.ts:36, create.ts:167, sightRaster.ts:35, vision/sources.ts:8, dice/blockRolls.ts:36, shared/model.ts, shared/protocol.ts), and where they name the bars' Start a fight and Add to the fight buttons, which keep their words (combat/state.ts:230, groupEdit.ts:30 and :213 to :225, TokenActionBar.tsx:600).

## 5. Changes the project owner already saw (D-261106-079 tells the owner each at the time)

1. Scenes' folded summaries no longer cut with "…": a long one moves whole to its own line under the name (Map and grid, Walls and movement at 1440).
2. Weather rules: one sentence for what rolls do under the switch, then one line per weather (heavy rain, strong wind and so on), in place of the paragraph. Heavy fog's line stays in the warning tone.
3. Map image: Use the still only joins the picker's line, and Remove map image keeps a line of its own, the full width, in every state.
4. The dungeon generator on a computer is wider (1040 px), with a preview that fills its column (601 px square at 1440 × 900).
5. The token bar on a computer: Place freely and Snap to grid share one line, each half of it.
6. The join page's waiting card: "You asked to join as Rowan." beside the spinner, one line fewer.
7. Map detail's folded summary adds "Held still" while something holds animated maps still.
8. Swatches line up with the rows around them (the pin pane, Your color on the join page, the ask card, Members and the Icons tab): 8 px further left.
9. The 33 heading renames in section 4.2, "Check their view" becoming "Preview" among them, and Direction's help now says "toward".

Nothing visible changes for DICESET-ALIGN, LP30FIX-S-1 or the waiting card's 1.1 px. The chosen scene row moves only if the build finds a real offset.

## 6. UI checklist

- **Loading states:** nothing new is slow. The dungeon preview keeps its own drawing state. The waiting card's spinner keeps `delay={0}` and its words are the status. A busy upload keeps its step and spinner on the picker, and Use the still only stays disabled while it runs.
- **Keys and focus:** no control is added or removed. The placement pair keeps both buttons in the bar's Tab order, Place freely first. Map image's buttons keep the order picker, Paste, Use the still only, then Remove last, so focus after a removal goes where it goes today.
- **Screen readers:** renamed headings keep their levels. A fold's button is named by the new name and the summary still describes it. The weather lines are plain text after the switch, which is described by its rolls sentence. The compass stays "Wind blows toward", and its radios "Toward the …". The trap pane's group and radiogroup become "Trigger" and "Targets", the request's chip row "Creatures". The waiting card's status speaks "You asked to join as Rowan.".
- **Large interface sizes:** measured at 130% on 320 × 568, 390 × 844 and 1440 × 900. Whole summaries wrap under the name there (designed). The bar's placement pair falls to one button per line at 320 at 130%, every label on one line. The dungeon at 1440 at 130%: the table in 3.4.
- **The exact words shown:** sections 3.2, 3.3, 3.9 and 4.2.

## 7. Cases and tests

| Case | Expected | Test |
|---|---|---|
| Scene group, long summary, 327 px | Whole on its own line, right-aligned, no "…" | SceneSettings.test (markup asks `wholeSummary`), alignment sweep |
| Scene group, summary that fits | Beside the name, one line | alignment sweep |
| Every valid weather × strength × wind × switch (68 cases) | The sentence names exactly the tests `weatherPreset` presets, then the ones it reminds, over a Perception check, a ranged weapon attack, a maybe-ranged attack and a melee attack | weather.test, every case through `weatherRuleLines` and `weatherPreset` |
| Heavy fog, rules on | "Perception checks and attacks here get a reminder." | weather.test |
| Any weather, rules off | "Rolls here ignore these rules.", the lines stay | weather.test |
| Fog with a strong wind | No case: `weatherProblem` refuses it | weather.test asserts it is skipped as invalid |
| Every rule line | Each quote is in its SRD entry's text, and each rule term in the line (Lightly Obscured, Heavily Obscured, Disadvantage, Perception, rely on sight, Blinded, ranged attack rolls with weapons, flames, flying) is in one of its quotes. The advice stays out of the check | weather.test (as D-261102-860's) |
| Heavy fog's line | A `Note`, its name in weight 600, then its text and its advice | WeatherSettings.test (markup) |
| Clear, or a weather with no rule | "A look only. …", no switch | WeatherSettings.test |
| Direction | Its help says "Where it blows toward, …", the compass is named "Wind blows toward" | WeatherSettings.test |
| Map image, players elsewhere | Picker, Paste, Use the still only on one filled line set, then Remove alone | SceneSettings.test, animmap e2e |
| Map image, players here, unarmed | The ask, Use the still only, then Remove alone | SceneSettings.test, animmap e2e |
| Map image, armed | Note, Choose the image, Paste, Use the still only, then Cancel, then Remove alone | SceneSettings.test, animmap e2e |
| Map image, busy | Picker busy, Paste and Use the still only disabled, Remove alone | SceneSettings.test |
| Armed Remove with Paste shown, 1440 and 320 at 130% | No other button moves by 0.5 px or more, Remove's words on one line | animmap e2e |
| Armed Remove with 3 map phases, 320 at 130% | Its words wrap to two lines inside it, no overflow, its top unmoved | animmap e2e (a scene with phases) |
| `previewSide` at body widths 735, 736 and 737 | 359, 360, 361, choices 360 each time, and 700 gives 342 and 342 | GenerateDialog.test |
| `previewSide` with a short body | The body's height | GenerateDialog.test |
| Dungeon dialog either side of the boundary, 794 and 806 wide at 100%, 1032 and 1048 at 130% | Even columns below, choices 360 above | dungeon e2e |
| Dungeon dialog, 1440 × 900 | xl, preview 601, choices 389 | dungeon e2e |
| Placed token, both buttons | One unit, both halves of one line at 317 px | barButtons.test `rowUnits`, snapoff e2e |
| The bar at 320 × 568 at 130% | Every button's words on one line | snapoff e2e (text line count per button) |
| Unplaced token | Place freely alone, as today | barButtons.test |
| Dice tiles at 130% | 0 findings with Rolls open, every tile's padding equal | alignment sweep root, DiceSetPicker.test |
| Moving chosen, with Low power, with reduced motion, with the step-down | "Phone size · Moving · Held still" in each, and "Phone size · Moving" with none | device summaries.test |
| Pin pane and Icons tab swatches | Disks on the column's edge, 0 findings | alignment roots (pin pane, image picker's Icons tab) |
| Tool option swatches | Unchanged place | options e2e (unchanged) |
| Waiting card | Spinner line holds the sentence, then `LETTING_IN` while deciding, 0 findings | joinCards test, joinrequests e2e |
| Chosen scene row, DM on a map scene, players elsewhere | 0 findings | new alignment root |
| Every renamed heading | Found by its new name, the old gone | the e2e and unit tests in 4.2 |

Mutation: drop `wholeSummary` from `group()`, the preset or remind half of `rolls`, heavy fog's remind entry, a quote, the Note tone, the pair grouping or its wrap, `fill` on Remove's line (or move Remove back beside Use the still only), Remove's `wrap`, Use the still only from any one state, the 360 rule in `previewSide`, the inset ring (back to padding), the canvas's flow, `animatedHeld`, and `flush`'s margin, and each fails a test. A heading rename reverted fails its e2e or unit line.

## 8. The preview

Before the build, draft 2's prototype was drawn on main for every surface in sections 3 and 4, before and after, on a phone (390 × 844) and a computer (1440 × 900), dark and light, and the project owner saw them and said all of them looked good. The shots are not kept in the repository. The build's own shots replace them.

## 9. Decisions

- **D-261106-065, scope.** The layout redesign's surfaces are out, with their notes handed to that lane, and lane A's three polish notes are in. Rejected: polishing Time and Sound now (the redesign replaces them).
- **D-261106-066, Scenes' summaries whole.** Rejected: shorter summary words ("Walls block", dropping "Map image"), which lose meaning, and whole summaries in every group, which grows the token panel's headers in play.
- **D-261106-067, weather rules as a sentence and lines.** Heavy fog says what its switch does like every other weather, and its line is a Note. Rejected: a fold for the rules (one more tap to read what the switch does), a bulleted list (the panel has no bullets elsewhere), shortening the SRD words (each line must say what the SRD says), building the sentence from `WEATHER_RULES`' predicates (the reviewers split, and a table of five sentences checked against `weatherPreset` in every valid case is simpler to read and as safe), and warning-colored Help for heavy fog (the same look under another name: Note is the app's word for it).
- **D-261106-068, Map image's two lines.** Use the still only last on the picker's line, Remove alone on the last, both filled, in every state. Rejected: Remove beside Use the still only (arming widens Remove past its line, Remove wraps and Use the still only, a scene-wide change players see, stretches under the second tap, PD-OPUS-1), reserving the armed width (a 216 px button at rest for a 4 s state), `shrink` on Remove (an ellipsis would cut the words that say what the second tap takes), natural widths (Remove alone under two, which the sweep's wrap-orphan check flags), a two-column grid (a lone half-width Remove), Use the still only on its own line (three stacked full-width buttons on the common unarmed state), and New scene's UVTT button as a fourth kind (it opens a dialog).
- **D-261106-069, the dungeon's xl card.** Half the room is the preview's floor, and the choices' 360 holds from a body of 736 px. Rejected: raising `TWO_COLUMNS_PX` to 736 (a 640 to 736 px card would lose its side-by-side preview for no gain), a 360 floor at every width (a preview under half the room below 736, smaller than today), a tall letterboxed preview (an empty dark box instead of an empty light one), the seed under the preview (still mostly empty), and a sticky summary there (the footer holds it).
- **D-261106-070, the placement pair.** A unit that wraps inside itself. Rejected: a Segmented pair (3.5), an icon-only Snap to grid (its words are its meaning), `nowrap` on the bar's buttons (it would overflow the 320 bar at 130%), and moving both into Size's row (a label and steps).
- **D-261106-071, dice tiles.** Rejected: an exception in the alignment check for this picker (the check is right that absolutely placed art hides from it), and the RadioCards' 1 px chosen look (picture tiles take a 2 px ring, as the starter maps and icons do).
- **D-261106-072, Held still in Map detail.** It reads the same reason the Map detail's help line does. Rejected: Low power alone (reduced motion and the step-down would say Moving beside Weather's Held still), and leaving it.
- **D-261106-073, Swatches `flush`.** Every swatch row standing in a column of rows, the Icons tab included. Rejected: moving every Swatches, popovers and tool slots included (their slot math counts 44 px targets), and shrinking the targets (44 px touch rule).
- **D-261106-074, the waiting card's line.** Rejected: a live "Asked 1 min ago" (a timer for little gain), and keeping both lines.
- **D-261106-075, what counts as a heading.** An accessible name that repeats its heading follows it, one that says more stays. Rejected: renaming action titles, questions, status titles, switch labels and legends now (a noun there hides what is chosen or what Done does), and renaming the From starter packs captions (Help that names a source, beside its button). Offered as HEADINGS-CONTROLS.
- **D-261106-076, the names in 4.2.** Rejected per row where close: "Reinforcements" and "Latecomers" for More creatures (a late PC is neither), "Multi-select" for Group HP (the switch inside has that name), "Visibility" for Player view (the request's fold also holds a note and Against a spell), "Player vision" for Player view (it promises sight rules), "Owners" for Players (the token panel's word for a token, not a character), "Detection" for Finding and disarming (loses disarming), "Audience" for Version, "Your changes" and "Replacements" for Kept changes and Overwritten changes (they drop what the tick decides), "Differences" and "Mismatches" for Unmatched values (a synonym of Changes from D&D Beyond, and a word for an error), and "Wind direction" for Direction with the compass renamed (in everyday use a wind's direction is where it comes from).
- **D-261106-077, AMBC-HEAD: "Check their view" becomes "Preview".** Rejected: "Player view" (beside Players' screens two near-names, and scenes-reorg rejected it for Fog and vision, D-261102-861), "Player preview" (three "Player" headings in a row), "Their view".
- **D-261106-078, the chosen scene row.** Reproduce lane A's state and add the sweep root. Rejected: closing it unmeasured.
- **D-261106-079, the build.** Lanes in section 10, the owner told of each section 5 change at the time. Rejected: one lane (about 100 files), and a fast lane (visual changes across five kinds of surface need this design and the owner's preview).

**Look hardest at:** D-068's two lines (Remove's full-width line is heavy in red), D-076's re-sync names, and D-069's band where the choices stay under 360 (windows of 674 to 802 layout px).

## 10. Lanes and files

Every lane starts from the newest stacked tip. Code lanes run at once (no file in two), then the e2e lanes, then docs. Each runs the e2e files its change touches plus `reach`.

- **PA, Scenes and weather** (M, 11 files): `client/features/scenes/SceneSettings.tsx`, `SceneSettings.test.ts`, `controls.tsx` (`ConfirmButton`'s `wrap`), `SceneList.tsx` (3.10, if the build finds an offset), `client/features/weather/WeatherSettings.tsx`, `WeatherSettings.test.ts`, `shared/rules/weather.ts`, `shared/rules/weather.test.ts`, `client/features/vision/VisionSettings.tsx`, `VisionSettings.test.ts`, `client/features/mapexport/MapExport.tsx`. Sections 3.1 to 3.3, 3.10 and the Scenes rows of 4.2.
- **PB, dialog and bar** (S, 5 files): `client/features/dungeon/GenerateDialog.tsx`, a new `GenerateDialog.test.ts` (`previewSide`), `client/canvas/TokenActionBar.tsx`, `client/canvas/barButtons.ts`, `barButtons.test.ts`. Sections 3.4 and 3.5.
- **PC1, This device** (S, 5 files): `client/features/device/DiceSetPicker.tsx`, `DiceSetPicker.test.ts`, `summaries.ts`, `summaries.test.ts`, `ThisDevice.tsx`. Sections 3.6 and 3.7.
- **PC2, swatches and join** (S, 7 files): `client/components/Swatches.tsx`, `client/features/pins/PinPane.tsx`, `client/features/images/IconsTab.tsx`, `client/pages/Join.tsx`, `client/pages/AskToJoin.tsx`, `client/panels/MembersPanel.tsx`, `client/pages/joinCards.test.ts`. Sections 3.8 and 3.9.
- **PH1, play headings** (M, strings and comments, 15 files): `client/panels/TrackerPanel.tsx`, `client/features/encounters/EncountersPanel.tsx`, `client/features/rolls/RequestSheet.tsx`, `client/features/dice/groupSave/GroupSave.tsx`, `client/features/tokens/GroupMoreSheet.tsx`, `client/features/tokens/groupEdit.ts`, `client/features/tokens/companions.ts`, `client/features/traps/TrapPane.tsx`, `client/features/traps/rules.ts`, `client/features/traps/TrapTool.tsx`, `client/features/measure/controls.tsx` (a comment), `client/features/dm/ViewControls.tsx`, `client/features/dm/summaries.ts`, `client/panels/DmPanel.test.ts`, `client/features/dm/summaries.test.ts`.
- **PH2a, library and sheet headings** (S, strings and comments, 10 files): `client/features/images/LibraryGrid.tsx`, `library.ts`, `LibraryGrid.test.ts`, `library.test.ts`, `client/features/handouts/pdf/live.ts`, `client/features/handouts/pdf/job.ts`, `client/features/animmap/upload.ts` (a comment), `client/state/shortcuts.ts`, `shortcuts.test.ts`, `client/pages/Home.tsx`.
- **PH2b, character headings** (S, strings and comments, 11 files): `client/features/pcstats/SyncReview.tsx`, `SyncReview.test.ts`, `PcStatsEditor.tsx`, `Resync.tsx`, `resync.ts`, `flow.ts`, `client/features/tokens/CharacterCard.tsx`, `CharactersPanel.tsx`, `panelOrder.ts`, `client/components/Row.tsx` (a comment), `client/features/resources/ResourceSheet.tsx`.
- **PE1, alignment and behavior e2e** (M, 6 files): `e2e/alignmentRoom.ts` (roots: This device with Rolls open, the pin pane, the Icons tab, the scenes list in lane A's state, the dungeon dialog at 1440 and 1280, the bar's pair at 317 px, and every renamed heading the sweep names), `e2e/animmap.e2e.ts` (the Map image states and the armed Remove), `e2e/scenesetup.e2e.ts` (the weather words, "Rolls here ignore these rules."), `e2e/dungeon.e2e.ts` (the boundary and 1440), `e2e/snapoff.e2e.ts` (the pair and the labels at 320 at 130%), `e2e/joinrequests.e2e.ts`. It also renames 4.2's names in these files (alignmentRoom, scenesetup, joinrequests). Runs the alignment trio, those five and `reach`.
- **PE2, heading names in e2e** (M, about 25 files): combat, combatuses, tokenpanel-summaries, tokenpanel-lines, tokenpanel, layout, dmphone, lighttheme, traps, hex, characters, resync, pcstats, rolls, playerphone, reach, reachRoom.ts, shortcuts, pdf, smoke, desk, maps, size, attach, tools. Names only, no new steps. Runs each file it touches.
- **PD, docs** (S, last): FEATURES.md (every line in 4.2's FEATURES column and section 5's changes), docs/dm-guide.md (the bold UI names in 4.2's guide column, in guide voice, no anchor moves), this note copied to `docs/design/design-v1-polish-pass.md` with its As built, and `docs/design/README.md`'s index line. The guide's screenshots of these surfaces are the guide pass's (GUIDE-* follow-ups).

Excluded on purpose: `lib/folds.test.ts` (accurate history), `client/dev/Kit.tsx` (its "What to roll" and "Played by Pat" are a kit's sample words, not the app's), `vision/sources.ts:8` and `vision/sightRaster.ts:35` (sentences that describe, not names of a heading), and the From starter packs captions (4.1).

## 11. As built

Built as designed, in the lanes of section 10. These are the places the build went its own way or learned something the design did not know.

- **3.1 to 3.3, Scenes and weather.** The Map image row's lines come from a pure plan, `mapImageLines`, so SceneSettings.test covers the armed and busy states, and each line is keyed by its first button so Remove keeps its armed state. The weather lines follow `WEATHER_RULES` and its `brings`, and each carries its SRD `source` beside the design's fields, so there is one table of rules and no second chain of tests. The rolls sentence stays the design's table of five. After review, no rule line holds a second colon after its name: patchy fog's reads "Lightly Obscured, so Wisdom (Perception) checks that rely on sight have Disadvantage." and heavy fog's "Heavily Obscured, so a creature trying to see something in it has the Blinded condition."
- **3.4, the dungeon dialog.** Built as `previewSide` and the `xl` card. No `data-dungeon-body` mark was added.
- **3.5, the placement pair.** `rowUnits` returns `{ pair: [a, b] }` objects. The wrapper is a `span` with `data-placement-pair`, present only when both buttons show. The wrap style has no unit test, and the alignment sweep's one-line check per bar button covers it.
- **3.6 and 3.7, This device.** The chosen dice tile's border is 1 px with an inset shadow for the second pixel. `useDeviceStillReason` is a hook around the pure `deviceStillReason`, which summaries.test drives with Low power, reduced motion and each step-down, and with none. `heldSites.test.ts` asserted the old 2 px border and now asserts the inset shadow.
- **3.9, the waiting card.** The spinner's line takes the sentence, and the join-requests design note's two mentions of the old line were updated.
- **3.10, the chosen scene row.** The build reproduced the state and found no cause in `SceneList.tsx`. The 5 px finding is the row's accent frame, which the alignment helper read as the row's start because it knew a chosen option only by `aria-checked`, `aria-selected` and `aria-pressed`, while the row marks its scene with `aria-current`. `SceneList.tsx` is unchanged. The fix went to the helper (D-261106-217): it reads `aria-current` as a chosen option, and the new root allows only the by-design row-height difference between a Players here row and a Move players row. After review, that rule reads the heights too, so it allows only Move players rows within 1 px of each other beside one shorter Players here row, and the helper takes a painted box as a chosen frame only where the same place in an unchosen sibling row draws nothing, so a painted card or bar among painted kin, or among rows with no control, keeps its own edge.
- **The alignment helper's other rules.** The new roots for the pin pane and the Icons tab found three more places where the helper misread a layout, not the UI: a chosen swatch's ring, which stands 4 px out by design (3.8), the gap a dialog's pinned foot (`PINNED_FOOT`) takes back above it, and a CSS picture hidden from screen readers, which it held to a button's height. The helper now reads each of them, and also counts `role="menuitemcheckbox"` as a control, which the DM menu's Follow me group uses. Each rule has a drawn case of its own, so a regression fails without the app. The Icons root measures the tab's panel, not the whole picker (D-261106-245, D-261106-246).
- **4.2, the renames.** All 33 headings changed at their sites. Kept on purpose: the bar's "Add to the fight" and "Start a fight" buttons, the field "What players read", the accessible name "Wind blows toward", and the "From starter packs" buttons under New scene's Map image and Show a handout, which name where the art comes from. In FEATURES.md and the DM guide, the old name moved only where it named the heading. Its lines that name a button or lead a paragraph about something else, such as the guide's "What players see." lead-ins about Isometric and the generated dungeon, keep their words.
- **Accessible names changed with their headings:** the trap pane's Trigger group, its Targets radiogroup and the request's Creatures chip row.
- **Docs.** FEATURES.md and the guide got the new sentences of lines 97, 99 and 348 as the lanes worded them. The guide's screenshots of these surfaces are unchanged and are the guide pass's.
- **Unrelated failures seen by lanes, not caused by them:** a timing test in `server/http/receipts.test.ts` and one in `client/lib/idle.test.ts` failed under load in two lane checks and passed alone.

## Appendix A. Measured

- Draft 1, before, 1440 × 900 at 100%: scenes list, Light and weather open, folded groups, Map image row, New scene, dungeon dialog, DM panel, token bar, 700 × 900 sheet: 0. This device and the dice set: 8 (each tile's name, "center 26 px"). Tab row at 520 px: 1 (the More tab's badge, by design). Initiative in a fight: the sticky round header's 16 px (the sweep's sticky-header rule).
- Draft 1, before, 390 × 844: Scenes, dungeon, DM panel, token bar: 0. Join cards: the header's 17 px (by design). Waiting card: the spinner line 1.1 px left. Dice set: 8.
- Draft 1, before, 320 × 568 and 390 × 844 at 130%: Scenes, dungeon, DM panel, token bar: 0. Dice set: 9 (center 33.8 px, and kind-padding 1.3 px: Ivory, the chosen tile, 3.9 px against 5.2).
- Draft 1, before, rows: Map image at 1440, Replace 158 / Remove 158 / Use the still only 137 on three lines. Token bar at 1440, Roll 69 + Attach 89 + Place freely 125, then Snap to grid 291 alone. Dungeon at 1440, preview 335 × 335 in a 720 px card. Weather rules help, 269 × 200 px, 11 lines, 422 characters.
- Draft 1, after: 0 everywhere it measured, the dice set included, and the waiting card's 1.1 px gone. The only findings left are the by-design ones above.
- Draft 2, after, every root in section 2's matrix at all six sizes, and the dungeon at 794, 806, 1032 at 130% and 1048 at 130%: 0 alignment over 1 px and 0 spacing off, 71 roots.
- Draft 2, Map image lines at 1440 (and 1280): players here, unarmed: Replace 170 + Use the still only 149, then Remove 327. Armed: Choose the image 169 + Paste 150, then Use the still only 327, then Cancel 73, then Remove 327. Players elsewhere: Replace 174 + Paste 145, then Use the still only 327, then Remove 327, unchanged with Remove armed. Busy: Uploading… 161 + Paste 158, then Use the still only 327, then Remove 327. At 1440 at 130% the same lines at 425 screen px. At 390: Replace 189 + Paste 159, then 356 each. At 390 and 320 at 130%: one button a line, 346 and 276.
- Draft 2, Remove's armed words in its own button: "Tap again to remove" one line at every size. "… all 3 phases" and "… all 12 phases" one line at 390 and above, and at 320 at 130% 216 and 219 layout px in 211 (overflowing with `nowrap`, two lines and fitting with `wrap`, the button 57 px high either way, its top unmoved).
- Draft 2, token bar: 1440 and 1280, Roll 134 + Attach 153, then Place freely 143 + Snap to grid 144. 1440 at 130%, Roll 173 + Attach 198, then Place freely 185 + Snap to grid 187. 390, Roll 51 + Attach 71 + Place freely 106 + Snap to grid 108 on one line. 390 at 130%, Place freely 164 + Snap to grid 167. 320 at 130%, Attach, Place freely and Snap to grid 266 each, a line each. Every button's words on one line at every size.
- Draft 2, weather switch help with heavy rain and a strong wind: 3 lines at 1440, 1280 and 390, 4 at 1440 at 130%, 5 at 390 at 130%, 8 at 320 at 130%. Heavy fog's: 2 at 1440, 1280 and 390, 3 at 1440 and 390 at 130%, 4 at 320 at 130%.
- Draft 2, the 68 valid weather, strength, wind and switch cases through `weatherRuleLines` and `weatherPreset`: every sentence names exactly the preset and reminded tests, and every line's quotes are in the SRD text (a throwaway check, the build's weather.test does it for good).

## Round 1 dispositions

| Id | Severity | Finding | Disposition |
|---|---|---|---|
| PD-ASTRA-01 | P2 | The dungeon's two rules conflict near `TWO_COLUMNS_PX` | Adopted. Half the room is the preview's floor, the choices' 360 holds from a body of 736 px (a window of 802 layout px). Tested at 735, 736 and 737 in the unit test and either side in the browser at 100% and 130% (3.4) |
| PD-ASTRA-02 | P2 | The preview contradicts the players' scene behavior | Adopted with PD-OPUS-2: the lines for every state, every button reachable in each, a SceneSettings.test row per state (3.3, 7) |
| PD-ASTRA-03 | P2 | Measurement coverage overstated | Adopted. Section 2 states the matrix, M against C. A new prototype measured the dungeon, the DM panel and This device at 1280 × 720 and 1440 at 130% (appendix A). Draft 1's 1440 at 130% dungeon figure was wrong and is corrected |
| PD-ASTRA-04 | P3 | Keep the wind's "toward" | Adopted with PD-OPUS-4: Direction with the help "Where it blows toward, by the map's edges as Top-down shows them.", the compass keeps "Wind blows toward" (4.2) |
| PD-ASTRA-05 | P3 | Heavy fog's switch says nothing | Adopted with PD-OPUS-3: "Perception checks and attacks here get a reminder." on, the rules-off sentence off (3.2) |
| PD-OPUS-1 | P2 | Arming Remove can reflow onto Use the still only | Adopted. Remove alone on its own filled last line in every state. No button moved when armed with Paste shown at all six sizes. Remove's words wrap inside it where its line is too short (3.3). 04's `-2` shot stays current, since its state did not change, and new shots 18 and 19 show the Paste state and Remove armed |
| PD-OPUS-2 | P2 | The players' scene states are unspecified, and the prototype drops controls | Adopted with PD-ASTRA-02 (3.3) |
| PD-OPUS-3 | P2 | The rolls sentence is wrong for heavy fog, missing for some combinations | Adopted. Fog with a strong wind cannot be (`weatherProblem`), so no sentence for it. The sentence stays a table, checked in weather.test against `weatherPreset` for every valid case (68) (3.2, 7) |
| PD-OPUS-4 | P3 (lowered in confer) | "Direction" drops "toward" | Adopted as PD-ASTRA-04 |
| PD-OPUS-5 | P2 | Held still checks only Low power | Adopted. `animatedHeld: animatedStill !== null`, ThisDevice.tsx joins lane PC1, summaries.test covers Low power, reduced motion and the step-down (3.7) |
| PD-OPUS-6 | P2, P3 in confer | The re-sync names drop what each tick does | Adopted as P3: Kept changes, Unmatched values, Overwritten changes, checked against Changes from D&D Beyond on the same screen (4.2) |
| PD-OPUS-7 | P2 | The placement pair cannot wrap inside itself | Adopted: `flexWrap: "wrap"`, one button a line at 320 at 130%, measured (3.5) |
| PD-OPUS-8 | P3 | Not every word comes from a quote | Adopted. Each line has its own quotes, and the test checks the quotes and the rule terms (3.2, 7) |
| PD-OPUS-9 | P3 | Heavy fog's look is unclear | Adopted: a `Note`, said in 3.2 and section 7. It is Help in the warning tone, the color today's span wears |
| PD-OPUS-10 | P3 | Missed sites and stale comments | Adopted. Trigger's group name, the Icons tab's swatches and every comment have a lane. The From starter packs captions are excluded with their reason (4.1, 4.2, 10) |
| PD-OPUS-11 | P3 | `LETTING_IN` misquoted | Adopted: "The DM is letting you in…" (3.9) |
| PD-OPUS-12 | P3 | Delete this room filed under one word | Adopted: under the action titles (4.1) |
| PD-OPUS-13 | P3 | File counts, `lib/folds.test.ts`, "Player vision" | Adopted. Counts fixed (45 sites, lane sizes), `lib/folds.test.ts` left out as accurate history, and 4.2 says why the owner's "Player vision" became "Player view" |
| PD-OPUS-14 | P3 | The alignment check cannot see a label break inside a button | Adopted: a one-line check per bar button at 320 at 130% (snapoff e2e), measured at all six sizes (3.5) |

## Round 2 notes for the build

Both reviewers said consensus on draft 2. Two P3s, adopted for the build without another round:

- PD-ASTRA-06: section 3.3's stability claim covers Remove's own row only. Paste's busy spinner and a shrinking item can still move the picker's line, so the build claims no more than that and measures nothing further there.
- PD-OPUS-15: `Row`'s `fill` puts each child in a growing grid cell, so a child that renders nothing would leave an empty cell. Lane PA adds a short comment on `fill` saying each child must render something, and guards children at the call site.
