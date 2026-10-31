# raccoon-vtt v1: the spacing pass

Status: draft 5, written from a measured audit on main at `de083a47`, with FL-7's surfaces measured again on main at `94fea909`. Draft 4 adopted review round 2 (SPACING-SOL-01, 06 and 07, SP-OPUS-10 to 13) with D-261030-512 to 517. Draft 5 adopts round 3 (SP-OPUS-14 to 16, SPACING-SOL-08) with D-261030-518 to 520. Draft 2 took the coordinator's rule for a name over bordered cards (addendum to D-261030-480) and the screens the sweep does not reach. Draft 3 adopts design review round 1 (SP-OPUS-1 to 9, SPACING-SOL-01 to 05) with the coordinator's D-261030-504 to 511. It merges the owner's spacing request with the planned drift check of the screens fast lanes FL-1 to FL-8 and follow-up batches 38 to 40 touched, against docs/design-v1-design-pass.md. The build waits for undo batch A to deploy (section 5).

The project owner wrote on 2026-10-30: "Map images and dice headers within the device settings have almost no gap between them and their content. Please do a ui pass looking for spacing/layout issues like this where spaces between things are inconsistent." The same note asks for the player's phone toolbar to fill its section. That is FL-10, a lane of its own, and this note leaves it alone. The design pass's words still stand: "consistent and unified/sleek while not sacrificing functionality", and "these aren't necessarily hard rules either i just want things that make sense given a design review".

Screenshots: `screenshots/spacing-audit/`, kept outside the repository, one clip per spot named `cNN-<spot>-<size>.png`.

## 1. How it was measured

Not by eye. A measuring script walked the DOM of every root the alignment sweep measures, and the scroller each root sits in, through all five sweep files (alignment, alignment-wide, alignment-icons, alignment-followups, alignment-settings). That covers the DM's and Pat's screens at 390 x 844, 360 x 740, 320 x 568, 844 x 390, 820 x 1180 and 1440 x 900, each at 100% and 130%. For each pair it recorded two numbers:

- **The layout gap**: from the bottom of one box to the top of the next, as CSS lays them out.
- **The visible gap**: from the bottom of the first part's words, or painted box, to the top of the next part's first words or painted box. A switch row's own padding is in the visible gap and not in the layout gap.

It measured three kinds of pair. A heading-like element (a legend, a radio group's name, a heading, a field's label, a help line) to its first content. A section or group to the next one, above and below the line. The insets of painted cards and pane bodies. 15,162 measurements in 56 kinds. Each kind's common value set the expected one, and the outliers (more than 3 px off it, or under 3 px) were shot at three sizes and looked at. 223 raw flags led to 27 spots, and 7 findings stand. The screens outside the sweep (3.5) added 1,440 measurements, 10 spots and 2 findings, 9 in all. Every number below is in layout px at 100%. At 130% each is 1.3 times larger, the same ratio.

## 2. The rules

The spacing the kit already keeps, measured where it holds, as one table. A finding is a pair that breaks its row.

