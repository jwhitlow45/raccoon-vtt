# raccoon-vtt: Features, parts of the app hidden on this device

Lane DFEAT, design draft 4 after review rounds 1 to 3 (sections "Round 1 changes" to "Round 3 changes"). Read on main rrnzvkps a6ed9ce2 (OP_VERSION 67, SNAPSHOT_VERSION 50, deployed), with the spell slots design's round 3 (its section 4, D-261127-362) and the starter stock design (its section 11). Decisions D-261127-106 to 133, 300, 301, 302 to 319, 390 to 399 and 420 to 425. The build copies this note to docs/design/design-v1-features.md and lists it in docs/design/README.md.

## The owner's words

2026-11-27: "I also have curiosities about allowing someone to disable parts of the app they don't wish to use on their client to keep things simple (like if they don't want to track spell slots as an example). This would need to be very well organized"

## 1. Summary

- **Features**, a page inside Menu, This device, lists 23 parts of the app in five groups, each with its switch, and offers a search, two presets (Everything and Simple) and Reset all (D-261127-106, 116, 117). Spell slots is the worked example: a player who tracks slots on paper turns it off, and slots leave their character's page, the Uses drawer, the turn card and the rest words on that device only.
- **Hiding is this device's and UI only.** It never changes game state, what anyone else sees, the rules or what the server sends. No op, no format step, no server change (D-261127-127).
- **Three tiers** decide every surface (D-261127-108): openers hide, readouts hide, prompts always arrive. A choice inside an action stays with the action (D-261127-110, 300, 306). Shared map objects stay drawn (D-261127-109). Core parts never hide.
- **One registry** (client/features/modules/registry.ts) and **one guard** (`moduleShown`, `useModule`, `<Module>`, and `activeTool` with choices for tools). An ownership golden, a surface registry whose fixtures feed a controls golden, a gating property and e2e probes fail when an entry point is not gated (D-261127-125, 307, 390).
- **Ways back where the part lived** (D-261127-118, 312 to 314): a quiet "Hidden on this device:" line with Show buttons in eleven homes, Show items in the toolbar's menus or a Hidden tools button, and Search's "Show Spell slots". A Show also turns on what the part needs (D-261127-308).
- **Stored per role, for every room**, in `rvtt.features`. Existing devices start with everything shown, except that a device with Roll animation off starts with Dice animation hidden, which is the same behavior. Roll animation keeps its switch in Rolls (D-261127-301, 310).
- Four lanes: A contract and guards (M), B page and ways back (L), C surface gates (L), D slots gates (S). Section 15.

## 2. What hiding means

| Tier | What it is | Hidden? |
| --- | --- | --- |
| Opener | Anything you press to start, set up or change the part: tools, panels, top bar chips, menu items, setting rows, buttons, keys, search entries | Yes |
| Readout | The part's state shown to you alone: rows, counts, chips, the weather drawing, the isometric look, the dice throw, music | Yes |
| Prompt | Asks for your answer, tells you something happened to a creature you answer for, or is a choice inside an action you are taking | Never, in the form it has today |

**Owners.** Each surface belongs to exactly one module or to core. A core surface never changes, even where it shows another module's data: a condition's "Lasts 1 hour, to 7:00 AM" is Conditions', the roll's "Dis: Heavy rain" is Dice's, the Log's clock lines are the Log's. A choice inside an action belongs to that action: the Long Rest's "Move the clock on 8 hours" and the Short Rest card's Hit Point Dice rows are Rests' (D-261127-300), the import's Classes review line is D&D Beyond's (D-261127-306), the generator's Traps slider and DSTOCK's Monsters rows are the Dungeon generator's (D-261127-110). So a hidden part never quietly changes what an action sends.

**The shared map.** Tokens, traps, pins, areas, drawings, rulers, pings, stairs, walls, doors, lights and labels that the room holds draw on this device as today, and a tap on one with the Select tool does what it does today. Hiding takes away your own ways to make or change them (D-261127-109, 319).

**Others.** Nothing on another device changes. A DM who hides Sound still plays what is playing to the players. A player who hides Spell slots still has slots the DM sees and spends. View as a player and the table display ignore this device's choices (D-261127-126).

**Core, never hidden** (D-261127-107, 319), shown at the page's foot as "Always shown":
- The map and scenes, fog, vision and light, and the walls, doors, lights and labels on the map, with doors opened and closed from the map. Making and editing the build is Map builder's.
- Tokens with HP, AC, conditions, elevation and movement, the Select tool, Add token and Line up grid.
- Dice, roll requests and answers, group saves, Initiative, turns, turn cards, death saves, concentration and rests, whose prompts must reach everyone.
- Characters and Monsters panels, the party bar, Library, Scenes and the DM panel (less its Table display section).
- The Log, chat, whispers and handouts: the Log is where every hidden part still reports.
- Joining, Members, kicking, DM devices and the player link, the X-card with Pause the game and Stop the sound, blackouts and View as a player.
- Search, Undo, Setup history, the Menu, This device and Features, the shortcut sheet, the DM guide and About.

## 3. The modules

DM and Player give the default ("shown" for all) or "no" where the role has no such part. Display: "menu" where the table display's own menu decides it as today, "no" where a display never shows it. Simple: which role's Simple keeps it.

| Group | Module (id) | DM | Player | Display | Needs | Homes (section 6) | Simple keeps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Characters | Spell slots (spellSlots) | shown | shown | no | | uses | neither |
| Characters | Hit Point Dice (hitDice) | shown | shown | no | | rest | neither |
| Characters | Class resources (classResources) | shown | shown | no | | uses | neither |
| Characters | Companions (companions) | shown | shown | no | | companions | neither |
| Characters | D&D Beyond (ddb) | shown | shown | no | | statBlock | neither |
| Tools | Ruler (ruler) | shown | shown | no | | tools | both |
| Tools | Areas (areas) | shown | shown | no | | tools | DM |
| Tools | Draw (draw) | shown | shown | no | | tools | DM |
| Tools | Ping and laser (ping) | shown | shown | no | | tools | both |
| Tools | Map pins (pins) | shown | no | no | | tools | neither |
| Tools | Traps (traps) | shown | no | no | | tools | neither |
| Maps | Map builder (builder) | shown | no | no | | tools, newScene | neither |
| Maps | Dungeon generator (dungeon) | shown | no | no | builder | newScene | neither |
| Maps | Floors (floors) | shown | no | no | | sceneSettings | neither |
| Panels | Sound (sound) | shown | shown | menu | | panels | player |
| Panels | Date and time (time) | shown | shown | menu | | panels | player |
| Panels | Journal (journal) | shown | shown | no | | panels | player |
| Panels | Encounters (encounters) | shown | no | no | | panels | neither |
| Panels | Outliner (outliner) | shown | no | no | | panels | neither |
| Panels | Table display (tableDisplay) | shown | no | no | | dmPanel | neither |
| Visuals | Isometric view (isometric) | shown | shown | menu | | menu | neither |
| Visuals | Weather (weather) | shown | shown | menu | | sceneSettings and thisDevice (DM), thisDevice (player) | player |
| Visuals | Dice animation (diceAnimation) | shown | shown | no | | thisDevice (its Roll animation switch) | both |

A DM sees 23 rows, a player 15. What depends on a module is derived from `needs`, never written twice. A claim may carry a named condition (`when`), such as Floors' `oneFloor` (D-261127-311).

