# raccoon-vtt v1: the second look pass

Status: draft 3, for design review. Revised after design review rounds 1 and 2 (Opus LP2-1 to LP2-21, astra LP2-ASTRA-01 to 05, every finding adopted). Section 5's questions are decided. Code is cited from main at `b7b94f1d`.

The first look pass (docs/design-v1-look-pass.md, "the first pass") made the app's screens one product. Since it shipped, movement and walls, attached tokens, triggers and traps, the D&D Beyond re-sync, the docked token window with the alerts lane, the roll animation, pasting images and a Druid's known forms each landed on their own, wave by wave. This pass makes their screens follow the same visual system, and checks that the screens the first pass fixed still do.

The project owner's words still set the bar. On 2026-10-14: "in general we should also do a design review pass of the entire app once done with all waves and try to make the app look consistent and unified/sleek while not sacrificing functionality". On 2026-10-18: "these aren't necessarily hard rules either i just want things that make sense given a design review". On the dice: "The dnd beyond look was mainly around the dice everything else can be relative to have we've decided before". So the dice keep their rich look, and the tray's frame and every other screen follow the existing system. The accent stays the viewer's member color in a room and the crest yellow `#f7df00` outside one. The old orange never returns as an interface color. No art is generated. Anything slow shows that it is loading.

This pass adds no token. It adds the rules the new screens need in three places (2.7 choices and settings, 2.8 panes and the alerts lane, 2.11 board text), one small part in Row.tsx and a few options on existing components (2.5, 2.7).

Screenshots: `screenshots/look-pass-2/`, kept outside the repository. Three sources:

- The dev room, with `attach=1`, `attach=riding`, `pcstats=1`, `rolls=1` or `ask=save` where a name says.
- A real room on the production build ("Look pass two"): Thorn, two goblins, a band of difficult ground, a wall, a Hidden Pit made with the Trap tool, and traps made for each shot by ops. Its player, Pat, plays Thorn.
- Four e2e files run with shots, each in its own folder: `e2e-resync/`, `e2e-pcstats/`, `e2e-dice/` and `e2e-paste/`. Their shots are 1280 x 800 on a computer unless the name says a size.

Sizes in names: `p390` is 390 x 844 on touch, `p360` 360 x 740, `p320` 320 x 568, `l844` 844 x 390 (a phone held sideways), `p390-130` 390 x 844 at 130%, `t820` an 820 x 1180 tablet, `d1440` 1440 x 900 with a mouse. The dev room's "Fixture" button at the top left is not part of the app.

## 1. Audit

Severity: **P1** looks broken. **P2** is inconsistent with the rest of the app. **P3** is polish.

Counted: 3 P1, 18 P2, 19 P3, of which review dropped D25. The three P1s are in traps: the pane drawn as a card goes under the fight's alerts, one of its choices runs past its edge, and trap names land on creatures' names. Most of the drift is in the trap pane and the Attach list, built after the first pass and on their own kits. The re-sync review, the roll tray and the first pass's own fixes hold.

### 1.1 P1 and P2

