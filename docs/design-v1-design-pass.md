# raccoon-vtt v1: the design pass

Status: draft 1, for design review. Code is cited from main at `b5078a53`. The build waits until hex phases H2 and H3 deploy, then follows section 5.

The project owner asked on 2026-10-14: "in general we should also do a design review pass of the entire app once done with all waves and try to make the app look consistent and unified/sleek while not sacrificing functionality". On 2026-10-18: "these aren't necessarily hard rules either i just want things that make sense given a design review". On 2026-10-28: "Also please parallelize as much of the future work as possible".

Two look passes already ran: docs/design-v1-look-pass.md ("the first pass", L1 to L18) and docs/design-v1-look-pass-2.md ("the second pass", D1 to D40). Their rules stand, and this note does not redo what they settled. It finds what drifted since, in the screens each lane styled on its own: per-player vision's settings, the keyboard fix, the isometric view and its area shapes, the sheet handle and its held glow, map discovery and the forget question, scene setup and the grouped scene settings page, hex grids (Grid shape, the hex rows, Line up grid on hexes) and View as from a token. It also checks every older screen at today's tip, and the owner's call-outs.

The accent stays the viewer's member color in a room and the crest yellow `#f7df00` outside one. The old orange never returns as an interface color. No art is generated. Anything slow shows that it is loading. No feature is removed.

Screenshots: `screenshots/design-pass/audit/`, kept outside the repository, taken on main from the production build. Two sources:

- `sweep/`: one room built for this pass ("Design pass"): Thorn played by Pat, Wolf his companion, a goblin and a long-named goblin boss. Every panel, the Menu's pages, the token window, the token panel, the character page, the View menu, View as and the shortcut sheet, for the DM and for Pat, at five sizes. Names end in the size: `p390` is 390 x 844 on touch, `p390-130` the same at 130%, `p320` 320 x 568, `t820` an 820 x 1180 tablet, `d1440` 1440 x 900 with a mouse.
- `e2e/<file>/`: the shots of eight e2e files run on main with screenshots on (alignment-icons, pervision, hex, iso, mapdiscovery, scenesetup, layout, and the two alignment files), which reach the new screens' states: a hex scene's settings, the forget question, the builder's note, Players see and its questions, the copy sheet, the View menu in both views, the preview's loading line, the long View as list. Their names give their sizes.

## 1. Audit

Severity: **P1** looks broken. **P2** is inconsistent with the rest of the app. **P3** is polish.

Counted: no P1, 7 P2, 6 P3. By kind: sheets and panes 3, type 1, buttons and controls 3, color and contrast 1, empty and loading states 2, words on controls 1, spacing 2, icons 0, focus and touch targets 0. Nothing looks broken. Every alignment sweep passes on main: alignment 11 of 11, alignment-wide 10 of 10, alignment-icons 23 of 23, and the feature files' own measures. The drift is where a new screen picked its own pattern for something the kit already had: the scene settings page above all, since four lanes built parts of it.