| Module | Help line | Hides (openers and readouts) |
| --- | --- | --- |
| Spell slots | Slots by level and Pact Magic, spent with Use and back on a rest. | DSLOTS 4: SlotRows in every CombatUses form, full and folded, `usesPresence`, `usesCount` and combat/alerts.ts for slots alone, the slot offer under a cast spell's row (slots/SlotOffer.tsx, set by dice/cast/cast.ts in dice/optionState.ts, D-261127-362), slot words in `restBackText` and `partyRestBackText`, search "Spell slots". The Log and Recent rolls lines stay (DSLOTS 4, core) |
| Hit Point Dice | The count of dice left. A Short Rest still rolls them. | The count line in Rest, the dice words in rest lines and the Long Rest note, search "Hit Point Dice". The Short Rest card's dice rows and CON field stay (D-261127-300) |
| Class resources | Counted features such as Rage, Channel Divinity and Lay on Hands. | ResourceRows in CombatUses, Add a class resource and its ResourceSheet, the level-up ask, every count of resources: `resourceCount` (CombatUses.tsx:115), `usesPresence` (combat/logic.ts:663), `usesCount` (logic.ts:469-471), the turn card's admission (combat/alerts.ts:170-177), and their rest words (D-261127-394) |
| Companions | Familiars, summoned creatures and effects that belong to a character. | A character page's Companions group (CharacterCard.tsx:180), a companion token's Companion group (TokenPanel.tsx:274), Make a companion (TokenPanel.tsx:598, CompanionsSection.tsx:565), `character.companions`, `page.companions` |
| D&D Beyond | Import and re-sync characters from D&D Beyond. | Re-sync from D&D Beyond (PcStatBlock.tsx:110), Fill from's D&D Beyond (PcStatsEditor.tsx:490, Paste text stays). A review already open stays whole, its Classes line included (D-261127-306) |
| Ruler | Measure distances and plan a walk. | Tool `ruler`, key R, its options and the Kept rulers chip |
| Areas | Spheres, cones, lines and more, placed or cast. | Tool `area` and its spell presets, key A, panel `areas`, a cast's Place its area (CastBlock.tsx:372) |
| Draw | Freehand, shapes, arrows and text on the map. | Tool `draw`, key D |
| Ping and laser | Ping a spot, point with the laser, and Look here. | Tool `ping`, key P, the Select tool's hold to ping (PingController.ts:46) |
| Map pins | The Pin tool for notes and pages on the map. | Tool `pin`, key M, Pin to the map in a journal page |
| Traps | The Trap tool. Traps already placed still go off and reach you. | Tool `trap`, key X, its options and pane |
| Map builder | Paint floors, walls, doors, heights, lights and stamps, and place stairs between floors. | Tool `build`, key B, New scene's Builder scene, Open the builder, Clear the build, behaviors `linkMove` and `linkResize`, the paste sheet's Stamp row (RoomPaste.tsx:166). A Select tap on a label still opens the DM's edit pane (emptyTap.ts:44, labelEdit.ts:56): a map object's tap is core (D-261127-109) |
| Dungeon generator | Generate a dungeon for a new scene, or add a wing. | "Or start from a generated dungeon", the builder's Wing mode wherever it is picked (D-261127-395), Map: Dungeon in Floors, behaviors `roomEdits`, `wingArea`, `wingJoin`, `dungeonMarks`, DSTOCK 11's rows |
| Floors | Add floors above and below a scene. A scene with floors still shows them. | On a one-floor scene (`oneFloor`): the Floors group's Add a floor above, Add a floor below and Map, `scenes.floors` |
| Sound | Music, background sounds and effects the DM plays. Hidden, this device plays none. (DM: "Players still hear what plays.") | Panel `sound`, top bar `nowPlaying` and `volume`, key U, surface Music, a scene's Scene sound group, This device's Volume, Music, Background and Effects, the Play here ask, playback |
| Date and time | The Time panel, the clock chip and its notes. | Panel `time`, top bar `clock`, the DM menu's Time item, clock toasts, the journal's Add the date |
| Journal | Pages, folders and secrets the DM writes. | Panel `journal` and its New dot |
| Encounters | Build encounters with XP budgets and place them. | Panel `encounters` |
| Outliner | Everything on the scene in one list. | Panel `outliner`, key / |
| Table display | Show the players' view on a TV. | The DM panel's Table display section (`dm.display`), a section and not a panel, grouped with the panels as the DM finds it there |
| Isometric view | Tilt the map and stand creatures up. Hidden, the map stays top-down. | Top bar `view`, Menu's View row, keys I, Q and E, behavior `tapAgain`, the Suggested view row. The device draws Top-down |
| Weather | Rain, snow and fog over the map. Rolls still follow the weather. | The drawing, This device's Weather row, and for the DM a scene's Weather, Strength, Wind and Direction rows (the folded group still names a set weather) |
| Dice animation | Your rolls throw dice that land on the result. | The throw in the Dice panel and from stat blocks, behavior `diceThrowEnd`, the Dice set picker (DiceSetPicker.tsx:59 reads the module, D-261127-396) |

**Skipped client work** (D-261127-124). Skipped: the isometric layers, WeatherController, SoundHost and the ask, useClockToasts, the dice chunk's load and throws, lazy panels, the journal's New dot. Never skipped: useTrapAlerts, the weather rules on rolls (dice/presets.ts), auto Initiative's follow-up `encounter.setValues`, area reminders, fall cards, the camera frames of "Show my view on the table display".

## 4. Prompts that still reach a person

| Hidden on this device | What happens in the game | What this device shows | Test |
| --- | --- | --- | --- |
| Traps (DM) | A trap the generator placed goes off | Toast, its sound, the card with Save and damage and Dismiss, the Passive Perception hint with Mark found, as today | ft-6 |
| Any part (player) | A trap goes off on their creature | The toast "Thorn: The floor gives way!", the stopped move, the Log line, a save request named "Trap" | ft-5 |
| Areas (DM) | A cast's Ask for saves or an area's Save and damage starts a group save | The group save opens in Dice (`shownIn: "dice"`), its rows from the area's caught creatures, Apply as today (D-261127-305) | ft-6, groupSave test |
| Areas (DM) | Areas hides, here or in another window, while an Areas group save is open | The save moves to Dice whole: its page, requests, answers, results and draft, Apply still there (D-261127-393) | ft-8, groupSave test |
| Areas (DM) | A trap's Place the area aims its rig | The Area tool opens for the trap's draft alone and closes back to the trap (D-261127-303) | ft-6 |
| Date and time (DM) | A co-DM's step ends Bless on the clock | The expiry line and notice. The condition row keeps its "Lasts" words | ft-7 |
| Date and time (DM) | The party's Long Rest with a clock running | "Move the clock on 8 hours" shows, ticked | ft-4 |
| Date and time (player) | The clock moves 8 hours | No toast or chip. The Log keeps the line | useClockToasts test |
| Spell slots (player) | The DM's Long Rest restores slots | The Log line. The rest words leave out slots | resources logic.test |
| Hit Point Dice (player) | A Short Rest on a character with classes | The card's dice rows and CON field as today, so dice are spent and counts stay right | ft-4, RestSection test |
| Spell slots and Hit Point Dice (player) | A D&D Beyond re-sync or import | The review shows its Classes line ticked, and its overwrite choices, as with them shown | ft-4 |
| Class resources (player) | Their level rises, or their turn starts | No count ask here. The turn card without the resource rows | UsesSection, TurnCard tests |
| Areas (player) | Spirit Guardians catches their creature | Its save request, the turn reminders, the area on the map | ft-4 |
| Sound (player) | The DM plays music | Nothing plays, no Play here ask. Mute and mix stay stored | ft-2 |
| Sound (DM) | The X-card arrives while music plays | The DM's card with Stop the sound | xcard unit |
| Weather (player) | A Perception check in heavy rain | "Dis: Heavy rain" on the roll's option and reading | ft-4 |
| Ping, Draw, Isometric view (player) | The DM pings, draws, or uses Follow me or Look here | The ping with its sound, the drawing, the view moving in Top-down | ping, iso tests |
| Floors (DM) | A creature falls through an opening | The fall card and toast | ft-6 |
| Journal (player) | A pin or a chat link opens a page | The page opens once, listed while open (D-261127-129) | panels.test |
| Dice animation | A roll lands | The result at once, without dice | throw test |

## 5. The Features page

**Where.** Menu, This device, first row: **Features**, help "Hide the parts you don't use, on this device.", its value ("Everything", "Simple" or "3 hidden") and a chevron. It opens a subpage: ThisDevice publishes `{ title: "Features", parent: "This device", id: "features" }` and MenuPanel publishes null while it shows, as CharactersPanel.tsx:112 does for a form (D-261127-315). search/route.ts learns page `features` under `menu`, with the page's folds. Menu's This device detail gains "the parts you use". A table display has no Features page.