| # | Finding | Screenshots | Code | Sev |
|---|---|---|---|---|
| D1 | From 600 px up, a map pane drawn as a card beside its thing (the trap pane here, and the label, pin and light panes share its placement) goes under the alerts column. The cards cover its header, Close and folds, so a trap that goes off while its pane is open hides the pane's controls. On a phone the pane is a sheet and folds the column into a row on its edge, so phones are fine | `trap-d1440-pane-open`, `trap-t820-pane`, `trap-l844-pane`, `trap-l844-sprung-pane-open` | features/builder/labelEdit.ts:174-194 (panePlacement knows no lane), pages/RoomDock.tsx:147 (usePaneDock folds the column for a sheet only), canvas/barDock.ts:616-668 (the lane rule the token window follows) | P1 |
| D2 | The trap pane's Afterwards choice "Arms again at the start of the next turn" is one line of about 294 px in a 270 px card body. It runs past the card's edge and the pane scrolls sideways (299 px of content in 294) | `trap-d1440-pane-afterwards`, `trap-l844-pane-afterwards` | features/traps/TrapPane.tsx:254-263, its grid at :218 lacks the `minmax(0, 1fr)` the label and pin panes use (LabelPane.tsx:152, PinPane.tsx:210) | P1 |
| D3 | Trap names are drawn on the board outside the label pass, so a token beside a trap has its name and HP drawn over the trap's name ("Pois30/30arts"). Area names and the move marker publish their pills and token labels keep off them | `trap-d1440-dm-hint-for-p390`, `ruler-p390-130-walk-done` | features/traps/TrapLayer.tsx:121-129 draws its Pills and publishes none, against features/areas/TemplateLayer.tsx:147 (`usePublishPills`) and canvas/useBoardText.ts:77 | P1 |
| D4 | The Attach list's rows are hand-made buttons in Row's card look, with less padding (4/8, Row 8/12), a 400 title (Row 600) and a 360 px cap, so in a sheet 392 px or wider and in the card from 600 px they stop short of the right edge. The Ride row unfolds its question under itself with no chevron and wears the chosen tint while open. The pop-up is titled "Attach", the sheet "Attach Thorn" | `attach-p390-list`, `attach-l844-ride`, `attach-t820-list`, `attach-d1440-list` | features/attach/AttachButton.tsx:59, :75, :166, :179-197, :221, :233-250 | P2 |
| D5 | Ride's question is a Segmented of two sentences with `wrap`: "Controlled: moves on Thorn's turn" and "Independent: keeps its own turn" stack as two pills of different widths, in the Attach list and again in the rider's token panel header, between the tags and the quick numbers | `attach-p390-ride`, `riding-p390-panel`, `riding-d1440-panel` | AttachButton.tsx:201-209, features/attach/SteerControl.tsx:43-53 | P2 |
| D6 | "No room to get off." sits inside Get off's slot in the play row, so the row's buttons stretch to about 62 px and Get off widens to the note | read from code | features/attach/BarParts.tsx:40-49, canvas/TokenActionBar.tsx:115 | P2 |
| D7 | The alerts opened over the screen draw their own header: a 49 px row, a 16 px h2, and Close as a raised outlined Button. Every other sheet and dialog has SheetHeader with the 44 px icon Close | read from code (the dmphone e2e shots at 480 x 320) | features/encounter/InitiativeStrip.tsx:955-973, OVERLAY_HEAD :1073 | P2 |
| D8 | The trap pane mixes Checkbox and Switch for settings that apply at once ("Small or larger only" and "Opens a pit" are checkboxes beside the Stops and Marks itself found switches). Hits is a radio group drawn as checkboxes, and the chosen one is natively disabled, so it reads unavailable and drops focus. The last trigger left is disabled the same way, with no reason | `trap-p390-pane-open`, `trap-d1440-pane-hits` | TrapPane.tsx:239, :249-250, :265-269, :541-545, :824-836 | P2 |
| D9 | The trap pane's Who choice (Party creatures, Other creatures, Any creature) goes two over one at every width | `trap-p390-pane-open`, `trap-p390-130-pane-open` | TrapPane.tsx:248 | P2 |
| D10 | In the trap pane, removing a damage part, a check or an effect is a secondary button with the trash can, not the danger look the app gives every remove. Conditions on a fail are hand-made pills with a cross, where the group save uses removable Chips | `trap-p390-pane-foot` | TrapPane.tsx:630, :639-643, :760, :802, against features/dice/groupSave/GroupSave.tsx:786 | P2 |
| D11 | Arming a trap with no uses left shows a raised box whose Arm is primary, beside the pane's primary Done | read from code | TrapPane.tsx:370, :472-476 | P2 |
| D12 | The trap pane's Save and damage differ from the group save they fill: "Half on a pass" and "None on a pass" with no row label, the DC as a loose muted span, and a bad damage formula shown only by a red outline with the reason in a native title | `trap-p390-pane-foot` | TrapPane.tsx:604-618, :693-706, against GroupSave.tsx:375, :759, :771-781 | P2 |
| D13 | Clearing the trap's name sends nothing: the field stays empty while the trap keeps its name, and no line says why | read from code | TrapPane.tsx:224, :391-395, against LabelPane.tsx:179 | P2 |
| D14 | Fixed-size board readouts (ruler legs and totals, the drag label, the move marker, "Crosses Hidden Pit") keep their 100% size at 130%, while names, chips and map pills grow with the interface size (docs/design-v1-dm-tools.md 3.16). They also slide back only to the canvas edge, which runs under the top bar and the toolbar | `ruler-p390-130-walk-done` against `ruler-p390-walk-done` | features/measure/Pill.tsx:41-43, :69-73, canvas/Stage.tsx:1292-1295 | P2 |
| D15 | Stacked drag pills (the label, "Ends in Goblin 2's space", "Crosses Hidden Pit") each slide into view on their own, so at the screen's edge the shorter ones clamp onto the label | read from code | features/measure/RulerLayer.tsx:283-285, :314-315, features/traps/Crossing.tsx:31 | P2 |
| D16 | A walking ruler's total disappears each time a search starts, and its legs turn grey at once, so it blinks while dragged on a large map. The options line shows the hint sentence for up to 200 ms each time. A drag keeps its last reading and greys only past the shared 200 ms | read from code, `ruler-p390-walk-live` | RulerLayer.tsx:188, :204-206 against :266-271, features/measure/RulerTool.tsx:210-216, :238 | P2 |
| D17 | A kept ruler's row removes it with the close cross after its words, where the icon rules give a ruler's removal the eraser before the words, and its rows center their words where ⋯'s other rows start them at the left | read from code | features/measure/KeptRulers.tsx:67-78, features/measure/controls.tsx:877, :892 | P2 |
| D18 | The D&D Beyond step's "Read it" is primary in the body while the footer's "Get it" is primary too, once the JSON box is open (re-sync and the editor share it) | `e2e-resync/009-resync-private` | features/pcstats/PcStatsEditor.tsx:532, used by Resync.tsx:298 and PcStatsEditor.tsx:322 | P2 |
| D19 | The panel's Known forms section has no Change. In Wild Shape, Take a shape is hidden, so a druid in a shape has no way to change her forms without ending it. The first pass's 5 gave the section a Change in its action slot | `e2e-pcstats/013-pcstats-known-forms-panel` | features/pcstats/PcStatBlock.tsx:53, :130 | P2 |
| D20 | "Use the pasted image" offers its choices as block secondary buttons with a help line under each, not the card Rows (a title and a detail) the first pass's 5 set | `e2e-paste/009-paste-room-offer` | features/images/RoomPaste.tsx:185-193 | P2 |
| D21 | A paste's errors come in three looks: 13 px `dangerText` in PasteStatus, `ErrorText` at 14 px in the image and stamp pickers, and a warning `Note` for a scene's and a phase's upload errors, whose paste refusal is red | `e2e-paste/014-paste-player-box` | features/images/PasteImage.tsx:116-123, ImagePicker.tsx:220-229, builder/stamps/StampPicker.tsx:106-111, scenes/SceneSettings.tsx:496, phases/PhasesSection.tsx:144, scenes/NewScene.tsx:317 | P2 |

### 1.2 P3

