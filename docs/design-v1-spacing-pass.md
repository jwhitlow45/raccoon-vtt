# raccoon-vtt v1: the spacing pass

Status: draft 2, written from a measured audit on main at `de083a47`. Draft 2 takes the coordinator's rule for a name over bordered cards (addendum to D-261030-480) and adds the screens the sweep does not reach, driven directly. It merges the owner's spacing request with the planned drift check of the screens fast lanes FL-1 to FL-8 and follow-up batches 38 to 40 touched, against docs/design-v1-design-pass.md. The build waits for the lanes named in section 4.

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
| A name (field label, picker or segmented choice name) to its input or buttons | `space(1)` | `Field`, `Segmented`, Players see's sight choice |
| A help line to the control under it, outside card groups | `space(1)` | `Segmented` |
| A row's name to its own help, inside the row | `space(0.5)` | `Switch`, `SettingRow`, `Checkbox`, `Row` |
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
| S1 | The owner's example. A `RadioCards` group in its fieldset form puts its first card or help right under its legend: This device's "Map images", Room settings' nine choices (Who can move any token, Who can draw, Initiative order players see, Turn timer, Critical Hit damage, Diagonal moves, Which squares (or hexes) an area covers, Which creatures an area catches, Players see on new scenes) and the Handouts form's "Show to". The fieldset is a grid with `gap: space(1)`, but a rendered `<legend>` is not a grid item, so the gap never applies under it. The same cards as a radio group (Players see, on the scene settings page and in the Universal VTT import) stand 4 px under their name | 0 layout. 0.2 visible under Map images and Show to, 1.2 over a help line. 4 under Players see. Every size, DM and player | 8 to the first card. 4 to a help line, then 8 from it to the first card | `c01-map-images-*`, `c03-who-can-move-*`, `c04-show-to-*` | components/RadioCards.tsx:152-163 | P2 |
| S2 | The owner's second example, the same cause: This device's "Dice" legend over its tiles | 0 layout, 0 visible | 8 | `c02-dice-*` | features/device/DiceSetPicker.tsx:92-95 | P2 |

### 3.2 A section label to its first content