| Pair | Gap | Where it holds today |
|---|---|---|
| A section label to its first content | `space(2)` | `Section`, `SectionLabel` (Panel.tsx) |
| A name (legend, radio group name) over a group of bordered cards, to its first card | `space(2)` | nowhere today: the cards stand `space(1)` apart, so the name must stand further off than they do (coordinator, addendum to D-261030-480) |
| A help line under that name, to the first card | `space(2)`, the name to the help keeps `space(1)` | nowhere today (D-261030-492) |
| A name (field label, a `Segmented` choice's own name) to its input or buttons | `space(1)` | `Field`, `Segmented`, the import's Light, for party vision |
| A help line to the control under it, outside card groups | `space(1)` | `Segmented` |
| A row's name to its own help, inside the row | `space(0.5)` | `Switch`, `SettingRow`, `Checkbox`, `Row` |
| A `SettingRow`'s name and help to its controls, full width | `space(2)` | `SettingRow` with `wide` (Sight, Grid shape: SettingRow.tsx:34) |
| A row in a settings list (a switch, a setting row, a choice block) | `space(2)` padding above and below, inside the row | `Switch`, `SettingRow`, Room settings' radio cards (SettingsPanel.tsx:89) |
| Section to section | 1 px line, `space(4)` above and below | `Section` |
| Group to group | 1 px line and no gap, the 48 px header row, the body `space(1)` under it and `space(4)` at its foot | `Group` |
| Sections inside a group | `space(4)`, no line | `Group` with `holds="sections"` |
| A page heading (h3) to its content, a sub-heading (h4) to its lines | `space(2)`, `space(1)` | the panels' own pages |
| Inside a card | `Row` `space(2)` by `space(3)`, a radio card `space(1)` by `space(2)` | `Row`, `RadioCards` |
| A pane body | `space(1)` top, `space(4)` sides and foot | `Sheet` (`paneBodyPadding`) |
| An empty state | `space(2)` above and below, its own padding | `Empty` |

Two consequences the audit checked and kept (D-261030-482, D-261030-486). A section label stands 8 px over a help line or a list and 16 px over a switch's words, since the row's padding is its 44 px target. A row's name sits 2 px over its own help, where a group's name sits 4 px over the help that describes the whole group. The card rule covers `RadioCards` in both its forms and `DiceSetPicker`, and nothing else (D-261030-493, D-261030-498).

## 3. Audit

Severity as the design pass: **P2** is inconsistent with the rest of the app, **P3** is polish.

### 3.1 A name to its content

| # | Finding | Measured | Expected | Screenshots | Code | Sev |
|---|---|---|---|---|---|---|
| S1 | The owner's example. A `RadioCards` group in its fieldset form puts its first card or help right under its legend: This device's "Map images", Room settings' nine choices (Who can move any token, Who can draw, Initiative order players see, Turn timer, Critical Hit damage, Diagonal moves, Which squares (or hexes) an area covers, Which creatures an area catches, Players see on new scenes) and the Handouts form's "Show to". The fieldset is a grid with `gap: space(1)`, but a rendered `<legend>` is not a grid item, so the gap never applies under it. The same cards as a radio group (Players see on the scene settings page, in the new scene form, NewScene.tsx:340, and in the Universal VTT import) stand 4 px under their name | 0 layout. 0.2 visible under Map images and Show to, 1.2 over a help line. 4 under Players see. Every size, DM and player | 8 to the first card. 4 to a help line, then 8 from it to the first card | `c01-map-images-*`, `c03-who-can-move-*`, `c04-show-to-*` | components/RadioCards.tsx:152-163 | P2 |
| S2 | The owner's second example, the same cause: This device's "Dice" legend over its tiles | 0 layout, 0 visible | 8 | `c02-dice-*` | features/device/DiceSetPicker.tsx:92-95 | P2 |

### 3.2 A section label to its first content

| # | Finding | Measured | Expected | Screenshots | Code | Sev |
|---|---|---|---|---|---|---|
| S3 | This device's Map detail is the one settings choice without a row's padding. MAP DETAIL stands 7.6 px over "Map images", where BATTERY, SOUNDS, ROLLS and SCREEN on the same page, and Room settings' PLAYERS over the same cards, stand 15.6 | 7.6 visible | 15.6 | `c07-map-detail-*` beside `c06-battery-*`, `c19-players-*` | features/device/ThisDevice.tsx:105-117 | P2 |
| S4 | The Attach sheet's FARTHER AWAY sits 4 px over its first row (its group's `gap: space(1)`) | 4 layout | 8 | `c09-farther-*` | features/attach/AttachButton.tsx:239 | P3 |
| S5 | The Dice panel's and token card's grid labels take a 4 px foot, half a section label's gap: SAVES and CHECKS from `GroupLabel`, SAVES FOR 3 and CHECKS FOR 3 from the group options' own `GridLabel` (built by `QuickGrid`). Measured again on main after FL-7: unchanged | 4 layout | 8 | `c08-saves-*` | features/dice/RollOptions.tsx:692-699, features/dice/groupSave/GroupOptions.tsx:189-201 (main `94fea909`) | P3 |

### 3.3 Headings on one page

| # | Finding | Measured | Expected | Screenshots | Code | Sev |
|---|---|---|---|---|---|---|
| S6 | About: two h3s and two kinds of h4 in one look, four gaps. "SRD 5.2.1 notice" to its text 8, "Credits" to its first entry 12, "Changes" to its text 8, each credit's name to its list 4 | 8, 12, 8, 4 | h3 8, h4 4 | `c11-credits-*`, `c12-srd-changes-*` | panels/AboutPanel.tsx:28-39, :104-120 | P3 |

### 3.4 Drift in tokens

| # | Finding | Code | Sev |
|---|---|---|---|
| S7 | Two new raw `gap: 2` where the token is `space(0.5)`: the View menu's rows and the guide's index rows. Nothing moves | features/view/ViewMenu.tsx:204, features/guide/GuideDocument.tsx:176 | P3 |

### 3.5 Screens outside the sweep

Driven directly with the same helper (a scratch Playwright script on its own room): Home, the DM link page, Join, Admin (signed out and in), the table display's pairing page and a paired display, and for the DM Log, Journal and a journal page, Areas, Library, Monsters, Encounters, Outliner, Party, Characters, Members, Paste a stat block, the Universal VTT import with its lights line (FL-2), and the PC stats editor, and for Pat Log, Journal, Areas, Library, Characters and Members. Each folded group opened and measured again. Sizes 390 x 844 and 320 x 568 at 100% and 130%, and 1440 x 900. Home, Join, Admin and the display take no interface size, so their 130% equals 100%.