| # | Finding | Code |
|---|---|---|
| D22 | Trap pane words: "At most N times" beside a prompt and summary that say "uses". The option says "Arms again at the start of the next turn", the summary "Arms again each turn". Empty summaries say None, Nothing or No checks. "Opened: its floor is at -10 ft" uses a hyphen. Rounds has no unit. The Name group's summary repeats the pane's title | traps/rules.ts:437, :447, :465, :477, TrapPane.tsx:223, :294, :314, :325, :450-463, :671 |
| D23 | Trap pane layout: its groups sit 8 px apart where the token panel stacks them. Raw widths 96 and 112. "Add squares" sits in Afterwards and lacks the plus that Add damage has. "Add: tap a door, light, creature or stamp" puts the tool's instruction in the label. "Its door is gone" is muted help, not a warning Note. Set it off's explanation is a native title only | TrapPane.tsx:218, :221, :279-283, :316-318, :353, :551-553, :705 |
| D24 | The trap card's "Could not" lines are colored by a string prefix, and the hidden-springing line is muted | features/traps/TrapCard.tsx:86-92 |
| D25 | A square trap takes no tap slop, so a one-square trap zoomed out is under 44 px, while a wire and a door get 22 px. Dropped in review: slop would take taps on the free cells beside it, which start new traps | traps/rules.ts:201 |
| D26 | The toast "The open group save holds rolls. Its card's Save and damage asks before it is discarded." is hard to read | features/traps/useTrapAlerts.ts:55 |
| D27 | The time-up and effect-ended cards are whole-card buttons with `role="status"`, so a reader loses the button and a tap dismisses with no visible cue | InitiativeStrip.tsx:1022-1046 |
| D28 | The dock: its buttons in a sheet's header are a hand-made pill, the alerts summary has no chevron where Show beside it has one, and the summary's advice says "Hide the bar" while the frame names itself a window | pages/RoomDock.tsx:113, :255-303, :340-355, pages/fold.ts:181-206 |
| D29 | The ruler's options line: "Finding the way…" is bare text where `Loading` pairs it with a spinner, the diagonal rule follows the hint sentence too, and a cut line becomes a 34 px button | RulerTool.tsx:215, :242, controls.tsx:778-800 |
| D30 | The hold mark draws its own red ring at a fixed 3 px where every other outline scales with the map, and its label's offset is fixed | features/movement/MoveLayer.tsx:47-60 |
| D31 | StopNote wraps its title by hand with raw sizes (288, 12, -16), Teleport here explains itself only in a native title, and GroundNotice draws its own 14 px warning line | features/movement/StopNote.tsx:19, :67-68, :107-118, GroundNotice.tsx:28-29 |
| D32 | Pill's radius is a literal 6. A drag with no speed band takes the member color, which for the DM is the crest yellow of the Dash band | Pill.tsx:91, RulerLayer.tsx:136, :144, :268, :305 |
| D33 | The Attach list: "Farther away" is a div in the label look, neither heading nor group. The empty list is drawn by hand. The pop-up's button shows no open look. Get off's native disabled hides it from keys | AttachButton.tsx:47-58, :164-173, :225, BarParts.tsx:41 |
| D34 | Attach words: the bar says "On Warhorse" where the panel and the tracker say "Riding Warhorse". A holder's line heads drags with "Carrying" and repeats each name ("Saddlebag", "Put down Saddlebag"). "Let go" also names the group window's Close ("Let go of all of them"), which deselects | features/attach/groups.ts:289, tags.ts:25, BarParts.tsx:77-92, detach.ts:56-57, TokenActionBar.tsx:507-509 |
| D35 | Re-sync: its sections are hand-made (no `Section`), kept rows and "Replaces your changes" rows have different spacing, a group row's chevron is `sm` in text color where the companions' is `md` muted, the done line wears the chosen check, the editor's review Back is named "Back", and the link field's label is hand-made | features/pcstats/SyncReview.tsx:71-78, :200, :226, :267, Resync.tsx:428-431, PcStatsEditor.tsx:361, :491-510, :580-597 |
| D36 | Take a shape: the refusal is a hand-made 13 px alert, the known forms count is 14 px over a 13 px Note, and two spacings sit on one page | features/pcstats/ShapePicker.tsx:123-127, :217, :265, :285 |
| D37 | Dice: Again is 40 px tall, the tray's scrim rounds its top corners under the header line's straight edge, the "+N" disc's text grows with the interface size inside a fixed disc, "Rolling…" draws its own spinner, and the dice set picker's chosen tile loses its mark while the switch is off | features/dice/Roller.tsx:100-104, :149, dice/throw/Tray.tsx:108, :167, features/device/DiceSetPicker.tsx:44-45 |
| D38 | Paste: the offer's file name is 14 px and its preview a raw 96, the paste box's line sits inside it like a placeholder, Paste an image keeps its words while busy, three entries wait with `Help` and two with `Loading`, and its words use straight apostrophes | RoomPaste.tsx:168-172, PasteImage.tsx:101-103, :184-201, NewScene.tsx:315, SceneSettings.tsx:493, PhasesSection.tsx:141, handouts/HandoutsSection.tsx:479, roomPaste.ts:95, :105, StampPicker.tsx:276-284 |
| D39 | The shared "Scroll for more" lives in canvas/TokenActionBar.tsx and fades to `surface`, so over the alerts column's raised cards it paints a darker band | TokenActionBar.tsx:1235-1270, InitiativeStrip.tsx:1048 |
| D40 | The token window's conditions tiles, effect pills and elevation width are hand-made (radius `sm`, a 2 px outline, a raw 56) | TokenActionBar.tsx:380-400, :419, :522, :1296-1322 |

### 1.3 Checked

- **Consistent.** The drag's Speed bands, cost note and "Crosses Hidden Pit" (one `Pill` for every board readout, tones from the theme, words with every color), the walking ruler and the Measure chip with its short words, the trap tool's row and Start from, the trap's map looks, the trap card and toasts (the shared card and ToastNote, one primary), players' trap lines as toasts and log rows, the found trap's warning look, the Passive Perception hint toast, the Outliner's Traps group, the re-sync review and its states (one primary per state, busy words, Notices, `Row` with `expanded` for groups), the roll tray (the dice keep their look, the frame is `surface` at 92%), known forms in the panel and in Take a shape, the paste buttons and box, and the alerts lane with its summary rows.
- **The first pass holds.** The character's page and its forms (L1 to L5), the window's units (L6), the tablet sheet at 560 px (L7), the Library's Try again (L8), the monster filters' chevrons (L9), Join under the crest (L10), the alerts column's "Scroll for more" whenever it is cut (L18). Shots: `drift-*`.
- **The drift scan** (`scripts/style-drift.ts`): 0 drift test findings, 90% of font sizes and 92% of spacing from tokens (89% and 91% at the first pass).
- **Read from code, not seen**: D6, D7, D11, D13, D15 and D17, the hidden-springing card (Do its effects, Mark sprung), which needs a player's op the room cannot stage, and the other-scene trap toast with Show.
- **Left as they are**: D39 crosses two lanes' files and D40 is the token window the first pass found consistent, so both wait for a later pass.