### 1.1 Sheets and panes

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP1 | The scene settings page folds its four groups (What players see, Map image and grid, Walls and movement, Scene) as 13 px capitals `Section` folds, with no icon and nothing said while folded. Every other page that groups its parts by use folds them as `Group` rows: 48 px, the group's icon, its name at 16 px weight 700, and a summary at the right while folded. On a phone three of the four start folded, so the DM reads three bare capitals lines | the character page and the token panel (Stat block, Combat), the Dice panel's Recent rolls, the trap pane | `sweep/dm-panel-scenes-scrolled-p390`, `sweep/dm-character-page-p390`, `e2e/alignment-icons/142-alignment-ms2-390x844-scene-settings-folded` | features/scenes/SceneSettings.tsx:92, :98, :117, features/vision/VisionSettings.tsx:118, against components/Panel.tsx:224 (`Group`) and panels/TokenPanel.tsx | P2 |
| DP2 | Inside What players see, "Fog and party vision" is a hand-made disclosure: a 16 px weight 600 row with its chevron at the end. Every other fold puts its chevron first (the first pass's 2.6 and L9), and the end chevron is a list row's. It also reads larger than the 13 px capitals header of the group it sits in | Map image and grid's header right under it | `sweep/dm-panel-scenes-scrolled-p390`, `e2e/scenesetup/005-ss-1-custom` | VisionSettings.tsx:167-176, its local `Fold` at :225 | P2 |
| DP3 | The scene on screen's settings start with no label. "Scene name" follows New scene's buttons and its Universal VTT help under one line, so on a phone it reads as the new scene's name. The panel's own comment says each part is "under its own label" | All scenes and New scene above it, each under a label | `sweep/dm-panel-scenes-p390`, `sweep/dm-panel-scenes-t820`, `e2e/alignment-icons/141-alignment-ms2-390x844-scene-settings` | SceneSettings.tsx:86-88, panels/ScenesPanel.tsx:29-34 | P2 |

### 1.2 Type

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP4 | The token panel's header puts "View as Pat", a 44 px button, between the kind line and the quick numbers, inside the name's column. The creature header (first pass 2.11) reads picture, name, kind line, tags, quick numbers, and the character page puts its action, Place a token, in a row of its own under the header. So the numbers move down a line on any token a player owns, and the header's action starts at the name's edge instead of the panel's | Thorn's page with Place a token under its header | `sweep/dm-token-panel-thorn-d1440`, `sweep/dm-token-panel-wolf-d1440`, `e2e/pervision/020-viewas-panel-390x844-100`, `sweep/dm-character-page-t820` | panels/TokenPanel.tsx:362-367 (`afterTags`), features/dm/viewAs.tsx:94-231, against tokens/CharacterCard.tsx:280-296 | P2 |

DP4 is listed under type because what drifts is the header's reading order. The owner's call for View as "somewhere easily accessible in the token sidebar" and D-261027-09 ("the token panel's header ... one tap without opening a fold") stand: the fix keeps it above every fold (3.4).

### 1.3 Buttons and controls

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP5 | Grid shape ("Squares", "Hex rows", "Hex columns") is a `Segmented` without `even`, so at 130% and at 320 px it goes two over one, in a scene's settings and in the new scene form. New scene's kinds (Battle mat, Map image, Builder) go two over one at 130% the same way. The second pass's 2.7 made a choice of a few short words share one row, with `even`, after Who did this (D9) | the trap pane's Who, the Interface size row | `e2e/alignment-icons/172-alignment-hx4-390x844-130-scene-settings-hex`, `e2e/hex/067-hx4-new-scene-320x568-130`, `sweep/dm-panel-scenes-p390-130` | features/grid/ShapeRow.tsx:35, features/scenes/NewScene.tsx:310 | P2 |
| DP6 | Room settings' "Grid on new scenes" offers the same three shapes as radio cards, one per row, where the scene's own Grid shape and the new scene form offer them as the Segmented above. One choice, two looks | Grid shape in the scene's Map image and grid | `e2e/hex/050-hx4-room-settings-390x844-100`, `e2e/hex/065-hx4-room-settings-320x568-130` | panels/SettingsPanel.tsx:116-125, features/settings/form.ts:195-200 | P3 |
| DP7 | Players see draws its own copy of the radio cards: `PlayersSeeChoice` repeats `RadioGroup`'s card, radio and words line for line, plus its status line. The look matches today, so this is drift in code: the next change to the cards lands in one place and not the other | Room settings, This device's Map detail and a handout's Show to, which use `RadioGroup` | `e2e/scenesetup/004-ss-1-leave-explore-asks`, `sweep/dm-menu-room-settings-p390` | features/vision/PlayersSee.tsx:27-120, against features/dm/controls.tsx:29-91 | P3 |

### 1.4 Color and contrast

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP8 | The options line's `status` tone is the success green, and two new tools put waits and failures in it: the builder's "Checking players' remembered map…", Line up grid's "Looking for a grid…", "No grid found. Drag a box over 3 by 3 squares instead." and "The scene changed, so the grid found was not applied.". Green then says both "done" and "failed". The Ruler's "Finding the way…" is muted, as the second pass set (D29) | "Grid saved at 50 px per square." in the same green, rightly | `e2e/mapdiscovery/013-mapdiscovery-dm-build-asking` | features/builder/Options.tsx:303, features/grid/Options.tsx:80, :91, :93, measure/controls.tsx:777-781 (`LINE_COLORS`) | P2 |

### 1.5 Empty and loading states

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP9 | View as a player's failure is a plain muted status, "Could not load what Ana sees. Close and try again.", with no Try again, where a second try can succeed (it opens the preview's socket again). Its wait draws `Loading`'s spinner and words by hand. The first pass's 2.9 gave every failed load one look, `LoadFailed` | the Library's and the icon list's failures | `e2e/pervision/008-pervision-preview-ben-loading` (the failure was read from code and `e2e/alignmentRoom.ts:1050`) | features/dm/PreviewWait.tsx:14-44 | P2 |
| DP10 | Waits drawn by hand at three spinner sizes beside `Loading`'s 18: the builder's asking line at 14, Players see's and Sight's working lines at 16, the preview's at 18 | `Loading` everywhere else | `e2e/mapdiscovery/013-mapdiscovery-dm-build-asking`, `e2e/scenesetup/011-ss-4-light-changed-asking` | builder/Options.tsx:310-315, vision/PlayersSee.tsx:112-117, vision/VisionSettings.tsx:301-306, PreviewWait.tsx:38-41 | P3 |