| # | Finding | Measured | Expected | Screenshots | Code | Sev |
|---|---|---|---|---|---|---|
| S8 | The table display's pairing page stands "Code from the DM's screen" 12 px over its field (the form's `gap: space(3)`), where every other label on Home, Join and Admin stands 4 | 12 layout | 4 | `d03-display-code-*` | features/display/DisplayPages.tsx:95-97 | P3 |
| S9 | The Universal VTT import names two choices at 14 px under "Players see" at 16 px weight 600 in the same dialog: "Light, for party vision" and, for a map with a portal that lets light through, "Portals that don't block light import as" (it inherits the dialog's 14 px, ImportDialog.tsx:333) | 14 px | 16 px, weight 600 | `d06-uvtt-light-*`, `d07-uvtt-players-see-*` | features/vision/UvttLightChoice.tsx:21-23, features/uvtt/ImportDialog.tsx:552-554 | P3 |

S1 also holds the import's Players see (`d07-uvtt-players-see-*`). Group save's "Damage" label (GroupSave.tsx) stands 4 over its field through the form's `-space(1)` top margin, so rule 1 passes it and it is no finding. The image picker's "Image link" (features/images/ImagePicker.tsx:320) stands 8 over its field, the S8 pattern. It shows only on the image picker's Link tab (ImagePicker.tsx:246), which opens on Icons or This device (:67), and alignmentRoom.ts never opens that tab, so no root's scroller holds it. It goes on the follow-up list, and lane 1's check confirms no root reaches it (D-261030-516, D-261030-520). Kept as they are: Home's and Join's title over its tagline (one title block, D-261030-497), Members, Areas and Library starting lower under their header (a list row's and `Empty`'s own padding), the admin page's own form. The PC stats editor and the Log, which undo batch A owns, show no finding, so nothing waits on undo batch A.

### 3.6 Checked

- **Between sections and groups**: every section line reads `space(4)` above and below at every size (692 pairs), every group line 0 with its 48 px row (874 pairs).
- **Cards and panes**: the insets match their component everywhere the measure was not an artifact (a popover inside a section, scrolled content, centered tiles, alert cards measured while they expand).
- **The drift check**: the screens of FL-3 and FL-4 (HP fields, the damage summary), FL-5 (More), FL-6 (Take a shape, Forget this room), FL-8 (the sheet handle's menu and preview) and batch 39 (the Scenes rows, the resource sheet) have no spacing outlier. FL-7's landed surfaces, measured again on main `94fea909` through proficiency, alignment and alignment-wide (the dice options, roll cards and results, group saves, the token bar's saves, the PC sheet, the wild shape and polymorph blocks, 12,275 measurements): no new finding. Their grid labels are S5, older than FL-7. In that run FL-7's own check failed once, at 320 x 568 and 130%: fl7-sticky-result, "Sleight of Hand check: its underline's foot is 10.45 px under the button that clips it". It is outside this pass and is reported to the coordinator. `scripts/style-drift.ts` finds 0 drift test findings, 90% of spacing and 90% of font sizes from tokens (91% and 90% at the design pass). Its new raw gaps are S7.
- **Left as they are**: a row's touch padding (above), `Empty`'s own padding under HP CHANGES, lists of checkbox rows, the creature header's 4 px over its kind line beside the stat block's 8 (two type blocks the look passes settled).
- **Not measured**: Party and Characters at 1440 x 900 by the direct script (Party is a phone panel, and the sweep measures Characters there), and a paired display at 1440 x 900 (its pairing timed out there, and at the phone sizes it is the map alone, with no pair to measure). FU40-B's alerts column and isometric canvas text are being built.

## 4. The fixes

- **S1.** Both forms of `RadioCards` lay out the same column under the name: the help, when there is one, `space(1)` under the name, and the cards `space(2)` under whatever stands above them. In the fieldset form these are margins on the wrapper under the legend, since the fieldset's `gap` never reaches a rendered legend, and the fieldset loses that `gap`. In the radio group form the cards' `marginTop` (RadioCards.tsx:143) becomes `space(2)`. One component, every group: This device, Room settings, Show to, and Players see on the scene settings page and in the import. The legend keeps its look and the group its name, description and tab order.
- **S2.** The same in DiceSetPicker: its help (`space(1)` under the legend) and its tiles (`space(2)` under what stands above them) stand in one wrapper under the legend.
- **S3.** Map detail's `RadioCards` stands in a `div` with `padding: space(2) 0`, as SettingsPanel.tsx:89 does. Its section label then stands where every other settings section's does.
- **S4.** The far rows move into an inner grid that keeps their `space(1)` apart, as the near rows have, and the group's `gap` between the label and that grid becomes `space(2)` (D-261030-508).
- **S5.** `GroupLabel`'s and `GridLabel`'s `paddingBottom` become `space(2)`. The grid label keeps its note on its line.
- **S6.** The Credits section stands its entries `space(3)` apart under an h3 that keeps `space(2)` to the first, and the "Changes" h4 alone takes `space(1)` to its first block (NoticeBlock, AboutPanel.tsx:99, renders NOTICE.md flat). The blocks after it keep `space(2)` between them, and the closing paragraphs keep their spacing (D-261030-510).
- **S7.** `theme.space(0.5)` in both places.
- **S8.** The pairing form puts its label and field in one column with `gap: space(1)`, as `Field` does, and keeps `space(3)` between that column and the Connect button.
- **S9.** One shared style, `IMPORT_CHOICE_NAME` (`font.input`, `weight.strong`, exported from UvttLightChoice.tsx), names both choices (D-261030-509).

No fix changes a word, a role, a name or a touch target. None touches the protocol, stored data or a snapshot.

## 5. Lane plan

Two lanes, one builder each, in their own workspaces. FL-7 is on main (`94fea909`), so nothing waits on it: S5 is built now. Both lanes branch from main after undo batch A deploys, since undo A edits ImportDialog.tsx and e2e/alignmentRoom.ts. They avoid FU40-B's files (the alerts column, the isometric canvas text, and alignmentRoom.ts's `dmScreens`, about 803 to 860). No finding is on undo A's or FU40-B's files once undo A has landed.

| Lane | Fixes | Commits, in order | Files it owns |
|---|---|---|---|
| 1. Kit, This device and the check | S1, S2, S3, the spacing check (section 6) | `test(e2e): a spacing check beside the alignment check`, `fix(ui): radio cards keep their gap under a legend`, `fix(device): the dice legend and map detail keep the settings gaps`, `docs: the spacing pass, kit and this device` | components/RadioCards.tsx, components/controls.test.ts, components/Panel.tsx, components/SettingRow.tsx (`data-setting-row` on its outer element), features/dice/RollOptions.tsx and features/dice/groupSave/GroupOptions.tsx (the `data-section-label` marker only: on `GroupLabel`'s div and on `GridLabel`'s h4, which stands alone), features/device/DiceSetPicker.tsx, features/device/DiceSetPicker.test.ts, features/device/ThisDevice.tsx, e2e/helpers/spacing.ts (new), e2e/alignmentRoom.ts in four named hunks: one import line under the helpers' imports (line 18 on main, not the first lines undo A edits), one line in `Sweep.measure` after FL-7's two proficiency lines (326-327, left as they are), step `sp-0` at the end of `helperTest`, and the roots `display-pair` and `uvtt-import` in `sceneSettingsTests`' ms2 step after `show-a-handout` (about 5031), away from undo A's append after `md4Tests`. `uvtt-import` builds its .dd2vtt as maps.e2e.ts does, with a portal that lets light through. This note's lane 1 "As built" |
| 2. Panels | S4, S5, S6, S7, S8, S9 | `fix(attach): farther away keeps a section label's gap`, `fix(dice): grid labels keep a section label's gap`, `fix(about): one gap under each heading level`, `refactor(ui): two raw gaps take the space token`, `fix(display): the pairing code's label sits on its field`, `fix(uvtt): the import names its choices in one style`, `docs: the spacing pass, panels` | features/attach/AttachButton.tsx, features/dice/RollOptions.tsx and features/dice/groupSave/GroupOptions.tsx (the S5 padding, after lane 1's markers), panels/AboutPanel.tsx, features/view/ViewMenu.tsx, features/guide/GuideDocument.tsx, features/display/DisplayPages.tsx, features/vision/UvttLightChoice.tsx, features/vision/UvttLightChoice.test.ts (new), features/uvtt/ImportDialog.tsx (the portal label's style only), this note's lane 2 "As built" |

Lane 1's first commit carries the check, the two roots and every marker: Panel.tsx (the rows of `FoldLabel` and of a `SectionLabel` with an action, and a lone `SectionLabel`'s heading), SettingRow.tsx, RadioCards, DiceSetPicker, `GroupLabel`'s div and `GridLabel`'s h4 (D-261030-514, D-261030-518). Its failing lines are S1 to S6 and S8. If it fails on any line outside those, lane 1 reports it to the coordinator before lane 2 branches, and the coordinator makes it a lane 2 finding, an exemption with a drawn case, or a follow-up (D-261030-519). Lane 2 branches from that commit and judges green by its own lines while it builds: S4, S5, S6 and S8 pass and the S1 to S3 lines stay, since lane 1 owns them. Before its final run lane 2 rebases on lane 1's tip, and there the whole sweep must be green. The lanes share two files, RollOptions.tsx and GroupOptions.tsx, in stacked order only: lane 1's marker comes first and lane 2's padding after it, never in parallel.

Docs: no FEATURES.md line describes these gaps, so neither lane adds one (D-261030-489). No lane retakes a guide picture. docs/dm-guide/attach.webp (FARTHER AWAY), uvtt-lights.webp (Players see's cards) and dice.webp (the saves and checks grids) show gaps this pass moves, so they go on the guide pictures pass list, which runs after the feature run (D-261030-511).

## 6. Tests

**The spacing check** (lane 1): `e2e/helpers/spacing.ts`, beside `measureAlignment`, exports `measureSpacing(root)` and `spacingLines(findings, screen)`, in the same shape as alignment.ts. All four rules measure the root's nearest scroller: the nearest ancestor below the document whose computed `overflow-y` is `auto` or `scroll`, whether or not its content overflows now, or the root itself where there is none, so a bar row, a toast or a pill never widens to the page. Each scroller is measured once per `measure` call, however many elements the root matches (D-261030-517, D-261030-520). So `this-device-map-detail` and `grab-sheet-handle` reach This device's whole page (Rolls and Dice, BATTERY, MAP DETAIL), and `appicon-about` reaches About's body, where Credits and Changes stand for rule 4 (D-261030-512). The alignment checks keep their root. Only the spacing rules widen (D-261030-504). The rules select exactly (D-261030-505):

1. **A name over a card group.** A `[data-card-group]` element (lane 1 marks `RadioCards`' card column and `DiceSetPicker`'s tiles) and its name: the fieldset's `legend`, or the element its radio group's `aria-labelledby` names. The name's box to the first card is `space(2)` with no help, and with a help the name to the help is `space(1)` and the help to the first card `space(2)`, within `LIMIT_PX`. Also each `label[for]` that is the first child of a one-column grid and names an `input` (not a checkbox or radio), `select` or `textarea`: `space(1)` to its control. A legend is measured from its own box, since its fieldset's `gap` does not reach it.
2. **A section label to its content.** The marker sits on the label's row element: `GroupLabel`'s div, `FoldLabel`'s div, a `SectionLabel`'s action div, or the heading itself where it stands alone (a lone `SectionLabel`, `GridLabel`'s h4). Rule 2 measures from that box's bottom less its `padding-bottom` and bottom border to the next shown box in its column: `space(2)` within `LIMIT_PX`. A note or summary that wraps to a second line is part of the row, so it never adds to the gap, and padding that carries the gap counts as gap (D-261030-513, D-261030-518).
3. **Settings sections agree.** In one scroller, every section whose first content is a settings row or choice (a `[role="switch"]` row, a `[data-setting-row]`, a `[data-card-group]`) stands its label the same visible distance over that content's first words, within `LIMIT_PX`.
4. **Headings agree.** In one scroller, `h2` to `h4` of one look (tag, size and weight) stand one layout gap over their content, within `LIMIT_PX`. It skips any heading in `sectionLabelLook`, any heading inside a `[data-section-label]` or carrying one, and any heading in an action row: a heading that holds a disclosure button or shares its row with a direct sibling action, as `Group`'s and `FoldLabel`'s headers do. Inline heading links and descendant actions in another column do not exempt it. So the spell level h4, `GroupLabel`'s h4 and a group's h3 never enter it (D-261030-515, D-261030-519).

**Exempt, each with the audit's reason and a passing drawn case in `sp-0`**: Menu group headings (Menu.tsx:238, a menu's own 4 px foot over its items), the measure tool's group titles (features/measure/controls.tsx:689, :947, an options pop-up's titles), Copy settings' folder names (features/vision/CopySettings.tsx:132, names in a list), the spell level h4 (RollOptions.tsx:609, a row's own padding), Checkbox rows (Checkbox.tsx:87) and the cards' and tiles' own labels (each a row, not a name over content), `SettingRow` names (name 2 px over its help, controls 8 below, D-261030-486 and 498), and a `Group`'s or `FoldLabel`'s header heading (an action row). None of them carries a marker the rules select.