**Phone held upright first** (390 x 844 and 320 x 568, 100% and 130%), in the Menu sheet:
1. Help: "Hide the parts of the app you don't use. Only this device changes. Everyone else, the game and its rules stay as they are." Role line: "For your DM rooms on this device." or "For the rooms you play in on this device."
2. **Start from**: two RadioCards (stacked under 360 px of content). **Everything** "Every part shows." **Simple**, DM "The map, tokens, monsters, fog, dice and turns, with Ruler, Areas, Draw and Ping.", player "Your character's HP, conditions and rolls, turns, Ruler and Ping, and what the DM shares." Neither matched: both unpicked, "Your own choice: 3 parts hidden."
3. **Find a part**: a 16 px search field over names, help and aliases ("hit dice", "slots", "music", "calendar", "3d dice", "iso"). Matching groups open. 'No part matches "xyz".' A core name reads "The X-card always shows."
4. Five groups that fold as This device's sections do (folded on a phone, open from 900 px, remembered in a new lib/folds.ts surface), "All shown" or "2 hidden" folded. Registry order, never by use.
5. Each row: a Switch with name and help, on for shown. A part whose need is hidden reads off and stays enabled, help "Turning it on shows Map builder too." Turning it on turns its needs on (D-261127-308). Turning a need off keeps the dependent's own choice.
6. **Always shown**, a folded group with section 2's core list.
7. **Reset all**, second press "Tap again to show every part, as the DM and as a player", help "Shows every part again on this device, for the DM and for players."

**Other layouts.** The same page in a phone's sideways sheet, a tablet's centered sheet, and a computer's side panel. Rows are 44 px tall at least, help wraps between words.

**Effect.** At once, here and in every window of the app on this device (storage event). An open panel of a hidden part closes to the default tab, or the sheet closes, except that an open Areas group save moves to Dice (D-261127-393). An active tool or builder mode of a hidden part ends as section 8 says. Stored tab rows, split panes, views and keys are left alone (D-261127-130).

## 6. Ways back

A `<HiddenHere home>` at each home lists the parts that are hidden there for this role: "Hidden on this device:" then a quiet button per part, "Show Sound", or "Show Dungeon generator and Map builder" where a need is hidden too (D-261127-308). It renders nothing when none are hidden. On a creature's surface (uses, rest, companions, statBlock) it names a part only where that creature holds it, by the registry's `holds(creature)`: a fighter with no slots never reads "Show Spell slots" (D-261127-391). On a character's own page, Spell slots and Hit Point Dice count as held when the character has classes or this viewer may add them, so a classless character keeps the way back to its Classes line (D-261127-423).

| Home | Where it stands | Parts |
| --- | --- | --- |
| uses | The foot of Uses, in a character's page and its token's Combat group | Spell slots, Class resources |
| rest | The foot of Rest, same places | Hit Point Dice |
| companions | Where the Companions group stood on a character's page, and a companion token's Companion group | Companions |
| statBlock | Beside Edit on a character's stat block, where Re-sync stood | D&D Beyond |
| tools | Below 900 px: the foot of Setup's menu for setup tools and of the sideways tool menu, and a **Hidden tools** button after the play tools for Ruler, Areas, Draw and Ping. From 900 px: one Hidden tools button after the last tool (D-261127-312) | Ruler, Areas, Draw, Ping and laser, Map pins, Traps, Map builder |
| panels | The foot of a phone's Panels list and of More's list. From 900 px More stays while any panel part is hidden, even when every tab fits (tabFit.ts `fitTabs`, D-261127-313) | Sound, Date and time, Journal, Encounters, Outliner |
| menu | The end of the DM menu and the player's You menu | Isometric view |
| sceneSettings | The foot of a scene's settings, above Export | Floors, Weather (DM) |
| newScene | The foot of the New scene form | Map builder, Dungeon generator |
| dmPanel | The foot of the DM panel | Table display |
| thisDevice | The Weather section keeps its heading and holds the line. Rolls keeps the Roll animation switch, bound to Dice animation (D-261127-301) | Weather, Dice animation |

**Hidden tools** is one 44 px button, an eye with a line and the count, named "Hidden tools, 2", labelled "Hidden" on a touch screen. It opens a menu (a popover, a bottom sheet on a phone) of "Show Ruler" items. It shows only while a tool it lists is hidden, so it never adds to a row more than it took away. pages/optionsLayout.ts `toolbarShape` counts it as a button, so the options row's fit stays right.

**Search.** Each hidden part is one result, "Show Spell slots" in "Menu · This device · Features", valued "Hidden", found by name and aliases. Enter presses its switch, which also shows its needs. Shift+Enter only goes there. Its other entries leave the index. DM parts' results live in catalog/dm.ts.

**After a Show** focus goes to the part that came back in the same surface, else the next Show button, else the home's heading, and a polite live region says "Sound shows again."

## 7. Keys and the shortcut sheet

- A hidden part's rows in `SHORTCUTS` and `BEHAVIORS` and its surfaces' sections leave the sheet, and its keys do nothing (`shortcutsFor`, `sheetSections`, `shortcutFor`). Today: R, A, D, P, M, X, B, I, Q, E, U and /, the Music surface, and section 3's behaviors.
- A hidden row keeps its key reserved. The Change dialog names it "Already Ruler, hidden on this device." (D-261127-119).
- While any row is left out, the Keys section ends with the muted line "Keys of parts hidden on this device are left out."
- FEATURES.md's tables keep every default key. The Shortcuts intro gains one sentence, and the Features entry lists keys by part: "Hiding a part takes its keys off the list, and they do nothing: Ruler R, Areas A, Draw D, Ping and laser P, Map pins M, Traps X, Map builder B, Isometric view I, Q and E, Sound U, Outliner /." A unit test checks it against the claims word for word (D-261127-120). shortcuts.e2e.ts:232's Roll animation step follows the switch's new binding.
- No new key or gesture.

## 8. Code shape

**Files** in client/features/modules/: registry.ts (types, `MODULES`, `CORE_PARTS`, `HOMES`, named `when` conditions, derived `dependentsOf`, `simpleFor`), store.ts (the `rvtt.features` setting built with device/settings.ts `setting()`, migration, other windows), gate.ts and Gate.tsx (`hiddenModules`, `moduleShown(id, role, choices = featureChoices())`, `useModule`, `<Module>`, `toolShown`, `useHiddenGuard`, `useHiddenHere`, `<HiddenHere>`), ownership.ts, FeaturesPage.tsx, search.ts. Nothing here imports state/actions.ts, state/socket.ts or the protocol.

```ts
type ModuleDef = {
  id: ModuleId; name: string; help: string | { dm: string; player: string }; group: ModuleGroup;
  roles: Partial<Record<"dm" | "player", { shown: boolean; simple: boolean; homes: readonly Home[] }>>;
  display: "menu" | "no"; needs?: readonly ModuleId[]; names?: readonly string[];
  claims: { kind: ClaimKind; id: string; when?: ConditionName }[]; // panel, tool, shortcut, behavior, surface, topBar, search prefix, deviceSection, builderMode, anchor
};
```

**The guard at each kind of entry point** (D-261127-125):
- Registries: features/panels.ts `panelOffered` (keeping "listed while open"), features/tools.ts `toolsFor`, state/shortcuts.ts `shortcutsFor`, `sheetSections`, `shortcutFor`, features/search/index.ts, pages/topBarFit.ts's parts, the builder's mode list.
- Surfaces: `<Module id>` or `useModule(id)` gates. `<Module>` puts `data-part` on its child when that child is one DOM element, and otherwise wraps its children in a `display: contents` element. A gated component that is not a DOM element spreads `partMark(id)` (`{ "data-part": id }`) on its own root, and check (4) of section 14 catches a miss (D-261127-424). Existing markup asserts that move, such as heldSites.test.ts:252, change in the same lane (D-261127-399). Files in section 15.
- Looks: view/store.ts `shownView` gives Top-down, weather/store.ts gives Off, SoundHost.tsx `soundEnabled` and useSoundAsk, useClockToasts.ts, dice/throw/hooks.ts and useThrows.ts.
- Words: resources/logic.ts `restBackText` and `partyRestBackText` and combat/logic.ts `usesPresence` take the hidden set.
- A source scan fails on any read of `rvtt.features` or the store outside client/features/modules/.

**Active tools, modes and callers** (D-261127-302 to 304):