## 2. The visual system as it stands

The system is the first pass's 2.1 to 2.11 over the visual design (docs/design-v1-visual.md). Tokens stay as client/lib/theme.ts has them. Below, each part says what exists, where the new screens drift, and the rule they follow. 2.7, 2.8 and 2.11 add rules. One small part is added in Row.tsx (`RowChevron`, 2.5). `Row`, `Segmented` and `Checkbox` gain options (2.5, 2.7), and `panePlacement` and `Pill` each gain one input.

### 2.1 Colors, type, space, radii

- Unchanged. No new color: traps use `danger` for armed, `warning` for found and crossing, `textMuted` for sprung, as their design said.
- Drift: raw widths and radii in the trap pane (D23), StopNote (D31), Pill (D32) and paste (D38). Each takes the token of the same value or the field width `theme.layout.options.field`.

### 2.2 Buttons

- One primary per view, the action that finishes it. Drift: the uses prompt's Arm (D11) and the D&D Beyond step's Read it (D18) become secondary `sm`.
- Every remove and delete has the danger look (`variant="danger"`, design.md 14.4). Drift: the trap pane's removes (D10).
- A busy button names its wait ("Pasting…", D38) and refuses a second tap.

### 2.3 Icons

- Unchanged vocabulary. `close` closes and never removes: a kept ruler's removal takes `eraser` before its words, as Clear does (D17). `check` means chosen, so the re-sync's done line drops it for a plain status line (D35).

### 2.4 Chips and tags

- A removable choice is a `Chip` with its `remove` form in a `ChipRow`, as the group save's conditions (D10).

### 2.5 Rows

- A list of actions in a sheet or a pop-up is a list of card `Row`s with a leading portrait or preview, a title and a detail line: the Attach list (D4) and "Use the pasted image" (D20).
- A row that unfolds a short body under itself keeps its own look with a chevron at its end, down while open, never the chosen tint (D4, the Ride row).
- `Row` gains three small options and one part. `wrapTitle` lets a title wrap where it names an action that must read whole ("Get on Treasure chest" on a 320 px phone). `busy` sets `aria-busy` on its button. `data` puts `data-*` attributes on its button, which the Attach list's keys find its rows by (`data-attach-row`). `RowChevron` is the end chevron that SyncReview, CompanionBlocks and the Attach list then share (`md`, muted), so every unfolding row draws the same one (D4, D35).

### 2.6 Folds and groups

- Unchanged. `Group`s in a pane or a panel stack with no gap between them, their lines doing the separating (D23).

### 2.7 New: choices and settings

The new screens picked their controls one by one, and the trap pane holds four kinds for two jobs. One rule each:

- **A setting that takes effect at once is a `Switch`** named by the setting at 16 px, with its help under it. Checkbox.tsx already says so. So "Small or larger only", "Only creatures on the floor", "Opens a pit", the hint and "With a check" become Switches (D8). Once its pit has opened, "Opens a pit" stays natively disabled with its "Opened: its floor is at −10 ft." line under it, as today: an opened pit cannot be undone, and the last-tick rule below is for a pick of several.
- **Two ways of one thing, where one is the plain case, is a Switch for the other case.** "Goes off once" against "Arms again at the start of the next turn" becomes the Switch "Arms again at the start of the next turn", off by default (D2).
- **One choice of a few short words is a `Segmented` with `even`**, one or two words an option, so options share the row and never stack. What the chosen option means goes in a `Help` line under the group, which follows the choice and is the group's description: `Segmented` gains `description`, rendered as `aria-describedby` on its radiogroup. So Ride's question reads "Controlled" and "Independent", with "Warhorse moves on Thorn's turn." or "Warhorse keeps its own turn." under it (D5), and Who reads "Party", "Others" and "Any" (D9). The trap's summaries keep the long words ("by party creatures, on the floor"), since they are sentences.
- **One choice of longer names is `ChoiceRows`**, 44 px rows with a check on the chosen one. Hits takes it (D8). An arrow key both moves and chooses in a radio group, so no choice starts the map pick or the area tool. Choosing writes only what needs no map: "The creature that set it off" and "Everyone on the trap" write their kind, "Everyone in these squares" writes the trap's own squares as today's choice does, and "Everyone in an area" writes nothing until "Place the area" saves one, the radio holding the choice until then. The pick and the aim start from the buttons that already follow the choice, "Draw them again", "Add squares" and "Place the area", and the area's placement and save rules stay as they are.
- **A `Checkbox` is for a pick of several** (the triggers) **or a review's tick** (re-sync's Also set). A pick that cannot be left empty keeps its last tick with `aria-disabled` and a `Help` line saying why, never native `disabled`, which drops focus: `Checkbox` gains `aria-disabled`, whose activation does nothing and keeps focus where it is (D8, and D33's Get off on a `Button`).

### 2.8 Sheets, dialogs and panes

- Unchanged: `Sheet`, `Dialog` (`fill`, `sheet`), the 560 px tablet sheet, `SheetHeader` on every sheet and dialog. Drift: the alerts over the screen take `SheetHeader` with `compact` (D7).
- **New: a map pane and the alerts lane.** The bar dock design (1.3) gave the docked token window a rule for the right lane: stacked under the first card, else beside the lane, else the column as one summary row. A map pane drawn as a card (label, pin, light, trap) follows the same lane, without the stacked step, since a pane stands by its thing:
  1. **Beside.** While the column shows a card, a pane card keeps left of the lane: its right limit is the lane's left edge less the 8 px margin, where the free width left of the lane holds the pane (296 px and its margins).
  2. **Summary.** Where it does not, the column shows its own 44 px summary row at the lane's top in place of its cards, as it does beside a docked window, and the pane keeps under that row where it meets the lane across. The column is not folded: a fold would remove that row. The row's advice is the pane's, "Close the pane to answer.", "… to see them." or "… to see it.", and its tap closes the pane, then shows the alert and puts focus on it, as the row on a sheet pane's edge does. When the token window wants the summary at the same time, the column still draws one row, and the pane's words win.
  3. A phone's sheet pane keeps today's row on its edge (bar dock 1.3, fu20b).

  So a trap that goes off while its pane is open leaves the pane's header, Close and folds in reach, and its card in view or one tap away.

### 2.9 Empty, loading and error states

- Unchanged: `Empty`, `Loading` after 200 ms, `LoadFailed`, `Notice`, `ErrorText`.
- Drift: a field's error is `ErrorText` under its row, never only a red outline or a title (D12), a cleared required field says why it went back (D13), every paste error is `ErrorText` and its info line `Help` (D21), every wait is `Loading` with the default delay (D29, D37, D38), and a reading that is being worked out keeps its last value until the 200 ms pass (D16), as a drag's label does.

### 2.10 Numbers, units and words

- Unchanged. One word for one thing: "uses" in the trap pane (D22), "Riding Warhorse" wherever a ride is named (D34), "window" for the token window (D28). Units in muted text after the number ("rounds", "ft deep"). A true minus: "−10 ft".
- An action never repeats the name its row already shows: a holder's line reads "Saddlebag" then "Put down", named "Put down Saddlebag" for a reader (D34).

### 2.11 New: board text

design.md 14.2 places token labels in one pass and keeps them off other layers' names. Traps came after and stayed outside it. Two rules:

- **Every name drawn on the board joins the pass.** A layer that draws names publishes them as pills (`usePublishPills`, canvas/boardView.ts), as areas do, so token labels keep off them (D3). Trap names hide where a creature's name hides, as today.
- **Readouts stay one size at every zoom, but follow the interface size**, as every other board text does since dm-tools 3.16. `Pill`'s screen size multiplies by the interface scale, through one `screenPx()` beside `boardSizes` in lib/boardScale.ts, applied inside `pillGeometry`, so the boxes token labels keep off are the boxes drawn (D14). Readouts keep inside the part of the map the bars leave clear.
- **A stack of readouts is one box.** The label and its warnings are measured together, the widest width and the total height with the gaps, clamped as one box and moved by one translation, so no warning leaves the screen at an edge (D15).

## 3. The fixes

Three lanes, each one builder in its own workspace, all starting from one prerequisite commit (lane 0) on the newest stacked tip. No lane changes a protocol, an op, stored data or a snapshot, and no feature is removed. The lanes own disjoint files, e2e files included, so they run in parallel. FEATURES.md and docs/dm-guide.md are the one exception: each lane edits its own lines of them (3.2).

| Lane | Fixes | Commits, in order | Files it owns |
|---|---|---|---|
| 0. Prerequisite | the description 2.7 gives Segmented | `feat(ui): a choice can name its description` | components/Segmented.tsx, its cases in components/controls.test.ts. Built and merged before lanes 1 to 3 start, since lanes 1 and 3 both use it |
| 1. Traps, panes and alerts | D1, D2, D7 to D13, D22 to D24, D26 to D28 | `fix(panes): a map pane keeps out of the alerts lane`, `fix(traps): the pane's choices fit its card`, `refactor(traps): the pane's settings follow the panel kit`, `fix(traps): the pane's save and damage read as the group save's`, `fix(alerts): one header and one look for the alerts' rows`, `docs: the second look pass, traps and alerts` | features/builder/labelEdit.ts and its test, LabelPane.tsx, LabelPaneHost.tsx, features/pins/PinPane.tsx, PinPaneHost.tsx, features/lights/LightPane.tsx, LightPaneHost.tsx, features/traps/TrapPane.tsx, TrapPaneHost.tsx, components/Checkbox.tsx and its cases in components/controls.test.ts, TrapCard.tsx, rules.ts and its test, useTrapAlerts.ts, pages/RoomDock.tsx, pages/fold.ts and its test, canvas/barDock.ts and its test, features/encounter/InitiativeStrip.tsx, e2e/traps.e2e.ts, e2e/dmphone.e2e.ts, e2e/fold.e2e.ts, e2e/bardock.e2e.ts |
| 2. Board text and rulers | D3, D14 to D17, D29 to D32 | `fix(traps): trap names join the board's label pass`, `fix(board): readouts follow the interface size and keep clear of the bars`, `fix(ruler): a walking ruler keeps its reading while it searches`, `fix(ruler): kept rulers' rows follow the options kit`, `fix(movement): the stop note and the hold mark use the kit`, `docs: the second look pass, board text` | features/traps/TrapLayer.tsx, features/traps/Crossing.tsx, features/measure/Pill.tsx, RulerLayer.tsx, RulerTool.tsx, KeptRulers.tsx, controls.tsx, their tests, client/pages/optionsLayout.test.ts, canvas/Stage.tsx, canvas/useBoardText.ts, lib/boardText.ts and its test, lib/boardScale.ts and its test, features/movement/MoveLayer.tsx, StopNote.tsx, GroundNotice.tsx, e2e/options.e2e.ts, e2e/options-dm-100.e2e.ts, e2e/vision.e2e.ts |
| 3. Attach and dialogs | D4 to D6, D18 to D21, D33 to D38 | `feat(ui): rows that wrap their title and share one chevron`, `fix(attach): the Attach list is a list of rows`, `fix(attach): Ride asks in two words and says what they mean`, `fix(attach): the bar's attach words match the panel's`, `fix(pcstats): one primary in the D&D Beyond step, and the re-sync's sections`, `feat(pcstats): Change in the panel's known forms`, `fix(images): the pasted image's offer, errors and waits`, `fix(dice): the tray's frame and the header line`, `docs: the second look pass, attach and dialogs` | components/Row.tsx and its test, features/attach/AttachButton.tsx, SteerControl.tsx, BarParts.tsx, groups.ts, detach.ts, tags.ts and their tests, canvas/TokenActionBar.tsx, features/tokens/CompanionBlocks.tsx, features/pcstats/SyncReview.tsx, Resync.tsx, PcStatsEditor.tsx, PcStatBlock.tsx, ShapePicker.tsx, features/images/RoomPaste.tsx, roomPaste.ts, PasteImage.tsx, ImagePicker.tsx, features/builder/stamps/StampPicker.tsx, features/scenes/NewScene.tsx, SceneSettings.tsx, features/phases/PhasesSection.tsx, features/handouts/HandoutsSection.tsx, features/dice/Roller.tsx, dice/throw/Tray.tsx, features/device/DiceSetPicker.tsx, e2e/attach.e2e.ts, e2e/groupsave.e2e.ts, e2e/resync.e2e.ts, e2e/pcstats.e2e.ts, e2e/paste.e2e.ts, e2e/dice.e2e.ts, e2e/size.e2e.ts |

Docs, the exception to disjoint files: each lane's last commit edits FEATURES.md and docs/dm-guide.md for its own words only (3.2), never mixed into a code commit. Lane 1 owns FEATURES.md 53 and 260 and dm-guide.md 928 to 943, lane 2 FEATURES.md 197 to 200 and 446, lane 3 FEATURES.md 142, 146 and 361 and dm-guide.md 859, 881 and 1046 to 1048, so the hunks never meet.

Notes per lane:

- **Lane 1.**
  - D1: `panePlacement` gains `lane: { left: number; top: number } | null`, the lane's box while the column shows a card, read from the column's published facts (the slot the token window reads, bar dock 1.3 "Measuring"). Those facts are already in zoomed layout px: Room.tsx:690-693 divides the chrome by the zoom before publishing it, and InitiativeStrip.tsx:777-780 divides the card measures. The panes work in the same space (`insetsInZoomed`, Stage.tsx:1374-1377), so the lane goes into `panePlacement` as stored. Only a value measured in screen px is divided by the zoom (Stage.tsx:338-339 multiplies by it only for its own coverage check). A pure `paneLane()` beside `laneChoice` in barDock.ts decides beside or summary, so it is tested without a page.
  - Beside: the card keeps its right edge at `lane.left − 8` where the room left of the lane holds `PANE_WIDTH` and both margins. Summary: the card's top limit drops below the row where it overlaps the lane across, and the card publishes `paneLane: { lane: "beside" | "summary"; close(): void } | null` in the dock store (fold.ts `DockState`, beside `bar`), clearing it on close and on unmount. `usePaneDock` and `useFoldUnderPane` stay for sheets only, since a fold removes the column's row.
  - A pure `summaryFor({ paneLane, barLane })` in pages/fold.ts decides whose row the column draws: the pane's (`SummaryHides` `"pane"`), the bar's, or none, the pane's winning when both want it. FightAlerts' `summarized` calls it. The row's tap runs `paneLane.close()`, then shows the alert and focuses it through `showAsk`, as `PaneDockRow` does.
  - The four panes and their hosts (LabelPaneHost, PinPaneHost, TrapPaneHost, LightPaneHost) read the lane from the store, never through Stage's props, which are lane 2's. A host's loading frame is placed with the lane too, so it does not jump when the pane arrives.
  - D2: the Switch of 2.7 and `gridTemplateColumns: "minmax(0, 1fr)"` on the pane's grid, so nothing in it can widen the card again. D8, D9: 2.7, with Who's short words in a map of their own beside `WHO_WORDS`, which the summaries keep. Hits' radios write as 2.7 says (`HitsChoice.start` no longer starts the pick or the aim). Checkbox's `aria-disabled` holds the last trigger. D10: `ChipRow` with `Chip remove`, danger removes named "Remove this damage", "Remove this check", "Remove this effect". D11: Arm secondary, the box dropped for its Help line and buttons. D12: `FieldRow` "On a pass" with Half and None, `FieldRow` "DC", and `ErrorText` under a bad formula. D13: an empty name goes back to the saved one with a `Note` "A trap needs a name.", as the label pane does.
  - D7: the overlay's header is `SheetHeader` `compact` with `closeLabel="Close"`, inside a wrapper that keeps today's safe-area padding (`theme.safe.mapRight`, `theme.safe.left`), and `OVERLAY_HEAD` follows its height, since barDock's `askedAlerts` reads it. D27: those cards keep their text as a status and gain a quiet Dismiss. D28: the summary's advice reads "Hide the window to answer." and its kin, the pill becomes `Button` `sm`, and the summary ends in the chevron Show has.
  - D24 and D26 as 1.2 says. D25 is dropped: a one-square trap grown to 44 px would take taps on the free cells beside it, which start new traps.
- **Lane 2.**
  - D3: TrapLayer publishes each drawn name with `usePublishPills(\`trap:${id}\`, …)`, and `useBoardText` already keeps labels off published pills. Nothing in lib/boardText.ts changes unless its test shows a case the pills' boxes miss.
  - D14: `screenPx(designPx)` in lib/boardScale.ts multiplies by the interface scale, applied inside `pillGeometry` for size, padding and pointer, so `useBoardText`'s obstacles (built from `pillPlace` and `pillGeometry`, useBoardText.ts:77-80) match what is drawn. Stage's `boardView` is the canvas less `props.insets`, so a readout slides back inside the bars.
  - D15: a `PillStack` in Pill.tsx measures the drag's pills together, clamps the stack's box (the widest width, the total height with gaps) and moves them by one translation. Crossing.tsx exports the crossing words as a hook RulerLayer calls, so the parent knows the stack before it draws.
  - D16: a leg greys and "Finding the way…" shows only once `slow` (the shared 200 ms), the total and the options line keep the last walk meanwhile. D17: each kept ruler's remove is `OptButton tone="danger" icon="eraser"` with its words after, and the rows take the left-aligned row style ⋯ uses.
  - D29 to D32 as 1.2 says. The no-band drag line takes `theme.color.text`, and the ruler keeps the member color.
- **Lane 3.**
  - D4: the list is `Row`s with `onClick`, `leading` a 32 px portrait, `wrapTitle`, `busy` for the delayed busy state and `data` for `data-attach-row`, so Up, Down, Home and End keep working across the near rows and "Farther away". The cap applies to the pop-up only (`theme.layout.sidePanelWidth`), so rows span a sheet and a card. The Ride row ends in `RowChevron`, and one title, "Attach Thorn", names both forms. D33 rides along: `SectionLabel` heads "Farther away" over a named group, `Empty` and `Help` draw the empty list, the pop-up's button takes `expanded`, Get off takes `aria-disabled`.
  - D5: 2.7. The radios are named "Controlled" and "Independent", and the `Help` line is the group's description. D6: the note becomes a `Help` line on its own row under the play row, so no button stretches.
  - D34: the bar's group line takes the panel's words, "Riding Warhorse". A holder's line reads "Carrying Bree, Torch" and "Dragging Goblin 2", each action a short "Put down" or "Let go" named in full. The group window's Close is named "Deselect all".
  - D18, D35: Read it is secondary `sm`. The review keeps its `SectionLabel`s, whose id, `tabIndex` and focus handling the re-sync's focus rule needs, and only takes `Section`'s spacing. That is smaller than teaching Panel.tsx's `Section`, used across the app, three new props.
  - D19: in Wild Shape, for a viewer who may edit the character, the Known forms section shows even with no forms. Its action reads "Choose known forms" at zero and "Change" otherwise, as Take a shape's does (ShapePicker.tsx:270-272), and opens the choose step. Opened from the panel, the step has no `back` at all, so its Close is the one way out, and no state of it reaches "Back to the creatures", not even after a refusal, since a druid in a shape takes no other shape here. The picker's open state lives in `PcStatBlock` beside `picking`, so removing the last form does not unmount the dialog in the user's hands.
  - D20, D21, D38: the offer's choices are `Row`s with the preview's name at 16 px, PasteStatus draws `ErrorText` and `Help`, the scene's and the phase's upload errors take `ErrorText`, every wait is `Loading`, Paste an image reads "Pasting…" while busy. D36, D37 as 1.2 says, the "+N" disc's text taking the tray's own `px(theme.font.input)`, as its box does (Tray.tsx:123, :156-167).

### 3.1 Names and roles that change

Everything not listed keeps its role and accessible name.

| Control | Today | After | e2e |
|---|---|---|---|
| Ride's question (Attach list, token panel) | radios "Controlled: moves on Thorn's turn", "Independent: keeps its own turn" | radios "Controlled", "Independent", described by the Help line | attach.e2e.ts:217 (lane 3) |
| An Attach row | a button named by its sentence | the same button in Row's look, the same name, `aria-expanded` on Ride, `aria-busy` and `data-attach-row` kept | none |
| The bar's group line on a rider | button "On Warhorse" | button "Riding Warhorse" | none |
| A holder's line | "Carrying Bree, Torch" for every link, actions "Put down Torch", "Let go of Goblin 2" | "Carrying Bree, Torch" and "Dragging Goblin 2", actions showing "Put down" and "Let go" with the same names as today | none: detach.test.ts:43-45 keeps its names |
| The Attach pop-up | dialog "Attach" | dialog "Attach Thorn", as the sheet | none: attach.e2e.ts:274, :297 and :369 match "Attach" in it |
| Trap pane: Afterwards | radiogroup "After it goes off" | switch "Arms again at the start of the next turn" | none |
| Trap pane: Small or larger only, Only creatures on the floor, Opens a pit, the hint, With a check | checkboxes | switches, same names | none: traps.e2e.ts reads switches and fields only |
| Trap pane: Hits | radiogroup of checkboxes | radiogroup of radios (ChoiceRows), same names | none |
| Trap pane: Who | radios "Party creatures", "Other creatures", "Any creature" | radios "Party", "Others", "Any", with a Help line | none |
| A kept ruler's remove | the ruler's words with the close cross after them | the eraser before the ruler's words, the row at the left. Its name stays "Remove the kept ruler: …" | none: options.e2e.ts:685 reads the name |
| The group window's Close, in its header and its dock | "Let go of all of them" (TokenActionBar.tsx:507, :509) | "Deselect all" | groupsave.e2e.ts:402-403 (lane 3) |
| The summary row beside a card pane | none | the column's row, "… Close the pane to answer." or "… to see them." | `lp2-1a` (lane 1) |
| The alerts summary's advice | "… Hide the bar to answer." | "… Hide the window to answer." | fold.test.ts:112-116 (lane 1) |
| The alerts over the screen | dialog "Alerts" with its own header row and a raised Close | the same dialog under SheetHeader `compact`, its icon Close named "Close" by `closeLabel` | none: dmphone.e2e.ts:592-609 reads those names |
| Known forms' step opened from the panel | none (Back "Back to the creatures" from Take a shape) | no Back, its Close the one way out | `lp2-3b` (lane 3) |

### 3.2 The docs edits

- Lane 1: FEATURES.md 53 (a map pane keeps out of the alerts on a wide screen), 260 (the Afterwards switch and the pane's sections), dm-guide.md 928 to 943: 929 (where the pane sits beside the alerts on a wide screen), 932 (Who's two-word options, the summary keeping its words), 933 and 937 ("Add an effect").
- Lane 2: FEATURES.md 197 to 200 (readouts follow the interface size, kept rulers' rows) and 446 (Interface size names the board's readouts).
- Lane 3: FEATURES.md 142 (Controlled or Independent in two words), 146 ("Riding Warhorse" on the bar), 361 (Change in the panel), dm-guide.md 859, 881 and 1046 to 1048.

## 4. Tests

**Unit** (node:test, beside the code):

- `controls.test.ts` (lane 0): a `Segmented` with a description renders `aria-describedby` to it, and without one renders none. (Lane 1): an `aria-disabled` `Checkbox` renders `aria-disabled` and no native `disabled`. The client's unit tests run without a DOM (`renderToStaticMarkup`), so clicks, keys and focus are e2e's (`lp2-1b`).
- `labelEdit.test.ts`, `barDock.test.ts` (lane 1): `paneLane` and `panePlacement` with no column, a column beside room (the card's right edge at the lane less 8), a column without it (summary, the card below the row), and a phone's sheet as today, at 1440, 844 x 390 and 820 x 1180, and at 600 px at 130%, the lane in the layout px the panes use. The real pane and alert bounds at 85% and 130% are `lp2-1a`'s.
- `rules.test.ts` (lane 1): one wording per idea in the summaries (D22), and the summaries' Who words unchanged.
- `fold.test.ts` (lane 1): the advice words, and `summaryFor` for no lane, the bar's, the pane's, and both, the pane's winning.
- `boardScale.test.ts`, a Pill layout test (lane 2): `screenPx` at 85% to 130% and inside `pillGeometry`, a `PillStack` with both warnings clamped as one box at the bottom-right corner at 100% and 130% and at the other edges, and the board view inside the insets.
- `boardText.test.ts` (lane 2): a token label beside a published trap name moves off it.
- `optionsLayout.test.ts` (lane 2): the Ruler's row with kept rulers still holds every slot at 344 and 360 with the new remove rows in ⋯.
- `Row.test.ts` (lane 3): `wrapTitle` wraps and keeps the name, `busy` and `data` land on the button, `RowChevron` is decoration and points down while expanded. An Attach list test (renderToStaticMarkup): every row's button carries `data-attach-row`. The busy state is `lp2-3c`'s.
- `tags.test.ts`, `groups.test.ts` (lane 3): the bar's words equal the panel's for a ride, a perch, a carry and a drag.

**e2e**: each lane runs the files it touches and `reach`. The layout files that guard these screens (size, layout, reach, options, bardock, dmphone, playerphone) run once on the stacked tip at integration. New steps take the lane's prefix.

| Lane | Files and new steps |
|---|---|
| 1 | traps (`lp2-1a`: at 1280 x 800, 844 x 390 and 820 x 1180, and at 85% and 130%, a trap goes off while its pane is open as a card: the pane's header, Close and folds in reach and no card's box over the pane, beside the lane or under the summary row. The summary row's tap closes the pane and puts focus on the alert, also while the token window wants the row. `lp2-1b`: Afterwards and Hits unfolded at card width, no sideways scroll, the last trigger keeping its tick and focus on a click, Space and Enter, and arrow keys through Hits change the kind and start no pick, with "Add squares" and "Place the area" still starting them), dmphone (the phone's pane row and the overlay's header, unchanged in place), fold, bardock, reach |
| 2 | options and options-dm-100 (the ruler row and kept rulers), vision (a walking ruler's total holds while it searches), `lp2-2a` in options: at 390 x 844 and 130%, the ruler's total and the drag label measure 1.3 times their 100% size and stay under the top bar, then reach |
| 3 | attach (`lp2-3a`: the list as rows spanning a 430 px sheet and the 560 px card, Ride's two-word question with its Help, at 320 x 568 and 130%. `lp2-3c`: Up, Down, Home and End across the near rows and "Farther away" in the DM's pop-up, and a player's controlled ride in a fight showing busy while it waits), groupsave (the renamed Close), resync, pcstats (`lp2-3b`: in Wild Shape, Change opens the step with no Back, its Close closes it, removing the last form leaves "Choose known forms", then close, reopen and add one, all without ending the shape, and no path reaches "Back to the creatures"), paste, dice, size (the Attach sheet with no sideways scroll at 320 and at 130%), reach |

**Guide pictures to retake** once the lanes merge: `trap-pane.webp` and `trap-card.webp` (lane 1), `walking-ruler.webp` and `movement.webp` (lane 2, the kept rulers and pills), `attach.webp`, `mounted-turn.webp`, `known-forms.webp` and `paste-offer.webp` (lane 3). The words change in each lane's docs commit (3.2).

## 5. Decided

Asking the project owner was off. The coordinator decided each question by its recommended answer after review round 1:

1. **A trap pane and the fight's alerts on a wide screen** (D1): the pane moves left of the alerts, as the token window does, and where there is no room the alerts show their one-row summary. Rejected: always folding the alerts while a pane is open (the card of a trap that just went off would hide at the moment it matters), and the pane standing over the alerts (it covers the card and its Save and damage).
2. **Ride's question** (D5): two words, "Controlled" and "Independent", side by side, with a line under them saying what the chosen one does. The words carry the rules term and the line keeps the meaning, in half the height.
3. **A trap that arms again** (D2): one switch, "Arms again at the start of the next turn", off for a trap that goes off once, as the settings around it read.
4. **Rulers and drag labels at 130%** (D14): they grow with the interface size, as every other text on the board does.
5. **Changing known forms in a shape** (D19): Change in the panel's Known forms section, as the first pass designed, kept with "Choose known forms" when a druid in Wild Shape knows none.
6. **The summary row beside a card pane** (D1, review question): its tap closes the pane, then shows the alert, as a phone's row on a pane's edge does.
7. **The known forms step opened from the panel in Wild Shape** (D19, review question): it has no Back, so Close is the one way out, and it never offers "Back to the creatures".