### 1.6 Words on controls

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP11 | "Building area shapes" is the one wait line without the ellipsis. Every other `Loading` ends in "…" ("Loading the scene…", "Working out the walls…") | the isometric view's other notices | `e2e/iso/043-isoa-dm-building-area-shapes` | canvas/relief/IsoBoard.tsx:631 | P3 |

### 1.7 Spacing

| # | Finding | Next to | Screenshots | Code | Sev |
|---|---|---|---|---|---|
| DP12 | A floating notice's width, 520 px, is written in eight places: two named constants and six literals. No token holds it, so a ninth notice (H2's or H3's) will copy one of them | `theme.layout.dialog.md`, `options.field` and the other widths in the theme | `sweep/dm-view-as-pat-d1440` | pages/Room.tsx:139, :1636, :1978, pages/RoomChrome.tsx:210, pages/QuietLoadNotice.tsx:26, features/dm/PlayerPreview.tsx:202, features/scenes/FrameView.tsx:63, features/display/DisplayRoom.tsx:1107 | P3 |
| DP13 | The map image's question on the players' scene: its sentence ("The players are on this scene. They see the new image as soon as it uploads.") comes after its buttons, and on a phone Cancel wraps to a line of its own between them. A question reads before its answers everywhere else (the forget question, Leave Explore's box) | Leave Explore's box in What players see | `e2e/alignment-icons/143-alignment-ms2-390x844-map-image-ask`, `e2e/scenesetup/004-ss-1-leave-explore-asks` | SceneSettings.tsx:605-630 | P3 |

### 1.8 Checked

- **Consistent.** The View menu in both views (the options kit's rows, a check on the chosen one), the top bar's view button lit in isometric, Turn left and Turn right, the suggested view, the isometric notices ("The map builder works top-down…", "Turning needs the isometric view."). The sheet handle, a dropdown with its preview, as the owner asked ("Implement all of these as ui options in a dropdown in device settings with ringed tail as default"), lit in the player's color while held. Sight's Whole party and Per player, Who sees for themselves (a pick of several, so checkboxes, second pass 2.7), Who lends sight. The forget question as a sheet and a dialog. The builder's note on the players' scene as a warning line. The copy sheet. Hex rows on the board, the hex outline, the ruler, the Line up box, Find the grid's reason, "Counted on squares only.". View as from the bar, the long owners list, the preview's frame and its banner (a highlight `Notice`). The stop note's Teleport here.
- **The passes hold.** The character page and its groups, the stat block under the header, the kind line, "Companion of Thorn" as a link and the portrait badge (L1 to L5, the call-outs, section 3), the window's units (L6), the 560 px tablet sheet (L7), the panels' openers, the trap pane, the Attach list, Ride's two words, the alerts' header (D1 to D38). Shots: `sweep/*-t820`, `sweep/dm-token-panel-wolf-d1440`, `sweep/pat-panel-characters-p390`.
- **Left as it is.** The upright phone's resting strip says "AC 14 · HP 30/30" in words where the expanded window draws the shield: decided by docs/design-v1-bar-compact.md 3.3, whose words are measured to fit at 320 px and 130%. The Monsters panel's New monster beside Paste a stat block, which the first pass found consistent. The custom effect colors in EffectsSection.tsx, older than both passes.
- **Focus and touch targets.** Every new control is 44 px or wider (`theme.touch`), each new question and sheet returns focus to its opener, and every `outline: "none"` in the client is on a `tabIndex={-1}` target that takes focus from code. No drift.
- **The drift scan** (`scripts/style-drift.ts`): 0 drift test findings, 90% of font sizes and 91% of spacing from tokens (90% and 92% at the second pass). The spacing point is the new screens' raw widths, which DP12 and the lanes' own files take back.
- **Read from code, not seen**: the preview's failure (DP9), the grid finder's failure lines (DP8), View as on a phone's expanded window (the sweep's compact window shows none, as designed).
- **Not audited**: hex H2 (wall lines, difficult ground and traps on hexes) and H3, building now. Lane 4 checks their screens first (5.1).

## 2. The visual system as it stands

### 2.1 Tokens

`client/lib/theme.ts` defines, unchanged in kind since the visual design:

- **Color**: surfaces (`bg`, `surface`, `surfaceRaised`, `stage`), text (`text`, `textMuted`, `textDisabled`), status (`danger`, `dangerText`, `warning`, `success`), dispositions, the accent and its tints, which follow the viewer's member color in a room.
- **Type**: `font.tiny` 11, `small` 13, `body14` 14, `input` 16, `heading` 18, `title` 20, `display` 24. Weights 400, 600, 700. Leading 1.2 and 1.4. Capitals tracking `caps`.
- **Space** `space(n)` on the 4 px grid. **Radii** `xs` 3, `sm` 6, `md` 10, `lg` 16, `pill`. **Lines** 1, 2, 3. **Icons** 16, 20, 24. **Shadows** `rim`, `float`, `pane`, `sheet`, `dialog`. **Layers** `z.*`. **Touch** 44.
- **Layout**: `wideMinWidth` 900, the side panel 360, the landscape sheet 340, the top bar 52, the toolbar 60, dialogs 440, 560 and 720, popover gaps, the options row's sizes.
- **New since the second pass**: `relief` (the isometric view's sides, walls and standees) and `area` (an area's solid in isometric). Both are board paint, read only by the canvas.

### 2.2 Shared components

`components/`: `Button`, `IconButton`, `Chip`, `Tag`, `Row`, `Field` and `FieldRow`, `Segmented`, `Switch`, `Checkbox`, `Select`, `Section` and `Group` (Panel.tsx), `Sheet`, `SheetHeader`, `Dialog`, `Popover`, `Menu`, `Notice`, `Empty`, `Loading`, `LoadFailed`, `Swatches`. In the options kit (features/measure/controls.tsx): `OptButton`, `OptSegmented`, `ChoiceRows`, `OptionsStrip` and its line tones. New since the second pass: `CountPips`, `grabberDesigns` and `SheetGrabber`'s glow, `menuTiles`, and a `Section` fold's `keep`, which leaves folded content mounted and hidden.

The radio cards, one option a row with its help inside, are `RadioGroup` in features/dm/controls.tsx: a shared look kept in a feature's file, which is why Players see copied it (DP7).

### 2.3 What bypasses it

- **Colors**: none in the new screens. The 106 raw hex values outside the theme are board paint (token rings, dice sets, builder textures and stamps) and the custom effect colors, all older than the second pass.
- **Sizes**: the notice width 520 (DP12). Spinner sizes 14, 16 and 18 (DP10). The radio's 20 px circle, written in `RadioGroup` and its copy (DP7). The rest of the raw numbers in the changed files are drawing sizes on the board and the grabber designs, which are pictures.
- **Patterns**: a local `Fold` in VisionSettings.tsx (DP2) and `PlayersSeeChoice` (DP7).

### 2.4 The rules the fixes rest on

1. **A page's groups are `Group` rows.** A page or a panel that gathers its parts by use folds them as `Group`s, with an icon, a summary while folded, and folds the device remembers. Inside a group, a part that folds is a `Section` with `fold`, chevron first. A row with its chevron at the end unfolds a list item only (first pass 2.6). The scene settings page takes this (DP1, DP2).
2. **Everything a panel shows sits under a label or a header.** A run of sections never starts a new subject without one (first pass 2.7, DP3).
3. **A creature's header is its identity, and its actions take a row under it**: picture, name, kind line, tags, quick numbers, then one actions row (Place a token, View as Pat), before the first group. Ride's question stays in the header, as the second pass placed it (D5), since it says how the creature moves, not what the DM can open (DP4).
4. **One choice, one look.** A few short words share one row as a `Segmented` with `even`. Longer options with help take the radio cards, which live in `components/` (second pass 2.7, DP5 to DP7).
5. **The options line's tones.** `hint` (muted) for an instruction and for a wait, with the spinner. `warning` for a refusal or a failure. `status` (green) only for a result that worked. `reading` for a measure (DP8).
6. **Waits and failures.** Every wait is `Loading`, with its `small` form inside a help line or an options line. Every failed load that can be tried again is `LoadFailed` with Try again (first pass 2.9, DP9, DP10). Its words end in "…" (DP11).
7. **Sizes come from the theme.** A width used in more than one place is a token (DP12).

## 3. The owner's call-outs, checked against today's app

### 3.1 "for me at least companion and character stat blocks are not differentiated the greatest right now at a glance"

Solved by the first pass (3.3), and it holds. Wolf's panel reads "Companion of Thorn · Medium (5 ft)" under its name, the first part a link to Thorn's page, and Wolf's picture carries Thorn's portrait at its corner. Thorn's reads "Character · Medium (5 ft)", or "Level 5 character" with a level. The Stat block row names its source when folded. Shots: `sweep/dm-token-panel-wolf-d1440`, `sweep/dm-token-panel-thorn-d1440`. No new fix. DP4 moves View as out of the line under the kind line, which leaves "Companion of Thorn" and the numbers in their places.

### 3.2 "the details for a character could use a similar pass the monster details had (maybe even using the same component?) ... having collapsible sections would be a big help"

Solved by the first pass (3.1), and it holds: a character's details open as a page of the token panel's groups under the creature header, folds remembered per device. Shots: `sweep/dm-character-page-p390`, `sweep/pat-panel-characters-p390`. No new fix. The scene settings page is the one page with groups that did not follow (DP1), and it now will.

### 3.3 "the player stat block should be higher or even near the top. just looking for consistency here"

Solved by the first pass (3.2), and it holds: the Stat block group sits right under the header, on the character page and in the token panel, for the DM and the player. No new fix.

### 3.4 The turn buttons, the accent, and the player's color

- "Your turn" and "End turn" were fixed on 2026-10-14 and still use the kit's buttons.
- The accent is the crest yellow outside a room and for the DM, and Pat's green for Pat: his chosen tool, his Panels button and his sheet handle's glow (`sweep/pat-room-p390`). The orange appears nowhere in the interface.

### 3.5 "consistent and unified/sleek while not sacrificing functionality"

Sections 4 and 5. Every fix keeps every control and every way to reach it. Two fixes move a control: View as moves a few pixels into the header's actions row (DP4), and the scene settings groups gain icons and summaries (DP1).

## 4. The fixes

### 4.1 The scene settings page (DP1, DP2, DP3, DP13)

- **The groups become `Group`s**, in the order and with the names they have: What players see (`shown`), Map image and grid (`image`), Walls and movement (`walls`), Scene (`scenes`), the icons from the existing set. Their folds keep today's store (`rvtt.sceneSettingsFolds`) and defaults: What players see open everywhere, the rest open from 900 px of layout. The page folds with `keep` today (SceneSettings.tsx:65), so a folded group's fields and questions stay mounted, and `Group` gains the same `keep`, drawn as `Section`'s (Panel.tsx:88-93, :118). Export as image and Delete stay `Section`s with their capitals labels, as a page's last parts that never fold.
- **Folded summaries**, from one pure function, `sceneGroupSummary(scene, group, roomSettings)` in `features/scenes/sceneSummary.ts`:

| Group | Summary while folded |
|---|---|
| What players see | the preset's name and the light: "Explore · Dark", "Reveal by hand · Bright", "Custom · Dim", with "· Per player" when Sight is per player |
| Map image and grid | "No map image" or "Map image", then the grid: "Squares", "Hex rows, 50 px" |
| Walls and movement | "Walls block moves" or "Walls do not block moves" |
| Scene | its size: "20 × 14 squares" or "40 × 30 hexes", then "Isometric" when that is the suggested view |

- **Fog and party vision** becomes a `Section` with `fold` inside What players see: a 13 px capitals label, chevron first, its summary "Fog on · Party vision on" while folded. Its behavior stays: closed on each scene unless Custom opens it, not remembered, and Leave Explore's question goes with it as today. The local `Fold` goes.
- **The scene's settings open under a label**, "This scene", on the section that holds Scene name. It is the label the section had before the map discovery design dropped it, and the panel's comment says the same.
- **The map image's question** reads first: the Note, then the Checkbox where the first map asks about fog, then the buttons, Cancel last on their row.
- No words change but the label and the summaries. Every group keeps its heading's name, so `sceneGroupFold` finds it. `sceneGroup` in e2e/harness.ts finds a group by its `section` ancestor, and a `Group` is no `section`, so it reads `[data-panel-group]` instead.

### 4.2 Choices (DP5, DP6, DP7)

- **`RadioCards`** in `components/RadioCards.tsx`: `RadioGroup` moved out of features/dm/controls.tsx with its look and props, plus Players see's three extras as options: `like` (a fourth card), `busy` (a tap does nothing while a change is on its way) and `status` (the polite line under the cards: Custom, or the work in hand). `PlayersSeeChoice` becomes a thin wrapper that builds its options and passes these. Room settings, This device's Map detail and a handout's Show to take the new import. No look changes.
- **Grid shape and New scene's kinds take `even`**, so their options share one row and their words wrap inside each option at 320 px and 130%, as Who does.
- **Room settings' Grid on new scenes** draws `ShapeRow`'s Segmented (its choice alone, without a scene's refusal and reprojection), with the setting's help as its `description`, so one choice has one look. The setting, its default, its field in features/settings/form.ts and its words stay.

### 4.3 The creature header (DP4)

`CreatureHeader` gains an `actions` slot, a row under the quick numbers, left aligned to the panel's edge, wrapping on narrow widths. The token panel puts View as there (`ViewAsButton`, the same one, "View as Pat" or "View as a player" with its list). The character page's Place a token and Place my token move into the same slot, so both pages draw one row in one place. SteerControl stays in `afterTags`. A token no player owns draws no row.

### 4.4 Waits, tones and notices (DP8 to DP12)

- **`Loading` gains `small`**: 13 px words, a 16 px spinner, the same delay and status. The builder's asking line, Players see's and Sight's working lines take it, with `delay={0}` where the caller already waits the shared 200 ms, and `live={false}` where the line sits in a live region already, as the options line does.
- **The preview's wait and failure**: `PreviewWait` draws `Loading` for "Loading what Ana sees…", and `LoadFailed` for "Could not load what Ana sees." with Try again. Try again runs the preview's open effect again (PlayerPreview.tsx:108-128, an attempt count in its dependencies), which makes a fresh store and socket, and focus moves to the loading line's status as it shows. Exit stays in the banner. The failure becomes an alert, as every `LoadFailed` is.
- **The options line's tones** (2.4 rule 5): the builder's asking line and "Looking for a grid…" take `hint` with the `small` spinner. "No grid found. Drag a box over 3 by 3 squares instead." and "The scene changed, so the grid found was not applied." take `warning`. "Found a grid of …" and "Grid saved at …" keep `status`.
- **"Building area shapes…"** with the ellipsis.
- **`theme.layout.notice: 520`**, and the eight places read it. Nothing moves.

## 5. Lane plan

Four lanes, each one builder in its own workspace, all starting from the stacked tip after hex H3 deploys, after one small prerequisite commit (lane 0). No lane changes a protocol, an op, stored data or a snapshot. The lanes own disjoint files. Three e2e files are shared by line range, never by the same hunk: `e2e/harness.ts` (lane 1 owns 592-618), `e2e/alignmentRoom.ts` (lane 3 owns 1035-1060) and `e2e/pervision.e2e.ts` (lane 3 owns its preview loading and failure steps near 319, lane 4 its `viewas-panel` steps). Lane 4's first step is the H2 and H3 check (5.1), so it may hand a finding to another lane before that lane's docs commit.

| Lane | Fixes | Commits, in order | Files it owns |
|---|---|---|---|
| 0. Prerequisite | `Loading`'s `small` | `feat(ui): a small loading line for a wait inside help or an options line` | components/Loading.tsx and its new components/Loading.test.ts. Built by lane 3's builder and merged before lanes 1 to 4 start, since lanes 1, 2 and 3 use it |
| 1. Scene settings | DP1, DP2, DP3, DP13, and Sight's working line (DP10) | `feat(ui): a group can keep its content mounted while folded`, `feat(scenes): the settings groups fold as the panel kit's groups, with icons and summaries`, `fix(vision): fog and party vision folds as a section, chevron first`, `fix(scenes): the scene on screen's settings start under this scene`, `fix(scenes): the map image's question reads before its buttons`, `docs: the design pass, scene settings` | components/Panel.tsx (`Group`'s `keep`) and its case in components/Panel.test.ts, features/scenes/SceneSettings.tsx, features/scenes/sceneSummary.ts (new) and its test, features/vision/VisionSettings.tsx, e2e/harness.ts:592-618, e2e/scenesetup.e2e.ts |
| 2. Choices | DP5, DP6, DP7, and Players see's working line (DP10) | `refactor(ui): the radio cards are a shared component`, `fix(grid): grid shape and new scene kinds share one row`, `fix(settings): grid on new scenes draws the scene's own grid choice`, `docs: the design pass, choices` | components/RadioCards.tsx (new) and its cases in components/controls.test.ts, features/dm/controls.tsx, features/vision/PlayersSee.tsx, features/grid/ShapeRow.tsx, features/scenes/NewScene.tsx, panels/SettingsPanel.tsx, features/device/ThisDevice.tsx, features/handouts/HandoutsSection.tsx |
| 3. Waits and notices | lane 0, DP8, DP9, DP11, DP12, the builder's asking line (DP10) | lane 0's commit, `fix(dm): view as a player's failure offers try again`, `fix(ui): the options line says waits in the hint tone and failures as warnings`, `fix(iso): building area shapes ends in an ellipsis`, `refactor(ui): one token for a floating notice's width`, `docs: the design pass, waits and notices` | components/Loading.tsx and its test, features/dm/PreviewWait.tsx, features/dm/PlayerPreview.tsx, features/builder/Options.tsx, features/grid/Options.tsx, canvas/relief/IsoBoard.tsx, canvas/relief/volumes.test.ts, lib/theme.ts, pages/Room.tsx, pages/RoomChrome.tsx, pages/QuietLoadNotice.tsx, features/scenes/FrameView.tsx, features/display/DisplayRoom.tsx, e2e/alignmentRoom.ts:1035-1060, e2e/iso.e2e.ts, its steps of e2e/pervision.e2e.ts |
| 4. Creature header, and H2 and H3 | DP4, then 5.1 | `fix(tokens): a creature header's actions take a row under it`, the H2 and H3 fixes 5.1 finds in its files, `docs: the design pass, the creature header` | features/tokens/CreatureHeader.tsx, panels/TokenPanel.tsx, features/tokens/CharacterCard.tsx, features/dm/viewAs.tsx, e2e/tokenpanel.e2e.ts, its steps of e2e/pervision.e2e.ts, and the files 5.1 names that no other lane owns |

Docs: each lane's last commit edits its own lines of FEATURES.md and docs/dm-guide.md, never mixed into a code commit. Lane 1: FEATURES.md 81, dm-guide.md 171 to 182 and 424. Lane 2: FEATURES.md 87, dm-guide.md 266 and 268. Lane 3: FEATURES.md 107, dm-guide.md 961 and 1308. Lane 4: FEATURES.md 438, dm-guide.md 1310. The hunks never meet.

Guide pictures to retake once the lanes merge: the scene settings pictures at dm-guide.md 180 and 182 (lane 1), the What players see picture at 441 (lanes 1 and 2, retaken once by lane 1 after lane 2 merges), and any picture of a token panel's header with View as (lane 4).

### 5.1 Hex H2 and H3

H2 adds wall lines, difficult ground and traps on hexes. H3 is in design. Their lanes style their own screens now. Lane 4 starts by running hex H2's and H3's e2e files with screenshots at the five sizes, and reads their new screens against 2.4's seven rules. A drift in a file lane 4 owns, or in a file no lane owns, is lane 4's to fix in this pass, at most 8 files. A drift in another lane's file (builder/Options.tsx is the likely one) goes to that lane before its docs commit. Anything larger is a follow-up, named in lane 4's report. Lane 4 adds a row to section 1 for each, in its docs commit.

## 6. Tests

**Unit** (node:test, beside the code):

- `Panel.test.ts` (lane 1): a `Group` with `keep` renders its folded content mounted and hidden, and without it renders none.
- `sceneSummary.test.ts` (lane 1): every row of 4.1's table, a preset and Custom, per player, squares and both hex shapes, a scene with a map and without, a suggested isometric view.
- `Loading.test.ts` (lane 0): `small` renders a 13 px status with a 16 px spinner, and `live={false}` no status.
- `controls.test.ts` (lane 2): `RadioCards` renders one radio per option named by its label and described by its help, a disabled group, Players see's `like` card and its status line. `ShapeRow` renders `even`.
- A `CreatureHeader` markup test (lane 4): the actions row after the quick numbers, none without actions.

**e2e** (each lane runs the files it touches and `reach`):

| Lane | Files and new steps |
|---|---|
| 1 | scenesetup (`dp-1a`: every group a `Group` with its summary while folded, the device's folds kept through a reload, Fog and party vision folding chevron first and closed on another scene), mapdiscovery, hex (its scene settings steps through the harness helpers), alignment-icons (ms2 and hx4 read the scene settings page), reach |
| 2 | hex (Room settings and the new scene form, `dp-2a`: Grid shape, New scene's kinds and Grid on new scenes on one row each at 320 x 568 and 390 x 844 at 130%, no sideways scroll), scenesetup (run, not edited: Players see's questions and busy taps), alignment-icons (ms2's room settings and This device), reach |
| 3 | pervision (`dp-3a`: the preview's socket refused once, LoadFailed's Try again, its loading line, then the preview, focus on the status), mapdiscovery (the asking line's tone), maps (the grid finder's lines), iso (ISOA-10 with the ellipsis), layout (the notices at their width), alignment, reach |
| 4 | pervision (`dp-4a`: View as in the header's actions row under the quick numbers for Thorn and for a token with two owners, Place a token in the same place on the character page), tokenpanel, the H2 and H3 files 5.1 runs, reach |

**Alignment.** Every screen a lane changes is measured with `measureAlignment` at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, nothing over 1 px. The roots that already cover them: ms2 and hx4 in `sceneSettingsTests` (the scene settings page, the map image's question, Room settings, This device), `grabberTests`, the iso5 menus, pervision's `viewas-panel` and `viewas-bar`. New roots, added in the owning lane's lines: the folded groups' summaries (lane 1, in its ms2 step through `sceneGroup`), the preview's failure line (lane 3, in alignmentRoom.ts 1035-1060), the header's actions row (lane 4, in pervision). The alignment files (`alignment`, `alignment-wide`, `alignment-icons`) run once on the stacked tip at integration, with `size`, `layout`, `reach`, `reach-player-100` and `reach-player-130`.

## 7. UI checklist

- **Loading.** Every wait in these screens is `Loading` after the shared 200 ms, `small` inside a help or options line. A slow button stays busy and refuses a second tap, as today. The preview's failure ends in Try again.
- **Keys and focus.** A `Group`'s fold takes Enter and Space and keeps focus on its header. The scene groups' folds, Fog and party vision's and the radio cards keep their tab order. Try again moves focus to the loading line's status. View as and Place a token keep their names and their focus return. No new shortcut, so the shortcut sheet and FEATURES.md's key list are unchanged.
- **Screen readers.** A `Group`'s button is named by the group's name alone and described by its summary. The radio cards stay a named radio group described by the chosen option's help. "This scene" is a heading. The preview's failure is an alert.
- **Large interface sizes.** At 130% a group's summary cuts with an ellipsis before its name does (`Group`'s 4em floor). Segmenteds with `even` wrap words inside each option, never stacking options.
- **Exact words.** "This scene". The summaries of 4.1's table. "Building area shapes…". "Could not load what Ana sees." with "Try again". Everything else keeps its words.

| Case | Expected | Test |
|---|---|---|
| A phone opens Scenes for the first time | What players see open, the other three folded, each saying what it holds | `dp-1a` |
| A DM folds Map image and grid and reloads | It stays folded, as today | `dp-1a` |
| A scene goes Custom | Fog and party vision opens, chevron first, as today | scenesetup ss-1 |
| Scene name on a phone | Under "This scene", apart from New scene | `dp-1a`, ms2 |
| Grid shape at 320 x 568 and 130% | Three options on one row | `dp-2a` |
| Room settings at 390 x 844 | Grid on new scenes is the same row as a scene's Grid shape | `dp-2a`, ms2 |
| Players see while a change is on its way | A tap does nothing and the working line shows after 200 ms, as today | scenesetup ss-4 |
| The preview cannot load | "Could not load what Ana sees." with Try again, an alert | `dp-3a` |
| Try again succeeds | The loading line, then Ana's view | `dp-3a` |
| No grid found | The line in the warning tone | maps |
| The builder waits on the server's ask | A muted line with the spinner | mapdiscovery |
| Thorn's token panel, a player owns him | Header, then View as Pat in its own row, then Stat block | `dp-4a` |
| Goblin's token panel | No actions row | `dp-4a` |
| Wolf's token panel | Companion of Thorn, the portrait badge, then View as Pat in the row | `dp-4a` |
| Thorn's page for the DM | Place a token in the same row and place | `dp-4a` |

## 8. Decided

Asking the project owner was off. Each choice below is the guess the owner would most likely make, from the call-outs and the passes' decisions, logged in the decisions file under its id.

1. **D-261028-20, the scene settings groups.** `Group` rows with icons and folded summaries, as the token panel and the character page. Rejected: keeping the capitals folds (the one page with groups that looks unlike the others), and making `Section`'s fold larger everywhere (it would change every dialog's folds).
2. **D-261028-21, the scene on screen's label.** "This scene" on the Scene name section, New scene staying where it is. Rejected: one New scene opener at the top of the panel (an extra tap for every new scene), and the scene's name as the label (the name field right under it repeats it).
3. **D-261028-22, Grid shape and New scene's kinds.** `even`, one row, words wrapping inside. Rejected: `ChoiceRows` (three rows for three short words), letting them stack.
4. **D-261028-23, Grid on new scenes.** The scene's own Segmented in Room settings. Rejected: the scene's Grid shape turning into radio cards (taller where a scene's settings are already long).
5. **D-261028-24, the radio cards.** One `RadioCards` in components/, Players see's extras as options. Rejected: leaving the copy (the next change would land in one of the two).
6. **D-261028-25, where View as sits in the token panel.** A header actions row under the quick numbers, shared with the character page's Place a token, still above every fold as D-261027-09 asks. Rejected: keeping it between the kind line and the numbers, and an icon alone on the name's row (on touch an icon takes its words, icons rule 3.1, and the name's row has no room for "View as a player").
7. **D-261028-26, the options line's tones.** Waits muted with the spinner, failures as warnings, green only for what worked. Rejected: one tone for every line of a tool.
8. **D-261028-27, the preview's failure.** `LoadFailed` with Try again, which reopens the preview. Rejected: Reload (it would reload the DM's own room), and keeping "Close and try again".
9. **D-261028-28, the small wait line.** `Loading` gains `small`, built first as lane 0. Rejected: each line keeping its own spinner, and `Loading`'s 18 px spinner in a 13 px line.
10. **D-261028-29, the lanes.** Four lanes after H3, lane 4 checking H2's and H3's screens first. Rejected: three lanes (lane 3 would carry the header too, and its files already span the room), and auditing H2 now (its screens are still moving).

## 9. As built

Filled in by each lane's docs commit: every place the build went its own way, and lane 4's H2 and H3 findings.