| Path | Today | With its part hidden |
| --- | --- | --- |
| `activeTool(id, role)` (tools.ts:181), read by Stage.tsx:296 and Room.tsx:452 | role only | `activeTool(id, role, choices, borrow)` gives Select |
| `ui.setTool` (state/store.ts:1463) | any id | refuses a hidden tool unless borrowed |
| An active tool when its part hides, here or from another window | | `useHiddenGuard` in Room only sets Select. Stage's activation effect (Stage.tsx:955-965) then cancels the pointer and runs `deactivate`, as on any tool change |
| Builder mode Wing when Dungeon generator hides (Options.tsx:427, WingPaneHost.tsx:33) | | mode back to the builder's first mode, wing pane, ghost and room edits dropped |
| Picking Wing: `builderCycle` (toolChoices.ts:146-161), `pickBuildMode` (builder/store.ts:121), the mode list (Options.tsx:233) | reach Wing | `now` leaves Wing out, `pick` and `pickBuildMode` refuse it, the list filters it (D-261127-395) |
| An Areas group save open as Areas hides (groupSave/store.ts:17, DicePanel.tsx:88) | `shownIn: "areas"` | the guard sets `shownIn: "dice"` and opens Dice where Areas stood, the store's page, reopen, requests and draft kept (D-261127-393) |
| CastBlock.tsx:372 Place its area | sets `area` | hidden with Areas |
| AreaTool.tsx:416 `aimTrapArea`, AreaOptions.tsx:629 back to Trap | sets `area`, `trap` | a borrow: the Area tool serves the trap's draft alone while Areas is hidden, until Save or Cancel |
| RoomPaste.tsx:166 Stamp row | sets `build` | hidden with Map builder |
| outliner/focus.ts:58-81 area, stamp, light, pin and trap rows | tool and pane | centers the map on the thing, no tool |
| RoomChrome.tsx:185 reopen after a reload | `setTool`, `openPanel` | a hidden id is skipped |
| `openPanel` of a hidden panel | opens | refused, except D-129's links and D-305's group save in Dice |
| castStart.ts:139, groupSave/start.ts:161, DicePanel.tsx:147 | area source opens Areas | `groupSavePanel(source, choices)` gives `dice`, with the caught-creature helper moved from AreasPanel.tsx:71 beside the area store |

A source scan fails when a module-owned tool or panel id reaches `setTool` or `openPanel` outside its module's files, unless this table lists the call.

**Runtime parts** (D-261127-309, 310, 316):
- **Hold to ping**: PingController.ts calls `const pingShown = useModule("ping")` on every render, since it stays mounted across tool changes (line 35), then passes `tool === "select" && pingShown` to `useHoldToPing` (D-261127-392). Its timer (line 129) rechecks the enabled flag before it sends, and turning it off clears a pending timer. Incoming pings still draw and sound.
- **Dice**: useThrows.ts:53-55 reads and subscribes to this role's Dice animation in place of `rollAnimation`. A change calls `ThrowStore.setInputs({ on })`, which ends a throw in flight and lets the renderer go (throw/store.ts:356). Showing again throws the next roll, no reload. The loaded chunk may stay loaded (probe.ts:65). device/summaries.ts:53 and DiceSetPicker.tsx:59 read the module. A source scan fails on `rollAnimation`, `useRollAnimation` or `subscribeRollAnimation` outside the store's migration (D-261127-396).
- **Role before the room answers**: `useModule` takes `you.role`, else the role lib/knownRooms.ts recorded for this room, else Everything. SoundHost, the dice loader, the isometric layers and WeatherController start only once a role is known.

## 9. Persistence and migration

- **Key** `rvtt.features`: `{"v":1,"dm":{"spellSlots":false},"player":{}}`, only changed choices. A part added later takes its registry default (D-261127-114).
- **Scope**: per role, every room, a co-DM as the DM (D-261127-113). Windows follow each other. Private mode keeps a change for the page.
- **Parse**: malformed reads as no choices. Ids match `^[a-z][a-zA-Z0-9]{0,31}$`, at most 64 per role, unknown ids kept for a rollback.
- **Migration**: no key means every default. A device with `rvtt.rollAnimation` "off" and no `rvtt.features` writes `diceAnimation: false` for both roles once. `rvtt.rollAnimation` is kept and never written again, so an older build reads what it read (D-261127-301, 310). `rvtt.weather` stays a look (D-261127-122).
- Room export, backups and import carry nothing of this.

## 10. Privacy, server and versions

Nothing reaches any device that did not before, and the store sends nothing. Module names are not secrets. DM parts' search results stay in the DM catalog. View as a player shows every part (D-261127-126). No OP_VERSION or SNAPSHOT_VERSION step, no server, shared or db change.

## 11. A room-level choice later

A DM switch "off for this room" would be a room setting with an op and a format step, and would take a part from players who did not choose it, such as a caster's slots. Recommendation (D-261127-128): not now. If the owner asks after using this, build it as a room default for players' devices that each player can still change, never a forced off, with the core list out of it. Not designed here.