Each line names the screen, the pair's words and both numbers: `390x844 this-device-map-detail: "Map images" sits 0 px over its first card, wants 8`. `Sweep.measure` adds the lines after FL-7's proficiency lines, so every root of the five files and `proficiency` is checked, and shot when it fails.

On main the check fails on S1 (this-device-map-detail, grab-sheet-handle, room-settings, room-settings-hex, show-a-handout, scene-settings, uvtt-import), S2 and S3 (this-device-map-detail, grab-sheet-handle), S4 (attach-list), S5 (dp-card-tabs, dp-card-wolf, dp-modes, dp-several, fl6-skills-*, the fl7-*-dice roots, group-save), S6 (appicon-about, through About's scroller) and S8 (display-pair). S5 is among them because lane 1's first commit carries `GroupLabel`'s and `GridLabel`'s markers. That is the proof the check sees them. S7 moves nothing and S9 is a type size, so both are held by review and a unit test, not by the sweep.

**Drawn cases** (lane 1, in `helperTest`, step `sp-0`): a fieldset as a grid with a legend over a card group (fails at 0, passes with the margins, with and without a help), a section label over a help line and over a switch row (both pass, rule 2 counts layout boxes), a settings page with one bare choice among switch rows (fails rule 3), two h4s 4 and 8 over their text (fails rule 4), and one passing case for each exemption. For rule 2, three label structures each pass at 8 and fail at 4: `GridLabel`'s h4 whose gap is its own bottom padding, a `GroupLabel` whose note wraps to a second line under its h4, and a `FoldLabel` whose summary wraps under its name. A root with no scrolling ancestor measures itself alone. Each at 100% and 130%.

**Unit**: `controls.test.ts` checks both forms of `RadioCards`, with and without a help: the help `space(1)` under the name, the cards `space(2)` under what stands above them, and no fieldset `gap`. `DiceSetPicker.test.ts` checks the same with Roll animation on and off. `UvttLightChoice.test.ts` checks that `IMPORT_CHOICE_NAME` is `font.input` at `weight.strong` and that the light choice's name renders with it, and ImportDialog's portal label imports the same constant (D-261030-509).

**Mutation**: each fix removed brings its sweep line back (lane 1 runs it for S1 to S3, lane 2 for S4, S5, S6 and S8), S9's unit test fails with the 14 px style back, and each drawn case fails with the rule it checks turned off.

Runs: the five alignment files, `proficiency` and `reach`. Lane 1 also runs `layout`, `scenesetup` and `maps`, which read Room settings', Players see's and the import's cards. Lane 2 also runs `dice` and `attach`.

## 7. UI checklist

- **Loading.** Unchanged: no fix touches a wait.
- **Keys and focus.** The radio cards, the dice tiles, Attach's rows and About's links keep their tab order and focus rings. A margin moves nothing in the focus order.
- **Screen readers.** Every fieldset keeps its legend as its name and its description. The radio group form keeps its role, name and description. No heading level changes. The section label marker is a data attribute and changes no role.
- **Large interface sizes.** At 130% every gap grows by the scale, as every other gap does. At 320 x 568 and 130% Map detail's cards keep their full width inside the row's padding, which pads above and below only.
- **Exact words.** No word changes.

| Case | Expected | Test |
|---|---|---|
| This device, Map images, at every sweep size | 8 px from the legend to the first card | sweep (this-device-map-detail), `sp-0` |
| This device, Dice, with Roll animation on and off | 8 px to the first tile, or 4 to the help line and 8 from it to the tiles when off | sweep (grab-sheet-handle, through its scroller), DiceSetPicker unit |
| This device, MAP DETAIL beside BATTERY | One visible gap from each label to its row's words | sweep rule 3 (this-device-map-detail, through its scroller) |
| Room settings, every choice, squares and hexes | The help 4 px under each legend, the cards 8 under the help | sweep (room-settings, room-settings-hex) |
| Players see (the radio group form), scene settings, the new scene form and the import | 8 px from the name to the first card | sweep (scene-settings, uvtt-import), scenesetup |
| Show a handout's Show to | 8 px from the legend to the first card | sweep (show-a-handout) |
| Attach, FARTHER AWAY | 8 px over the first row, its rows still 4 apart | sweep (attach-list) |
| About | h3 8 over its content, h4 4 over its first block, Changes' blocks 8 apart | sweep (appicon-about, through its scroller) |
| The display's pairing page | The label 4 px over the code field | sweep (display-pair) |
| The import's light choice and portal choice | Both names in `IMPORT_CHOICE_NAME`, as large as Players see's | UvttLightChoice unit, maps |
| Sight and Grid shape (SettingRow) | Name 2 over its help, controls 8 below, not flagged | `sp-0`, sweep (vision-sight, scene-settings) |
| Menu group headings, measure titles, Copy settings folders | Not flagged | `sp-0` |
| SAVES, CHECKS and the group's FOR 3 labels | 8 px over the grid | sweep (dp-*, fl6-skills-*, fl7-*-dice, group-save) |
| A fix removed | Its line fails the sweep | mutation runs |

## 8. Decided

Asking the project owner was off. Each choice below is the guess the owner would most likely make, logged in the decisions file under its id.

1. **D-261030-480, a name's gap, with the coordinator's addendum.** A name over a group of bordered cards (`RadioCards`, `DiceSetPicker`) stands `space(2)` over its first card, since the cards stand `space(1)` apart and a name as close as they are reads as the "almost no gap" the owner named. A plain field label over its input keeps `space(1)`. The first guess, `space(1)` for both, is replaced.
2. **D-261030-481, a choice in a settings list.** It stands in a row's `space(2)` padding, as Room settings' cards already do, so This device's Map detail matches the switches above and below it. Rejected: dropping the row padding everywhere, which breaks the 44 px targets.
3. **D-261030-482, a row's padding counts.** A section label stands 8 px over the row's box and so 16 px over a switch's words. The audit keeps that and does not flag it. Rejected: negative margins to pull every first row to 8 visible.
4. **D-261030-483, the dice grid labels.** `GroupLabel` and the group options' `GridLabel` take a section label's `space(2)`, built now that FL-7 is on main (D-261030-506). Rejected: keeping the dice panel's own 4 px, which no other label in the app uses.
5. **D-261030-484, Attach's Farther away.** `space(2)` under it, as a section label, with its rows kept 4 apart in an inner grid (D-261030-508). Rejected: leaving it, since it is the one label on its sheet that is not a sheet heading.
6. **D-261030-485, About.** One gap per heading level: h3 `space(2)`, h4 `space(1)` to its first block, the blocks after it as they are (D-261030-510). Rejected: one gap for both levels, which would set a credit's name as far from its list as the page's sections.
7. **D-261030-486, a row's own help.** It stays `space(0.5)` under the row's name (Switch, SettingRow, Checkbox, Row). Rejected: 4 px everywhere, which would grow every settings row by 2 px with no gain.
8. **D-261030-487, empty states.** `Empty` keeps its own `space(2)` padding under a section label. Rejected: trimming it, which would change every panel's empty state.
9. **D-261030-488, what the check tests.** Names over card groups and plain field labels, marked section labels, settings sections and headings, by the selectors and exemptions of section 6 (D-261030-504, 505), the kinds where the audit found and fixes issues. Card insets and section gaps are measured in the audit, not tested, since centered tiles, touch rows and expanding cards would flag noise. Rejected: one check over every measured kind.
10. **D-261030-489, FEATURES.md.** No line describes these gaps, so the lanes add none. Rejected: a new line naming spacing, which is not a feature.
11. **D-261030-492, a help line inside a card group.** It keeps `space(1)` under the name and stands `space(2)` over the first card, so the cards always stand further from what heads them than from each other. Rejected: 4 px from the help to the cards, which would bring back the crowding under a help-led group.
12. **D-261030-493, both forms of the cards.** The radio group form (Players see) takes the same 8 px as the fieldset form. Rejected: changing only the fieldset form, which would leave two gaps for one component.
13. **D-261030-494, the sweep's new roots.** Only the pairing page and the import dialog join the sweep, the two screens outside it with a finding. The rest of 3.5 was measured once and has none. Rejected: a root for every screen of 3.5, which would add minutes to every run for screens with nothing to hold.
14. **D-261030-495, the pairing code's label.** `space(1)` over its field, as every `Field`. Rejected: keeping the form's `space(3)`, which sets this one label apart from Home's and Join's.
15. **D-261030-496, the import's choice names.** Light, for party vision and the portal choice at 16 px weight 600 in one shared style, as Players see's above them (D-261030-509). Rejected: 14 px, which reads as a lesser heading in one dialog.
16. **D-261030-497, Home's and Join's titles.** The title and its tagline stay one tight block (about 1 px between the lines), as a row's name and its help. Rejected: a gap under the title, which would split the crest's block.
17. **D-261030-498, named choices that are not card groups.** A `Segmented` choice's own name (Light, for party vision) keeps `space(1)` over its buttons. A `SettingRow`'s name (Sight, Grid shape) keeps its row layout: 2 px over its help and its controls 8 below. The coordinator's 8 px is for bordered card groups. Rejected: 8 px for every named choice.
18. **D-261030-504 to 511, the coordinator's calls on review round 1.** 504: rules 1 to 3 measure the root's nearest scroller, the alignment checks keep their root. 505: exact selectors by marker, and the exemption list with a drawn case each. 506: S5 holds GroupOptions' `GridLabel`, with the real roots. 507: both lanes from main after undo A deploys, no `SPACING_AFTER`, lane 1's hunks named, lane 2 green by its own lines and then on lane 1's tip. 508: Farther away's rows keep 4 in an inner grid. 509: S9's two names share one style, held by a unit test, with a light-passing portal in the import's file. 510: the Changes h4 takes `space(1)` to its first block. 511: guide pictures go on the guide pictures pass list.
19. **D-261030-512 to 517, the coordinator's calls on review round 2.** 512: rule 4 widens to the same bounded scroller as rules 1 to 3, so About's body is measured. 513: rule 2 counts a label's own padding as gap (its geometry replaced by 518). 514: lane 1's first commit carries every marker, SettingRow's and the two dice labels' included. 515: rule 4 skips section-label headings. 516: group save's Damage is no finding (4 px through its form's margin), and lane 1 checks whether Image link sits in a root's scroller, a lane 2 finding if so. 517: the nearest scroller is bounded below the document, else the root.
20. **D-261030-518 to 520, the coordinator's calls on review round 3.** 518: the section label marker sits on the label's row element and rule 2 measures from that box's bottom less its padding and border, so a wrapped note or summary counts as label. 519: an action row is a heading that holds a button or shares its row with one, skipped by rule 4, and any first-commit failure outside S1 to S6 and S8 goes to the coordinator before lane 2 branches. 520: a scroller is any ancestor with computed `overflow-y` auto or scroll, measured once per call, and Image link is a follow-up.