| # | Finding | Measured | Expected | Screenshots | Code | Sev |
|---|---|---|---|---|---|---|
| S3 | This device's Map detail is the one settings choice without a row's padding. MAP DETAIL stands 7.6 px over "Map images", where BATTERY, SOUNDS, ROLLS and SCREEN on the same page, and Room settings' PLAYERS over the same cards, stand 15.6 | 7.6 visible | 15.6 | `c07-map-detail-*` beside `c06-battery-*`, `c19-players-*` | features/device/ThisDevice.tsx:105-117 | P2 |
| S4 | The Attach sheet's FARTHER AWAY sits 4 px over its first row (its group's `gap: space(1)`) | 4 layout | 8 | `c09-farther-*` | features/attach/AttachButton.tsx:239 | P3 |
| S5 | The Dice panel's and token card's grid labels (SAVES, CHECKS, SAVES FOR 3, CHECKS FOR 3) take a 4 px foot (`GroupLabel`'s `paddingBottom`), half a section label's gap | 4 layout | 8 | `c08-saves-*` | features/dice/RollOptions.tsx:663-669 | P3 |

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
| S9 | The Universal VTT import's "Light, for party vision" names its choice at 14 px, under "Players see" at 16 px weight 600 in the same dialog. Every other choice name is 16 px (D-261030-496) | 14 px | 16 px | `d06-uvtt-light-*`, `d07-uvtt-players-see-*` | features/vision/UvttLightChoice.tsx:21-23 | P3 |

S1 also holds the import's Players see (`d07-uvtt-players-see-*`). Kept as they are: Home's and Join's title over its tagline (one title block, D-261030-497), Members, Areas and Library starting lower under their header (a list row's and `Empty`'s own padding), the admin page's own form. The PC stats editor and the Log, which undo batch A owns, show no finding, so nothing waits on undo batch A.

### 3.6 Checked

- **Between sections and groups**: every section line reads `space(4)` above and below at every size (692 pairs), every group line 0 with its 48 px row (874 pairs).
- **Cards and panes**: the insets match their component everywhere the measure was not an artifact (a popover inside a section, scrolled content, centered tiles, alert cards measured while they expand).
- **The drift check**: the screens of FL-3 and FL-4 (HP fields, the damage summary), FL-5 (More), FL-6 (Take a shape, Forget this room), FL-8 (the sheet handle's menu and preview) and batch 39 (the Scenes rows, the resource sheet) have no spacing outlier. FL-7's surface holds S5, older than FL-7. `scripts/style-drift.ts` finds 0 drift test findings, 90% of spacing and 90% of font sizes from tokens (91% and 90% at the design pass). Its new raw gaps are S7.
- **Left as they are**: a row's touch padding (above), `Empty`'s own padding under HP CHANGES, lists of checkbox rows, the creature header's 4 px over its kind line beside the stat block's 8 (two type blocks the look passes settled).
- **Not measured**: Party and Characters at 1440 x 900 by the direct script (Party is a phone panel, and the sweep measures Characters there), and a paired display at 1440 x 900 (its pairing timed out there, and at the phone sizes it is the map alone, with no pair to measure). FU40-B's alerts column and isometric canvas text are being built.

## 4. The fixes

- **S1.** Both forms of `RadioCards` lay out the same column under the name: the help, when there is one, `space(1)` under the name, and the cards `space(2)` under whatever stands above them. In the fieldset form these are margins on the wrapper under the legend, since the fieldset's `gap` never reaches a rendered legend, and the fieldset loses that `gap`. In the radio group form the cards' `marginTop` (RadioCards.tsx:143) becomes `space(2)`. One component, every group: This device, Room settings, Show to, and Players see on the scene settings page and in the import. The legend keeps its look and the group its name, description and tab order.
- **S2.** The same in DiceSetPicker: its help (`space(1)` under the legend) and its tiles (`space(2)` under what stands above them) stand in one wrapper under the legend.
- **S3.** Map detail's `RadioCards` stands in a `div` with `padding: space(2) 0`, as SettingsPanel.tsx:89 does. Its section label then stands where every other settings section's does.
- **S4.** The Farther away group's `gap` becomes `space(2)`.
- **S5.** `GroupLabel`'s `paddingBottom` becomes `space(2)`. The grid label keeps its note on its line.
- **S6.** The Credits section stands its entries `space(3)` apart under an h3 that keeps `space(2)` to the first, and "Changes" with its text and list form one block with `space(1)` under the h4, as each credit's name has.
- **S7.** `theme.space(0.5)` in both places.
- **S8.** The pairing form puts its label and field in one column with `gap: space(1)`, as `Field` does, and keeps `space(3)` between that column and the Connect button.
- **S9.** The name takes `font.input` at `weight.strong`, as Players see's name above it.

No fix changes a word, a role, a name or a touch target. None touches the protocol, stored data or a snapshot.

## 5. Lane plan

Two lanes, one builder each, in their own workspaces, from the stacked tip. They avoid the client files the running lanes own: undo batch A (client/state, the Log and the setup editors), FL-7 (the roll and proficiency surfaces) and FU40-B (the alerts column and the isometric canvas text). S5 is on FL-7's surface, so it waits: **S5 after FL-7 lands**. No finding is on undo batch A's or FU40-B's files, the Log and the PC stats editor included.

| Lane | Fixes | Commits, in order | Files it owns |
|---|---|---|---|
| 1. Kit, This device and the check | S1, S2, S3, the spacing check (section 6) | `test(e2e): a spacing check beside the alignment check`, `fix(ui): radio cards keep their gap under a legend`, `fix(device): the dice legend and map detail keep the settings gaps`, `docs: the spacing pass, kit and this device` | components/RadioCards.tsx, components/controls.test.ts, features/device/DiceSetPicker.tsx, features/device/DiceSetPicker.test.ts, features/device/ThisDevice.tsx, e2e/helpers/spacing.ts (new), e2e/alignmentRoom.ts (the `Sweep.measure` line, `SPACING_AFTER`, the drawn cases in `helperTest`, and two new roots: `display-pair`, the pairing page at the ms2 sizes, and `uvtt-import`, the import dialog with its lights line, built from a small generated .dd2vtt as maps.e2e.ts does), this note's lane 1 "As built" |
| 2. Panels | S4, S6, S7, S8, S9, then S5 | `fix(attach): farther away keeps a section label's gap`, `fix(about): one gap under each heading level`, `refactor(ui): two raw gaps take the space token`, `fix(display): the pairing code's label sits on its field`, `fix(vision): the import's light choice names itself as players see does`, after FL-7 lands `fix(dice): grid labels keep a section label's gap`, `docs: the spacing pass, panels` | features/attach/AttachButton.tsx, panels/AboutPanel.tsx, features/view/ViewMenu.tsx, features/guide/GuideDocument.tsx, features/display/DisplayPages.tsx, features/vision/UvttLightChoice.tsx, features/dice/RollOptions.tsx (S5 only, after FL-7), this note's lane 2 "As built" |

Lane 2 starts on lane 1's first commit, which also adds the two roots S8 and S9 need, so its fixes turn lane 1's failing lines green. The other screens of 3.5 have no finding and stay outside the sweep (D-261030-494). The two lanes share no file, and lane 2 only runs the sweep. Lane 2's S5 commit removes S5's entries from `SPACING_AFTER` in e2e/alignmentRoom.ts, the one line lane 1 hands over for it.

Docs: no FEATURES.md line describes these gaps, so neither lane adds one (D-261030-489). The DM guide has no picture of This device's Map detail or Room settings' choices at a size where these gaps show, so no picture is retaken.

## 6. Tests

**The spacing check** (lane 1): `e2e/helpers/spacing.ts`, beside `measureAlignment`, exports `measureSpacing(root)` and `spacingLines(findings, screen)`, in the same shape as alignment.ts. It runs in the page over everything under a root and finds:

1. **A name to its content.** Each `legend`, radio group name (`[role="radiogroup"]`'s `aria-labelledby`) and `label` that heads a column, to the next shown box in its fieldset or column. The layout gap must be `space(2)` to the first bordered card of a `RadioCards` or `DiceSetPicker` group (found by `data-` markers lane 1 adds to both), and `space(1)` to a help line or any other control, within `LIMIT_PX`. A help line inside a card group must stand `space(2)` over the first card. A legend is measured from its own box, since its fieldset's `gap` does not reach it.
2. **A section label to its content.** Each element in `sectionLabelLook` (13 px, weight 700, capitals) that heads a column, to the next shown box. The layout gap must be `space(2)` within `LIMIT_PX`.
3. **Settings sections agree.** In one scroller, every section whose first content is a settings row or choice (a `[role="switch"]` row, a `SettingRow`, a fieldset or radio group) stands its label the same visible distance over that content's first words, within `LIMIT_PX`. This catches a choice that skipped the row's padding (S3) without flagging the help-led sections.
4. **Headings agree.** In one root, headings of one look (tag, size and weight) stand one layout gap over their content, within `LIMIT_PX`.

Each line names the screen, the pair's words and both numbers: `390x844 this-device-map-detail: "Map images" sits 0 px over its content, wants 4`. `Sweep.measure` adds the lines to the sweep's, after the alignment lines, so every root of the five files is checked and shot when it fails. `SPACING_AFTER` lists the screens and words of findings that wait on another lane (S5, until FL-7 lands), and a line it matches is reported in the log, not failed, so nothing waits silently.

On today's main the check fails on S1 (this-device-map-detail, room-settings, room-settings-hex, show-a-handout, scene-settings, uvtt-import), S2 and S3 (this-device-map-detail, grab-sheet-handle), S4 (attach-list), S6 (appicon-about), S8 (display-pair), S9 (uvtt-import: rule 1 compares a choice name's size with the other names in its root) and, outside `SPACING_AFTER`, S5 (dp-*, fl6-skills-*). That is the proof the check sees them.

**Drawn cases** (lane 1, in `helperTest`, step `sp-0`): a fieldset as a grid with a legend over a card (fails at 0, passes with the margin), a section label over a help line and over a switch row (both pass, rule 2 counts layout boxes), a settings page with one bare choice among switch rows (fails rule 3), and two h4s 4 and 8 over their text (fails rule 4). Each at 100% and 130%.

**Unit**: `controls.test.ts` checks that the fieldset form's markup holds the wrapper with the `space(1)` top margin and no fieldset `gap`, beside the radio group form's. `DiceSetPicker.test.ts` checks the same under "Dice".

**Mutation**: each fix removed brings its sweep line back (lane 1 runs it for S1 to S3, lane 2 for S4 to S6), and each drawn case fails with the rule it checks turned off.

Runs: the five alignment files, plus `reach`. Lane 1 also runs `layout` and `scenesetup`, which read Room settings' and Players see's cards.

## 7. UI checklist

- **Loading.** Unchanged: no fix touches a wait.
- **Keys and focus.** The radio cards, the dice tiles, Attach's rows and About's links keep their tab order and focus rings. A margin moves nothing in the focus order.
- **Screen readers.** Every fieldset keeps its legend as its name and its description. The radio group form is untouched. No heading level changes.
- **Large interface sizes.** At 130% every gap grows by the scale, as every other gap does. At 320 x 568 and 130% Map detail's cards keep their full width inside the row's padding, which pads above and below only.
- **Exact words.** No word changes.

| Case | Expected | Test |
|---|---|---|
| This device, Map images, at every sweep size | 8 px from the legend to the first card | sweep (this-device-map-detail), `sp-0` |
| This device, Dice, with Roll animation on and off | 8 px to the first tile, or 4 to the help line and 8 from it to the tiles when off | sweep (grab-sheet-handle), DiceSetPicker unit |
| This device, MAP DETAIL beside BATTERY | One visible gap from each label to its row's words | sweep rule 3 |
| Room settings, every choice, squares and hexes | The help 4 px under each legend, the cards 8 under the help | sweep (room-settings, room-settings-hex) |
| Players see (the radio group form), scene settings and the import | 8 px from the name to the first card | sweep (scene-settings, uvtt-import), scenesetup |
| Show a handout's Show to | 8 px from the legend to the first card | sweep (show-a-handout) |
| Attach, FARTHER AWAY | 8 px over the first row | sweep (attach-list) |
| About | h3 8 over its content, h4 4 over its lines | sweep (appicon-about) |
| The display's pairing page | The label 4 px over the code field | sweep (display-pair) |
| The import's light choice | Its name as large as Players see's | sweep (uvtt-import) |
| SAVES and CHECKS before FL-7 lands | Reported, not failed | sweep log, `SPACING_AFTER` |
| SAVES and CHECKS after lane 2's S5 commit | 8 px over the grid | sweep (dp-*, fl6-skills-*) |
| A fix removed | Its line fails the sweep | mutation runs |

## 8. Decided

Asking the project owner was off. Each choice below is the guess the owner would most likely make, logged in the decisions file under its id.

1. **D-261030-480, a name's gap, with the coordinator's addendum.** A name over a group of bordered cards (`RadioCards`, `DiceSetPicker`) stands `space(2)` over its first card, since the cards stand `space(1)` apart and a name as close as they are reads as the "almost no gap" the owner named. A plain field label over its input keeps `space(1)`. The first guess, `space(1)` for both, is replaced.
2. **D-261030-481, a choice in a settings list.** It stands in a row's `space(2)` padding, as Room settings' cards already do, so This device's Map detail matches the switches above and below it. Rejected: dropping the row padding everywhere, which breaks the 44 px targets.
3. **D-261030-482, a row's padding counts.** A section label stands 8 px over the row's box and so 16 px over a switch's words. The audit keeps that and does not flag it. Rejected: negative margins to pull every first row to 8 visible.
4. **D-261030-483, the dice grid labels.** They take a section label's `space(2)`, after FL-7 lands. Rejected: keeping the dice panel's own 4 px, which no other label in the app uses.
5. **D-261030-484, Attach's Farther away.** `space(2)` under it, as a section label. Rejected: leaving it, since it is the one label on its sheet that is not a sheet heading.
6. **D-261030-485, About.** One gap per heading level: h3 `space(2)`, h4 `space(1)`. Rejected: one gap for both levels, which would set a credit's name as far from its list as the page's sections.
7. **D-261030-486, a row's own help.** It stays `space(0.5)` under the row's name (Switch, SettingRow, Checkbox, Row). Rejected: 4 px everywhere, which would grow every settings row by 2 px with no gain.
8. **D-261030-487, empty states.** `Empty` keeps its own `space(2)` padding under a section label. Rejected: trimming it, which would change every panel's empty state.
9. **D-261030-488, what the check tests.** Names, section labels, settings sections and headings, the kinds where the audit found and fixes issues. Card insets and section gaps are measured in the audit, not tested, since centered tiles, touch rows and expanding cards would flag noise. Rejected: one check over every measured kind.
10. **D-261030-489, FEATURES.md.** No line describes these gaps, so the lanes add none. Rejected: a new line naming spacing, which is not a feature.
11. **D-261030-492, a help line inside a card group.** It keeps `space(1)` under the name and stands `space(2)` over the first card, so the cards always stand further from what heads them than from each other. Rejected: 4 px from the help to the cards, which would bring back the crowding under a help-led group.
12. **D-261030-493, both forms of the cards.** The radio group form (Players see) takes the same 8 px as the fieldset form. Rejected: changing only the fieldset form, which would leave two gaps for one component.
13. **D-261030-494, the sweep's new roots.** Only the pairing page and the import dialog join the sweep, the two screens outside it with a finding. The rest of 3.5 was measured once and has none. Rejected: a root for every screen of 3.5, which would add minutes to every run for screens with nothing to hold.
14. **D-261030-495, the pairing code's label.** `space(1)` over its field, as every `Field`. Rejected: keeping the form's `space(3)`, which sets this one label apart from Home's and Join's.
15. **D-261030-496, the import's light choice.** Its name at 16 px weight 600, as Players see's above it and every other choice name. Rejected: 14 px, which reads as a lesser heading in one dialog.
16. **D-261030-497, Home's and Join's titles.** The title and its tagline stay one tight block (about 1 px between the lines), as a row's name and its help. Rejected: a gap under the title, which would split the crest's block.
17. **D-261030-498, named choices that are not card groups.** A `Segmented` choice's name (Sight, Light, for party vision, Grid shape) keeps `space(1)` over its buttons. The coordinator's 8 px is for bordered card groups. Rejected: 8 px for every named choice.

## 9. As built

Filled in by each lane's docs commit.

### Lane 1, kit, This device and the check

### Lane 2, panels