**Other VTTs**, ideas only (no SRD 5.2.1 rule speaks to the app's surfaces): Foundry VTT's modules are per world and GM switched, D&D Beyond's Preferences are per character, Owlbear Rodeo's extensions per room. Taken: named parts with one line each and a search. Left: the room scope and per character choices.

## 12. UI checklist

- **Loading**: the page reads local storage, so nothing waits. A part shown again whose chunk is lazy loads through the existing indicators.
- **Keys and focus**: Tab runs help, Start from, Find a part, each fold and its switches, Always shown, Reset all. Escape and Back leave the page. Hidden tools takes the arrow keys as every menu does.
- **Screen readers**: switches named by the part, described by their help. Start from is a radio group. Find a part announces "4 parts". HiddenHere is a group "Hidden on this device", buttons "Show Sound".
- **Large sizes**: at 130% on 320 px presets stack, help wraps, switches stay 44 px, HiddenHere buttons wrap whole.
- **Contrast and motion**: theme tokens, HiddenHere's words in `textMuted` and its buttons quiet buttons. Only the existing folds move.
- **Alignment**: every new surface and each home with its line, at 1440 x 900, 390 x 844 and 320 x 568, 100% and 130%. Lane B adds every root, C's included, to e2e/alignmentRoom.ts, run by the six alignment files.
- **Words**: those quoted in sections 3 and 5 to 7.

## 13. Cases

| Case | Expected | Test |
| --- | --- | --- |
| No `rvtt.features` | Every part shows, surfaces as on main | goldens, gate.test |
| Roll animation was off | Dice animation hidden for both roles, the switch in Rolls off, old key kept | store.test |
| Map builder hidden, Dungeon generator's own choice on | Generator hidden. "Show Dungeon generator and Map builder" at New scene and in search turns both on | gate.property, ft-2 |
| Simple, then one switch changed | Both presets unpicked, "Your own choice: N parts hidden." | FeaturesPage test |
| Reset all as a DM | Both roles cleared | store.test, ft-8 |
| Ruler active mid-drag as another window hides it | Drag cancelled, Select | ft-8, gate.test |
| Builder in Wing with a ghost as Dungeon generator hides | Mode back, pane and ghost gone, the builder stays | ft-3 |
| A trap's Place the area with Areas hidden | Area tool for the trap's draft, back to the trap on Save | ft-6 |
| Holding to ping as Ping hides, or R pressed with Ruler hidden | No ping frame sent, nothing happens | ft-3, shortcuts.test |
| A throw in the air as Dice animation hides | Throw ends, renderer released. Shown again, the next roll throws | throw test, ft-3 |
| Phone DM with Traps and Pins hidden | Their Show items at the foot of Setup's menu, no Hidden tools button | ft-1 |
| Computer, every tab fits, Journal hidden | More shows, its list holds "Show Journal" | ft-1 |
| Fog moved to R while Ruler is hidden | "Already Ruler, hidden on this device." | keyBindings test |
| Isometric or Sound hidden while in use | Top-down at once, stored view kept. The playing page yields to another | view store, SoundHost tests |
| Weather hidden by a DM on a rainy scene | No drawing or rows, the line still reads "Dim · Heavy rain", Weather section holds "Show Weather" | WeatherSettings test |
| Both slot parts hidden | Classes line in Uses gone, the import review's Classes line stays | UsesSection, SyncReview tests |
| Outliner trap row with Traps hidden | Centers the map, no tool | outliner test |
| Room opens before `you` arrives, or a reload reopens a hidden tool or panel | knownRooms' role used, no flash. The hidden id is skipped | gate.test, reopen test |
| Ping hidden, then Select and Draw picked in turn | No hook order error, no hold ping with Select | ft-3, PingController test |
| The builder's mode key cycles with Dungeon generator hidden | Wing is skipped and cannot be picked | gate.property (`builderCycle.now`) |
| Areas hidden from another window, a group save waiting on two answers | The save in Dice with its answers so far, Apply when they land | ft-8 |

## 14. Tests

- **Unit**: registry.test (unique ids, homes and help per role, `needs` acyclic, a `<HiddenHere home=` for every home in client source, Simple lists against the preset words), store.test, gate.test, FeaturesPage words, the FEATURES.md keys sentence, the source scans of section 8.
- **Property** (fast-check) gate.property.test.ts: random roles, choices and claim conditions (each `when` drawn both ways): `hiddenModules` closed over `needs` and keeping own choices, the registries holding no entry of a hidden part and every other entry as under Everything, a Show turning on every unmet need.
- **Ownership golden** ownership.golden.json: every registry id with its owner and condition name.
- **Surfaces and controls golden** (D-261127-307, 390): client/features/modules/surfaces.ts lists every surface that holds a gated control, each drawn by parts.markup.test.ts (in the shape of search/anchors.test.ts) in the state that shows it, or named with its e2e probe. Drawn as DM and player, under Everything and with each part hidden: (1) a hidden part leaves no `data-part` of its own and no anchor it claims, (2) every other control and anchor matches Everything, (3) every control (button, input, select, textarea, switch, radio, tab, menu item) is in controls.golden.json under its surface with its owner, the nearest `data-part` or "core", core rows being the explicit exemptions. (4) Each surface's Everything drawing holds a `data-part` of every part it says it covers, so its fixture really opened that state. (5) Discovery does not depend on gates (D-261127-420): surfaces.scan.test.ts scans every client .tsx for control sites (`button`, `input`, `select`, `textarea`, `role="button"`, and every control primitive). The primitive set is computed, never listed by name (D-261127-426): its seeds are the native controls and every interactive role the controls golden counts (button, menuitem, menuitemcheckbox, menuitemradio, option, switch, tab, checkbox, radio, slider, spinbutton, textbox, combobox), written plainly or as a conditional role expression such as Menu.tsx:302's; any component whose own body renders a counted control site is itself a primitive, applied until nothing new is added, so ConfirmButton, OptButton, ChipButton, ValueChip and Row count today and a new wrapper counts the day it is written; surfaces.scan.test.ts fails when the computed set holds a primitive its last run did not. Every file with one is listed in surfaces.ts as a drawn surface (with a fixture for each opened or conditional state that holds a control), a named e2e probe, a runtime entry, or core-exempt with a one-line reason, and each entry records its file's control-site count. A new control site anywhere, a new branch included, changes the count and fails until its entry is placed again. (6) Runtime gates that draw no control (PingController.ts, SoundHost.tsx, useSoundAsk, useClockToasts.ts, useThrows.ts, throw/hooks.ts, view/store.ts, weather/store.ts, and canvas panes such as WingPaneHost.tsx) are runtime entries naming their tests or probes (D-261127-422). Mutations that must fail: an unregistered Menu-only wrapper (D-261127-428), a new control inside ResourceSheet, which opens only after its opener, a removed `<Module>`, an ungated module control added to SettingsPanel.tsx (core-exempt, around line 65), and a control in an uncovered conditional branch of a drawn surface.

| Surface | State drawn (fixture) or probe | Covers |
| --- | --- | --- |
| DM panel | Open, Table display unfolded | tableDisplay |
| Scene settings | Every group open, on a one-floor and a floored scene | floors, weather, sound, isometric, builder |
| New scene | Builder scene picked | builder, dungeon |
| Builder options | Each mode, Wing included | builder, dungeon |
| Time, Sound, Initiative, Log, Members | Open, a fight with a turn card holding full and folded Uses | time, sound, classResources, spellSlots |
| Characters | A page with classes, slots, resources and companions, its stat block row, the Rest section with the Short Rest card open | spellSlots, hitDice, classResources, companions, ddb |
| Token panel | A character's token, a companion token, a monster with Make a companion open | companions, classResources |
| Action bar Uses | The drawer and the strip's folded form | classResources, spellSlots |
| Dialogs and sheets | ResourceSheet, the Classes sheet, the stat block editor (Fill from), the paste dialog with an image (Stamp row) | classResources, spellSlots, hitDice, ddb, builder |
| Dice | A cast block, a slot offer in the options store, with RollOptions.tsx's fallback line too (DSLOTS D-403), an area group save | areas, spellSlots |
| Journal | A page in the editor | time, pins |
| Chip menus | The DM menu and the You menu drawn through `ChipMenuBody` (ChipMenus.tsx:552), exported for the fixture | time, isometric |
| This device | Drawn with its device stores seeded in the fixture, D-261127-390 | weather, sound, diceAnimation |
| Toolbar, top bar, Panels list, More, Hidden tools menu | e2e probes in ft-1 and ft-2 (Room cannot draw to markup), their registries in the property test | tools, panels, menu |

- **e2e** features.e2e.ts `ft-1` to `ft-10`. ft-1 the page and each home at 390 x 844 and 1440 x 900. ft-2 every part's probes (its claimed anchors and `data-part` roots, from the registry) present under Everything, gone once hidden, back after HiddenHere and after search, with a need hidden too. ft-3 keys, active tool, Wing, hold to ping and a throw. ft-4 the op twin (D-261127-318, 398), below. ft-5 to ft-7 section 4's prompts, ft-8 Reset all and two windows, ft-9 the preview, ft-10 search.
- **ft-4**: no op frame while every switch and preset toggles. Then one fixture room (a running clock, heavy rain, Spirit Guardians placed, an armed trap on a path, monsters, a character with classes, a cast area placed) plays one script twice. Run E: every part shown on both devices. Run H: the DM's device hides every part, the player's every part but Areas and D&D Beyond. Sent ops must match after stripping ids, tags, sequence numbers and values from the server's dice.

| Step | Acting device | Hidden there in run H | Path it proves |
| --- | --- | --- | --- |
| a | DM: the party's Long Rest with Move the clock | Date and time, the Characters parts | a choice inside an action (D-110) |
| b | Player: Perception check in heavy rain | Weather | weather rules on rolls |
| c | DM: New fight with Roll monsters' Initiative | Encounters, Dice animation | auto Initiative's follow-up |
| d | DM: Next into Spirit Guardians | Areas | area reminders |
| e | Player: a move across the armed trap. DM: the card's Apply | Tools (player), Traps (DM) | trap prompts |
| f | Player: Short Rest, one d10 rolled (FT-D) | Hit Point Dice | D-300 |
| g | Player: Ask for saves from the cast area. DM: Apply | Areas on the DM only | D-305, D-393 |
| h | Player: D&D Beyond re-sync from pasted JSON (FT-D) | Spell slots, Hit Point Dice | D-306 |

- **Run**: features, search, search-sweep, shortcuts, paneltabs, tools, combatuses, classresources, companions, resync, pcstats, areas, groupsave, traps, dice, blockrolls (312-315), sound, weather, iso, dungeon, dungeonwing, outliner's floors-outliner, reach and the six alignment files.
- **Mutation check per lane**: drop the guard from `panelOffered`, `toolsFor`, `activeTool`, `setTool`, `shortcutFor` and the index, the `needs` closure, the need-showing Show, the borrow's end, the timer recheck, `setInputs({ on })`, the preview override, a `<Module>`, a HiddenHere placement, a claim, the migration, Wing's refusal, the save's move to Dice, the old-key scan, and say which test fails.

## 15. Lanes

| Lane | Files | Size | After |
| --- | --- | --- | --- |
| FT-A | Contract commit (registry with all 23 parts, store, gate, `<Module>`, plain `<HiddenHere>`, `useHiddenGuard`, and `ChipMenuBody` exported from pages/ChipMenus.tsx), then ownership and its golden, the guard in features/panels.ts, features/tools.ts, state/store.ts `setTool`, canvas/Stage.tsx:296, state/shortcuts.ts, search/index.ts, pages/topBarFit.ts, features/toolChoices.ts and builder/store.ts (Wing refused), `useHiddenGuard`'s save move, modules/surfaces.ts with its first list generated once from the scan, every file placed (D-261127-425), surfaces.scan.test.ts, unit and property tests | M | main |
| FT-B | FeaturesPage, modules/search.ts, the catalogs, search/route.ts, device/ThisDevice.tsx, device/settings.ts, device/search.ts, device/summaries.ts, panels/MenuPanel.tsx, pages/Room.tsx (subscription, guard mount, `activeTool` call, Panels list line, Hidden tools button), pages/RoomChrome.tsx, pages/SideTabs.tsx, pages/tabFit.ts, pages/optionsLayout.ts, features/toolbarOrder.ts, pages/ChipMenus.tsx, pages/chipMenus.ts, ShortcutSheet.tsx, features.e2e.ts, shortcuts.e2e.ts, e2e/alignmentRoom.ts, then the docs commit | L | FT-A contract |
| FT-C | Surface gates and homes: resources/ResourceRows.tsx, resources/ResourceSheet.tsx, resources/logic.ts, combat/logic.ts, combat/CombatUses.tsx and combat/alerts.ts (Class resources), combat/UsesSection.tsx, device/DiceSetPicker.tsx and its test, features/heldSites.test.ts, tokens/CompanionsSection.tsx, tokens/CharacterCard.tsx, panels/TokenPanel.tsx, pcstats/PcStatBlock.tsx, pcstats/PcStatsEditor.tsx, pcstats/Resync.tsx, panels/DmPanel.tsx, scenes/NewScene.tsx, scenes/SceneSettings.tsx, scenes/FloorsGroup.tsx, weather/WeatherSettings.tsx, weather/store.ts, view/store.ts, sound/engine/SoundHost.tsx, useSoundAsk, clock/useClockToasts.ts, journal's Add the date and Pin to the map, pings/PingController.ts, dice/throw/hooks.ts, dice/throw/useThrows.ts, dice/cast/CastBlock.tsx, dice/cast/castStart.ts, dice/groupSave/start.ts, dice/DicePanel.tsx, areas/AreasPanel.tsx, areas/AreaTool.tsx, areas/AreaOptions.tsx, images/RoomPaste.tsx, outliner/focus.ts, builder/Options.tsx, builder/WingPaneHost.tsx, entries in modules/surfaces.ts (FT-A's list), parts.markup.test.ts and controls.golden.json | L | FT-A contract |
| FT-D | DSLOTS 4: SlotRows' mount (full and folded), `HitDiceCount`'s mount, SlotOffer gated inside its own root so both its mounts hide, the Dice row and RollOptions.tsx's fallback line (slots/SlotOffer.tsx, dice/optionState.ts, dice/cast/cast.ts, D-261127-397, 421), the slot and dice words and counts in combat/logic.ts, combat/CombatUses.tsx, combat/alerts.ts and resources/logic.ts, the Classes line in combat/UsesSection.tsx, tokens/search.ts, the classes fixtures in parts.markup.test.ts and ft-4's steps f and h. `HitDiceRows`, fill.ts, SyncReview.tsx, shared/logText.ts and dice/RecentRolls.tsx take no gate | S | FT-B and FT-C's shared files, DSLOTS lane B |