## 9. As built

Filled in by each lane's docs commit.

### Lane 1, kit, This device and the check

- **Markers.** As section 5 lists them. On RadioCards' radio group form, `data-card-group` stands after the group's aria attributes, so the markup tests that read its name and description in order still match. GroupOptions.test.ts reads `GridLabel`'s h4 by its exact markup, so its pattern now names the marker too (one line).
- **The helper.** `e2e/helpers/spacing.ts` exports `measureSpacing`, `spacingLines`, `spacingOff` and the `SpacingFinding` type. `measureSpacing` returns every pair it measured, passing ones too, so each passing drawn case shows its pair was measured. Gaps are layout px as at 100%, read through each element's `currentCSSZoom`, so a line reads the same at 100% and 130%. Both spacing and alignment reject zero matched roots unless the caller passes `{ optional: true }`. A visible marked structure with no name, a hidden name, no shown card or no following content yields a named skipped finding that fails the check. Hidden structures are ignored because they have no layout gap.
- **The scroller.** The walk starts at the root itself, so a root that scrolls is its own scroller. The page's `html` and `body` never count. A scroller held inside another scope of the same call is read once, with the outer one.
- **Rule 1.** The help is what stands between the name and the first card, in document order, outside both, with words of its own. With more than one, the name is held to the first and the cards to the last. A field label's grid is one column when its computed `grid-template-columns` is one track or `none`.
- **Rule 2.** The next shown box is the label's next shown element sibling. A sibling that starts above the label's top plus 1 px stands beside it and cannot supply the required content gap. That case and a missing shown sibling yield skipped findings. A label with a closed disclosure button (`aria-expanded="false"`) is explicitly exempt while its content is hidden or unmounted.
- **Rule 3 (D-261030-525, with SP-OPUS-17).** It reads from the bottom of the label's heading words to the content's first words. A fold or an action centers the label's words in a 44 px row, about 14 px over the row's foot, so from the words such a row could never agree with a lone heading. Rule 3 compares labels of one kind: lone headings, fold rows, and other label rows (an action's). That is how a fold section and a lone section over switch rows in one scroller pass, as the scene settings page's Fog and party vision does among its lone labels. The usual gap is the one most of a kind stand within `LIMIT_PX` of, the first in document order on a tie.
- **Rule 4 (D-261030-525).** One look is the tag, the computed size and weight, and whether a rule stands under the heading. The first build's check flagged the creature header's plain h3 (CreatureHeader.tsx, 4 px over its kind line) against the stat block's ruled title h3 (Markdown.tsx, 8 px over its kind line) on cu-panel-uses at 1440 x 900 and on proficiency's dragon, monster, wild shape and polymorph blocks at every size. Section 3.6 keeps that pair, so a ruled heading is a look of its own. About's headings have no rule, so S6 still holds. A heading's disclosure button is exempt. "Shares its row with an action" requires an action that is the heading's element sibling and overlaps it from top to bottom. An inline link or a descendant action in another column does not exempt a heading.
- **sp-0.** Beyond section 6's cases: the radio group form at 4 and 8, a field label at 12 and 4, a ruled h3 at 8 beside a plain h3 at 4 (passes) and two plain h3s at 4 and 8 (fails), a label whose own padding carries its gap among lone labels (rule 3 passes, read from the words), fold sections held to each other (a bare choice among them fails), headings that hold their disclosure among the exemptions, and one root list matching three sections of one scroller (measured once).
- **Roots.** `uvtt-import` sends its file as a buffer, the content of maps.e2e.ts's `writeUvtt` with its one light, whose open window is the portal that lets light through. `display-pair` opens `/display` in a new page of the DM's context at the size and measures the pairing card. Neither shows an alignment line.
- **Image link.** No root's scroller reaches it: a logging run of the first build's six files (removed afterwards) measured 4,222 pairs in 1,858 calls, and the only field labels among them were the pairing code's, Damage, Scene name, Title and View as a player.
- **S1.** Both forms share one help and one card column style. The fieldset loses `display: grid` with its gap, since nothing in it is laid out as a grid item once margins carry the gaps.
- **S2.** As S1, with the help and the tiles in one column under the legend. The fieldset loses its grid and gap.
- **S3.** As section 4.

### Lane 2, panels

- **S4.** As section 4. The inner grid holds only the far rows, so the group's `space(2)` gap sits under the label alone.
- **S5.** As section 4, on lane 1's markers. The padding now carries the whole `space(2)`, so rule 2 reads it as gap.
- **S6.** The "Changes" h4 takes a `-space(1)` bottom margin inside the notice section's `space(2)` gap, as Group save's "Damage" label does, since the notice blocks render flat. The Credits entries sit in one inner grid at `space(3)`, so the h3 keeps `space(2)` to the first entry.
- **S7.** As section 4. Nothing moves.
- **S8.** As section 4. The label and the field share a column at `space(1)`.
- **S9.** `IMPORT_CHOICE_NAME` is exported from UvttLightChoice.tsx. Its unit test also reads ImportDialog's source for the portal label's use of it, since the label sits in a component the test does not render. The `uvtt-import` root already carries a portal that lets light through, so the label is on screen when it measures.
- **Checks.** The whole sweep, `proficiency`, `maps`, `reach`, `dice` and `attach` pass on lane 1's tip with no spacing line left. With S4, S5, S6 and S8 removed, their lines return in the sweep (Farther away, Saves and Checks, Credits and Changes, the pairing code's label).