Files are disjoint, except that FT-B edits pages/ChipMenus.tsx after FT-A's contract commit exports `ChipMenuBody`, and FT-D stacks on FT-C (combat/logic.ts, CombatUses.tsx, alerts.ts, resources/logic.ts, UsesSection.tsx, parts.markup.test.ts) and on FT-B (features.e2e.ts). FT-D can fold into DSLOTS lane B once FT-A's contract lands. One review for the stack. Commits: A `feat(modules): one registry of parts a device may hide`, `test(modules): the ownership map and gating property`, B `feat(device): the features page and its ways back`, C `feat(modules): every part's surfaces check the registry`, D `feat(slots): spell slots and hit point dice hide on a device`, then `docs: features on this device` with FEATURES.md (a Features entry under This device, the Shortcuts sentence, Search's Show results), the DM guide's "Keeping the app simple" with one picture, this note and its README line.

## 16. Decisions

- **D-261127-106** 23 parts named as the app names them, in five groups. Rejected: FEATURES.md's 34 areas (one area mixes core and optional parts), every control, the panels' groups.
- **D-261127-107** The core list of section 2. Rejected: a hideable Log, Conditions, Fog tool or Initiative.
- **D-261127-108** Opener, readout and prompt tiers, one owner per surface. Rejected: hiding all a part touches, hiding panels and tools only.
- **D-261127-109** The shared map draws as today and keeps the Select tool's taps. Rejected: hiding others' drawings, areas or pings, or the DM's traps.
- **D-261127-110** A choice inside an action belongs to the action. Rejected: hiding it and sending its default unseen.
- **D-261127-111** Traps, Map pins, the builder, the generator and Floors are DM parts. Rejected: a player's Traps or Floors.
- **D-261127-112** Floors hides making floors, and a floored scene shows them. Rejected: hiding the Floor button there.
- **D-261127-113** Per role, every room. Rejected: per room, per member, synced to the server.
- **D-261127-114** Only changed choices stored, unknown ids kept. Rejected: a full list, dropping unknown ids.
- **D-261127-115** Shown means its own choice and every need shown, own choice kept (draft 1's disabled switch replaced by D-261127-308). Rejected: switching the dependent off for good.
- **D-261127-116** Everything and Simple per role, and Reset all for both roles. Rejected: more presets, a Reset that repeats Everything.
- **D-261127-117** A Features subpage, first in This device. Rejected: a Menu item of its own, a This device fold.
- **D-261127-118** Ways back at each home, in the toolbar's menus and in Search. Rejected: Features alone, a jump row, a line at every entry point.
- **D-261127-119** A hidden part's keys do nothing and stay reserved. Rejected: freeing them, a toast.
- **D-261127-120** FEATURES.md keeps its tables and gains a checked keys-by-part sentence. Rejected: a Part column, nothing.
- **D-261127-121** (revised by D-261127-301 and 310) Dice animation is the stored value behind Roll animation. Rejected: two stored values.
- **D-261127-122** Hidden Weather forces Off and hides its rows, the row's own Off staying a look. Rejected: one store for both.
- **D-261127-123** Hidden Sound plays and asks nothing, keeping mute and mix, and the alert sounds and Stop the sound stay. Rejected: writing mute.
- **D-261127-124** Skip only client work that draws or sounds here. Rejected: skipping whole feature folders.
- **D-261127-125** Claims in the registry, an ownership golden, a gating property and e2e probes. Rejected: a `module` field on every registry and catalog entry.
- **D-261127-126** View as a player and the table display ignore this device's choices. Rejected: the DM's player-role choices in the preview.
- **D-261127-127** No format step and no server change. Rejected: choices stored in the room.
- **D-261127-128** No room-level switch now, later only as a default players can change. Rejected: building it now, a forced off.
- **D-261127-129** A link in shared content opens a hidden panel once. Rejected: refusing the link.
- **D-261127-130** Hiding closes an open panel and ends an active tool, keeping stored layouts. Rejected: leaving them on screen, clearing layouts.
- **D-261127-131** "Features", the app's names, "Hit Point Dice". Rejected: "Modules", "Parts", "Hit Dice".
- **D-261127-132** "Hidden on this device:" and "Show Sound". Rejected: a count alone, an icon alone.
- **D-261127-133** Four lanes. Rejected: one lane, surface gates inside FT-A.
- **D-261127-300** (coordinator) Hit Point Dice hides the count and words, and the Short Rest card keeps its dice rows.
- **D-261127-301** (coordinator) Roll animation keeps its switch in Rolls, bound to this role's Dice animation, and `rvtt.rollAnimation` is kept.
- **D-261127-302** One tool gate: `activeTool` with choices, `setTool` refusing, and `useHiddenGuard` ending an active tool or Wing mode. Rejected: filtering the toolbar's list only (Stage still used the hidden tool).
- **D-261127-303** The Trap pane borrows the Area tool for its rig while Areas is hidden. Rejected: hiding the trap's Place the area (a choice inside the trap's setup), Traps needing Areas.
- **D-261127-304** Each outside caller hides its control or is listed, with a source scan. Rejected: trusting callers.
- **D-261127-305** An area's group save shows in Dice while Areas is hidden. Rejected: opening the hidden Areas panel for it.
- **D-261127-306** The import and re-sync review's Classes line and overwrite choices stay whatever the slot parts show. Rejected: following Spell slots and Hit Point Dice (classes written unseen, or left out of the patch).
- **D-261127-307** `<Module>` marks `data-part`, and a markup test with a controls golden covers controls inside panels. Rejected: anchors alone (many controls have none), a text scan.
- **D-261127-308** A Show turns on the part's unmet needs, and a dependent's switch stays enabled. Rejected: a disabled switch, showing only the named part.
- **D-261127-309** Hold to ping is gated at PingController with the timer rechecking. Rejected: gating pings/hold.ts, which only reports.
- **D-261127-310** The throw's runtime inputs follow the module, and `rvtt.rollAnimation` is kept but no longer written. Rejected: gating the loader alone, writing both keys.
- **D-261127-311** Claims carry named conditions, recorded in the golden and drawn both ways by the property. Rejected: fixed id claims (Floors and Weather cannot be said).
- **D-261127-312** Below 900 px setup tools' Show items sit at the foot of Setup's menu, and Hidden tools serves play tools. Rejected: one Hidden tools button for all (the row passes 390 px).
- **D-261127-313** More stays from 900 px while a panel part is hidden. Rejected: a line in the tab row.
- **D-261127-314** Homes are lists per role, with uses, rest, companions and statBlock, and Weather in This device for the DM too. Rejected: one character home (not where Companions and Re-sync lived).
- **D-261127-315** Features publishes its own header, MenuPanel publishes none, and the search route knows the page. Rejected: Menu's header with a Back that skips This device.
- **D-261127-316** Before the room says who you are, knownRooms' role, else Everything, with skipped work waiting. Rejected: the player default (a DM's hidden parts would flash).
- **D-261127-317** Groups Characters, Tools, Maps, Panels and Visuals. Rejected: "Table" (beside Table display), "Looks".
- **D-261127-318** ft-4 runs every inside-action and never-skipped path, server dice masked. Rejected: one Long Rest.
- **D-261127-319** The core list names the map's walls, doors, lights and labels, making them being Map builder's, and Floors needs no builder. Rejected: Floors needing Map builder (Universal VTT files bring floors).
- **D-261127-390** Every surface holding a gated control is registered in modules/surfaces.ts, drawn in the state that shows it (dialogs, subpages, menus, conditional states) or named with its e2e probe, and This device is drawn with its stores seeded. A gated file no surface lists fails. Rejected: panels drawn in their first state only (a control in a closed dialog escaped), This device left to a source scan.
- **D-261127-391** A creature surface's HiddenHere names a part only where that creature holds it. Rejected: the line on every creature (a fighter reading "Show Spell slots").
- **D-261127-392** PingController calls `useModule("ping")` on every render and passes `tool === "select" && pingShown`. Rejected: the hook inside the condition (hook order changes across tools).
- **D-261127-393** An Areas group save open as Areas hides moves to Dice whole. Rejected: closing it (a game-affecting page lost), leaving it in a closed Areas panel.
- **D-261127-394** Class resources' counts hide with them: `resourceCount`, `usesPresence`, `usesCount` and the turn card's admission. Rejected: rows hidden while the counts still open an empty Uses.
- **D-261127-395** Wing is refused in `builderCycle`, `pickBuildMode` and the mode list. Rejected: filtering the list alone (the mode key's second press still reached it).
- **D-261127-396** DiceSetPicker reads the module, and a source scan fails on the old Roll animation reads outside the migration. Rejected: leaving the picker on the old key (it would show while dice are hidden).
- **D-261127-397** The slot offer is gated at SlotOffer's mount (D-261127-362), and the fixtures and ft-4 steps that need DSLOTS's classes move to FT-D. Rejected: gating CastBlock (the offer outlives the block), those tests in FT-C before DSLOTS lands.
- **D-261127-398** ft-4 says per step which device hides what: the player keeps Areas and D&D Beyond, the DM hides every part. Rejected: every part hidden on both (the player's area ask and re-sync could not run).
- **D-261127-399** A gated component marks its own root with `partMark`, with a `display: contents` wrapper only where it has none, and moved markup asserts change in the same lane. Rejected: a wrapper everywhere (it moves existing markup and list structure).
- **D-261127-420** A source scan finds every control-bearing .tsx, each listed as a drawn surface, a probe, a runtime entry or core-exempt with a reason, with its control-site count. Rejected: discovery from gate calls (an ungated surface escaped), exemptions without counts (a control added to an exempt file escaped).
- **D-261127-421** SlotOffer gates inside its own root, so the Dice row and RollOptions.tsx's fallback both hide. Rejected: gating each mount (a third mount would escape).
- **D-261127-422** Runtime gates are surfaces.ts runtime entries with named tests or probes. Rejected: leaving them to check (5)'s control scan, which they would fail or escape.
- **D-261127-423** On a character's own page the slot parts count as held when it has classes or the viewer may add them. Rejected: classes only (a classless character lost its Classes way back).
- **D-261127-424** `<Module>` marks a single DOM child, wraps otherwise, and a gated component spreads `partMark` itself. Rejected: a wrapper always (moves markup), marking left to each author unchecked.
- **D-261127-425** FT-A generates the first surfaces list once from the scan and places every file in that commit. Rejected: each lane listing its own files (a file no lane touches would never be placed).
- **D-261127-426** The controls scan computes its primitive set to a fixed point and fails when a new primitive appears. Rejected: a named list of primitives (it missed ConfirmButton, OptButton, ChipButton, ValueChip and Row).
- **D-261127-428** The scan's seeds include every interactive role the controls golden counts, conditional role expressions included, so Menu and a Menu-only wrapper are primitives. Rejected: seeding native controls and role="button" only (Menu's items escape).
- **D-261127-427** `ChipMenuBody` is exported in FT-A's contract commit. Rejected: landing the chip menus fixture after FT-B (serializes two lanes for one export).

## 17. For the reviewers: look hardest at

1. Section 8's tool and caller table: whether any path still opens a hidden tool or panel, and the Area tool borrow (D-261127-303).
2. The controls golden (D-261127-307): its surfaces, and whether a control in an undrawn surface (toolbar, top bar) is covered by the property.
3. ft-4's fixture and masking (D-261127-318).
4. DSLOTS 4 against D-261127-300, 306 and 397.
5. The surface registry and its scan (D-261127-390, 420): whether control-site counts and core exemptions are strict enough without being noisy.

## Round 1 changes

| Findings | Change | Where |
| --- | --- | --- |
| CL-01, ASTRA-03 (P1) | One tool gate, Wing mode, every outside caller ruled, source scan | 8, D-302 to 304 |
| CL-02 (P1) | An area group save shows in Dice while Areas is hidden | 4, 8, D-305 |
| CL-03 (P1), ASTRA-06 | Short Rest dice rows stay with Rests. The review's Classes line stays | 2 to 4, D-300, 306 |
| CL-04, ASTRA-01 (P1) | `data-part` and a controls golden from drawn surfaces | 14, D-307 |
| ASTRA-02 | Show turns needs on | 5, 6, D-308 |
| ASTRA-04, ASTRA-05, CL-05, CL-10 | Ping gate in PingController, throw runtime, switch kept in Rolls, missing claims | 3, 8, 9, D-301, 309, 310 |
| CL-06 to CL-09, CL-18 | Claim conditions, Setup's menu, More kept, homes where parts lived | 3, 6, D-311 to 314 |
| CL-11, CL-12, CL-19 | ft-4 paths, Features header and route, role before the room answers | 5, 8, 14, D-315, 316, 318 |
| CL-13 to CL-17 | Core wording, Sound help, words and groups, run list, decisions logged | 2, 3, 14, 15, D-317, 319 |

## Round 2 changes

| Findings | Change | Where |
| --- | --- | --- |
| CL-20, ASTRA-01 r2 (P1) | Surface registry with fixtures in their opened states, This device drawn, gated files must be listed, closed-dialog mutation | 14, D-390 |
| ASTRA-07 | `useModule("ping")` called on every render | 8, D-392 |
| ASTRA-08 | An open Areas group save moves to Dice whole | 4, 5, 8, D-393 |
| CL-21 | Class resources' counts hide with them | 3, D-394 |
| CL-22 | Wing refused in the cycle, `pickBuildMode` and the list, toolChoices.ts in FT-A | 8, 15, D-395 |
| CL-23 | DiceSetPicker on the module, old-key scan, heldSites.test.ts in FT-C | 3, 8, 15, D-396 |
| CL-24, CL-30 | SlotOffer gated per D-362, DSLOTS-dependent fixtures in FT-D | 3, 14, 15, D-397 |
| CL-25 | ft-4's per-step table | 14, D-398 |
| CL-26 | The guard sets Select, Stage cancels and deactivates | 8 |
| CL-27 | A Select tap on a label stays core | 3 |
| CL-28 | `toolbarShape` counts Hidden tools | 6, 15 |
| CL-29 | Creature homes name only parts the creature holds | 6, D-391 |
| CL-31 | Table display named as a DM panel section | 3 |
| CL-32 | `partMark` on a component's own root, moved asserts updated | 8, D-399 |

## Round 3 changes

| Findings | Change | Where |
| --- | --- | --- |
| ASTRA-01 r3 (P2) | Discovery by a control-site scan of every .tsx, counts on every entry, the SettingsPanel and branch mutations | 14, 15, D-420, 425 |
| CL-33 | SlotOffer gated in its own root, RollOptions fallback drawn | 14, 15, D-421 |
| CL-34 | Runtime entries in surfaces.ts | 14, D-422 |
| CL-35 | Slot parts held with classes or the right to add them | 6, D-423 |
| CL-36 | `<Module>` marking rule, `ChipMenuBody` exported | 8, 14, 15, D-424 |

## As built

Lane FT-B (the page and its ways back) went its own way in these places. Its decisions are D-261127-480 to 489.

- **Features' header.** The Menu panel holds the page as its own `features` page, which the search's route names, and publishes the header itself, titled Features with This device as its parent and a Back to This device. ThisDevice draws the Features row and takes `onFeatures`. The design had ThisDevice publish the header and the Menu publish none: the same header, from one place (D-261127-480).
- **Start from** stacks its two cards at every width, as This device's other card choices do, since the card component has one column.
- **Find a part** shows only the groups and rows it finds, each group open for the search alone, and the viewer's own folds come back once the field is empty. Always shown leaves while a search runs, and a core name the words name reads "The X-card always shows.".
- **The fold key** is `rvtt.featureFolds`: the store's scan fails on any `rvtt.features` outside the parts folder, and `rvtt.featuresFolds` holds it.
- **This device's Weather** draws `<HiddenHere home="thisDevice">` while Weather hides. The line lists every part of that home, so with Dice animation hidden too it also offers Show Dice animation there, beside the Roll animation switch that is that part's own way back (D-261127-481).
- **This device's Sounds** draws Volume, Music, Background and Effects, and the line above them, only while Sound shows, through `DeviceSound`'s `mixer` prop. Turn sound and Ping sound stay, and the folded section sums up nothing while Sound hides. Weather's folded section reads "Hidden".
- **Roll animation's switch** reads and writes the role's Dice animation through `useDiceAnimationSwitch` in FeaturesPage.tsx, since only the parts folder writes the store. device/settings.ts keeps the old setting's reads until the throw and the dice set picker read Dice animation (lane FT-C), so it stays on the scan's pending list.
- **The tools and menu homes** are menu items, as section 6 gives them: Show items at the foot of Setup's menu, the pair's Tools menu, Hidden tools' menu and More's list, and at the end of the DM menu and the You menu, each from `useHiddenHere`. They hold no Hidden on this device line, so the scan for one stays pending for those two homes (D-261127-482).
- **Hidden tools** is a toolbar button with the eye-off icon, the count as a corner badge and a caret, named "Hidden tools, 2". Its menu, Setup's and Tools' head their Show items with "Hidden on this device".
- **After a Show** a menu's pick leaves focus where the menu returns it, except that a Show in the toolbar's menus focuses the tool that came back. A Hidden on this device line's press is read by `ShowFocus` (features/modules/ShowFocus.tsx), mounted once by Room, since the line itself only shows the part: focus then goes to the part's `data-part` in the same surface, else the line's next Show button, else the home's heading, and one polite live region says "Sound shows again." (D-261127-483).
- **Panel tiles and tool buttons** carry their part's `data-part`, so a Show's focus and the e2e probes find them.
- **The search's Show results** come from the catalogs' `items`, built by features/modules/search.ts as the index is built, so the title names a hidden need. A part both roles have is everyone's, a DM's own part the DM's catalog's. The search gets this device's choices through Room's panel options, which also build its index again on a change (D-261127-484).
- **A reload's reopen** goes through `reopenShown` (pages/RoomChrome.tsx), with the role this device last had in the room. Room's guard then ends the same tool and panel, so the e2e cannot tell the two apart and the unit test holds the rule.
- **The DM menu's Time item and Now playing** follow Date and time and Sound as well as the bar's fit, since the bar's content leaves out a hidden part's chips before the fit.
- **The keys sentence** in FEATURES.md lists the parts in the registry's order, "… Map builder B, Sound U, Outliner /, Isometric view I, Q and E.", which its test makes from the claims.
- **features.e2e.ts** holds ft-1 to ft-4 (ft-4's first half, no op as everything toggles) and ft-8 to ft-10, and probes the toolbar, the side panel's tabs, the top bar and This device. The anchors lane FT-C gates are on its PENDING list, which fails once one is gated. ft-4's two-device twin and the prompts of ft-5 to ft-7 wait on lane FT-C's gates and lane FT-D's steps.

Lane FT-D (spell slots and Hit Point Dice) went its own way in these places. Its decisions are D-261127-500 to 509.

- **The rebase onto spell slots** brought control sites, primitives and search entries the first lists never saw: Hit Point Dice rows, the slot rows and offer, the Classes sheet, the party editor and the map's VTT export. They are placed in surfaces.ts and the ownership golden in a commit of their own before the gates, and the markup fixtures' Bree holds Barbarian 6 and Wizard 3, so her Rage still asks to update and she holds slots and dice (D-261127-500).
- **Search.** Spell slots and Hit Point Dice claim their search fields and their anchors (`field:spell-slots`, `character.slots`, `field:hit-dice`, `character.hit-dice`). Classes is no one part's, so the golden keeps it core and tokens/search.ts leaves it out only while both hide (D-261127-501).
- **The Classes sheet** hides only while both parts hide, so no one part marks it, and the Dialogs row of surfaces.ts covers neither slot part. Its gate, and the Classes and level lines', are drawn apart in parts.markup.test.ts, and ftd-1 checks the sheet stays shut once the parts show again (D-261127-502).
- **The Long Rest note** leaves out "every spell slot back, " with Spell slots, as it leaves out the dice with Hit Point Dice, and Pact Magic slots are Spell slots' in every rest line (D-261127-503, 504).
- **The rest home** stands at the foot of Rest with the uses home's holder: the character with `mayAdd` on its own page, as it is on its token (D-261127-505).
- **A slot offer** sent while Spell slots hides stays in the options' store, so it shows with the part until a Use, Dismiss, another ask or leaving the room. dice/cast/cast.ts and dice/optionState.ts are unchanged (D-261127-506).
- **ft-4's steps f and h** run as twins of their own in features.e2e.ts (ft-4f, ft-4h), each script played with every part shown, then with the player hiding every part but Areas and D&D Beyond, and their ops compared with frame numbers, tags and ids left out. The re-sync's fetch is answered by the test, and its JSON is pasted. Steps a to e and g, and ft-5 to ft-7, are still to build (D-261127-507).
- **The alignment sweep** measures Uses and Rest with both slot parts hidden on a player's page (`slots-hidden-uses`, `slots-hidden-rest`) at every size the slot screens run (D-261127-508).

## Owner's round 4 edit
- CL-37 (P2): the scan computes its primitive set to a fixed point instead of naming primitives (section 15 check (5), D-261127-426).
- CL-38 (P3): `ChipMenuBody` is exported in FT-A's contract commit, so FT-C's chip menus fixture does not wait on FT-B (D-261127-427).
- Round 5 (astra): the scan's seeds include every interactive role the controls golden counts, conditional role expressions included; an unregistered Menu-only wrapper must fail (D-261127-428).
