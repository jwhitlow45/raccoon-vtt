# raccoon-vtt v1: the look pass

Status: reviewed in round 1. The coordinator decided its open questions (section 7): this note's recommendations, with two decisions of its own, that only the stat block's fold is shared with the token panel and that Hovers stays a 16 px Switch. Code is cited from the stacked tip `sztyppyr` (04564e15), with the roll animation. Two designs in flight are prerequisites, built on their own lanes before this pass's build: docs/design-v1-paste.md and docs/design-v1-known-forms.md (section 5).

The project owner asked on 2026-10-14: "in general we should also do a design review pass of the entire app once done with all waves and try to make the app look consistent and unified/sleek while not sacrificing functionality". On 2026-10-18 they named three things for this pass, "these aren't necessarily hard rules either i just want things that make sense given a design review":

- "the details for a character could use a similar pass the monster details had (maybe even using the same component?) ... having collapsible sections would be a big help." Then: "this was a revamp we did in the token tab not just for monsters".
- "the player stat block should be higher or even near the top. just looking for consistency here."
- "for me at least companion and character stat blocks are not differentiated the greatest right now at a glance."

This pass builds on the visual design (docs/design-v1-visual.md, "the visual design"), whose tokens, components and rules stand. It adds no tokens of its own. It finds where screens drifted from that system since it was built, answers the three call-outs, and gives the two patterns the call-outs need: a creature's page and its header. The accent stays the viewer's own member color in a room and the crest yellow `#f7df00` outside one. The old orange never returns as an interface color.

Screenshots: `screenshots/look-pass/`, kept outside the repository, taken on the stacked tip in the dev room (fixture `pcstats=1`, with `rolls=1`, `diceui=1` or `ask=...` where a name says) and on the real server for pages outside a room. Sizes in names: `p390` is 390 x 844 on touch, `p375` 375 x 667, `p360` 360 x 780, `l844` 844 x 390, `p390-130` 390 x 844 at 130%, `t820` an 820 x 1180 tablet, `d1440` 1440 x 900 with a mouse. A `tall` shot is the same width with a tall window, to show a whole panel at once. The dev room's own "Fixture" button at the top left is not part of the app.

## 1. Audit

Severity: **P1** looks broken. **P2** is inconsistent with the rest of the app. **P3** is polish.

Counted: no P1, 11 P2, 7 P3. Nothing looked broken: the visual design's sweep holds. The drift is in what was built after it (companions, PC stat blocks, the token panel's groups) and in screens it did not reach.

| # | Finding | Screenshots | Code | Sev |
|---|---|---|---|---|
| L1 | A character's details are a flat run of fourteen parts (Companions, the picture with three buttons, Name, Size, Level, Hit Points, Conditions, Rest, Stat block, Stats, Character sheet, Notes, Played by, Remove) with no folds but one. The token panel groups the same parts under Combat, Notes, Image and Stats folds that remember their state, with the picture and quick numbers in a header. The card's one fold, Stat block, is a 16 px group row standing among 13 px capitals labels | `char-player-p390tall-card-top`, `char-dm-d1440-card-top`, `callout-p390tall-card-with-companion` | features/tokens/CharacterCard.tsx:64-125 | P2 |
| L2 | The character's stat block sits 905 px down the card on a phone (1,067 for the DM), under Hit Points, Conditions and Rest. In Thorn's token panel it is 97 px from the top, right under the header | `char-player-p390-card-scroll1`, `callout-p390tall-token-thorn` | CharacterCard.tsx:113 | P2 |
| L3 | A companion's token panel and its character's look the same at a glance: the same 48 px picture in the same ally ring, the same name and quick numbers, the same "Stat block" row and ability grid, the same Combat group. "Companion of Thorn" is a small muted tag in the size line | `callout-d1440tall-token-thorn-block-open`, `callout-d1440tall-token-wolf-block-open`, `callout-p390tall-token-wolf` | panels/TokenPanel.tsx:239-280, tokens/StatBlockSection.tsx, pcstats/PcStatBlock.tsx | P2 |
| L4 | The Characters panel's forms (New character, Add a companion, a character's stat blocks) draw their own 18 px heading with Cancel or Done in the body. Every other subpage (a journal page, a monster, an encounter, the group save, the Menu's pages) uses the panel's subpage header with "Back to ..." | `callout-p390tall-companion-form`, `sweep-p390-card` | tokens/CharactersPanel.tsx:519-526, CompanionsSection.tsx:289-296, CompanionBlocks.tsx:337-345 | P2 |
| L5 | A character's details open under its row, inside the list. A DM's open card is 2,652 px on a phone, so Vex's row is about five sheet heights below Thorn's, and the sheet's title still says "Characters". Journal pages, monsters and encounters open as subpages named by what they show | `char-dm-p390-card-top`, `char-dm-p390-card-scroll5` | CharactersPanel.tsx:299-345 | P2 |
| L6 | The token window's summary names its numbers in words, "Speed 30 ft" and "Passive Perception 12", and wraps to two lines on a 300 px window. The token panel's header draws the same numbers as the footprints and "30 ft", and "PP 12", one line | `sweep-d1440-tokenbar`, `sweep-p390-token` | tokens/StatSummary.tsx:117 (VitalsLine), QuickNumbers.tsx | P2 |
| L7 | On a tablet held upright (820 px), a panel's bottom sheet spans the whole width: a field's label and its input sit 600 px apart, the HP buttons are 155 px each, and help runs over 90 characters a line | `sweep-t820-card`, `sweep-t820-tracker` | components/Sheet.tsx:149-166, pages/RoomDock.tsx:79-80 | P2 |
| L8 | The Library and the stamp picker end a failed load in a muted help line with no way to try again. The icon list's failure says the same in the same place with Try again, and the SRD's with Reload | `panel-library-p390-dm` (the dev room has no library to load) | images/LibraryGrid.tsx:169, builder/stamps/StampPicker.tsx:228, against images/IconsTab.tsx:49-55 | P2 |
| L9 | The monster filters' folds put their chevron after the label. Every other fold in the app puts it first | `dlg-monster-filters-p390` | tokens/MonsterFilters.tsx:255-282 | P2 |
| L10 | The Join page opens on the room's name and the Claim page on "DM link" or "DM device invite", neither under the crest. Home, Docs, the error pages and Admin carry `HomeHeader`, so the first page a new player sees is the one that does not look like the app | `page-join-p390-2`, `page-home-p390`, `page-notfound-p390` | pages/Join.tsx:68-74, pages/Claim.tsx:86-89 | P2 |
| L11 | The DM's Ruler on a 360 px phone puts Kept rulers behind ⋯: the row is 350.6 px even in short words, and the room is 344. At 375 it fits | `ruler-kept-p360`, `ruler-kept-p375` | measure/RulerTool.tsx:241-259 | P2 |
| L12 | Four files keep their own `Group`, a capitals label over its fields: the same thing as a `Section` with no line above it, under a name the panel kit uses for a fold | `dlg-request-roll-d1440`, `dlg-monster-editor-p390` | rolls/RequestSheet.tsx:418, pcstats/PcStatsEditor.tsx:548, monsters/MonsterEditor.tsx:402, tokens/MonsterFilters.tsx:242 | P3 |
| L13 | A field row's hint wraps inside the label's column: the character's Level hint takes five lines beside a 72 px field in the side panel | `sweep-d1440-card` | components/Field.tsx:110-118 | P3 |
| L14 | Stats gives every speed a full row, so a walker shows four rows of "none" (Fly, Swim, Climb, Burrow) | `char-player-p390-card-scroll3` | tokens/StatsSection.tsx:118-132 | P3 |
| L15 | The image picker's six sources wrap four over two on a phone, each as wide as its word | `dlg-image-picker-p390` | images/ImagePicker.tsx:181 | P3 |
| L16 | A monster's page in the Monsters panel opens with "CR 10" alone on a line between the header and the place card | `monster-block-p390` | tokens/MonstersPanel.tsx:183-186 | P3 |
| L17 | On the DM link page, Copy link wears its icon and Share beside it does not, though the icon set has `share`. The DM panel's links (the player link, a DM device invite, a new DM link, the table display link) draw the same `SecretLink` | `page-dmlink-p390` | pages/Home.tsx:367, features/dm/controls.tsx:200-237 | P3 |
| L18 | On a phone held sideways, the fight's alerts column cuts its last card at the toolbar with no cue that it scrolls. The column shows "Scroll for more" only while it stands over a docked token window | `card-saveends-dm-l844` | encounter/InitiativeStrip.tsx:845-870, :986 | P3 |

Checked and consistent: the top bar, toolbar and tool rows at every size, the side tabs and More, the party line, Initiative, Dice, Log, Journal, Areas, DM, Scenes, Monsters, Encounters, Outliner, Menu with Members, Room settings and This device, the token window and its dock under a sheet, every dialog in the brief that the dev room reaches, the roll cards, group save and save-ends cards, toasts, the shortcut sheet, Home, the Docs page and the DM guide. `scripts/style-drift.ts` finds 0 drift test findings: 89% of font sizes and 91% of spacing from tokens, every shadow a `theme.shadow`, and raw z-index only on the table display, which the drift test allows. Two dialogs were read from code, not seen: the Universal VTT import starts at the system's file picker, and the stamp picker sits behind the builder's mode menu. Both are the shared `Dialog`.

## 2. The visual system

The tokens are `client/lib/theme.ts` as the visual design landed them (its 2.1), with the z layers and layout sizes the later designs added. This pass adds no token. The patterns below say what exists, where a screen drifts, and the rule each place follows. Every rule reuses a component that exists, except two new ones: `LoadFailed` (2.9) and the creature's header (2.11).

### 2.1 Colors, type, space, radii, shadows

- Colors: surfaces `bg`, `surface`, `surfaceRaised`, text `text`, `textMuted`, `textDisabled`, status `danger`, `dangerText`, `warning`, `success`, dispositions, `accentSoft` for the turn. The accent and its tint follow the member. No drift found.
- Type: 11 tags and counts, 13 help and capitals labels, 14 body and small buttons, 16 inputs and the name of a thing, 18 titles, 20 and 24 page names. Weights 400, 600, 700. Numbers that change in place are tabular. Every Switch names its setting at 16 px. No drift found.
- Space is the 4 px grid. Radii `xs` bars, `sm` keycaps and tooltips, `md` controls and cards, `lg` dialogs and panes. Shadows `float`, `pane`, `sheet`, `dialog`. No drift found.

### 2.2 Buttons

- Exists: `Button` (primary, secondary, quiet, danger, `md` and `sm`, `pressed`, `busy`, `block`, an icon before the words). `SmallButton` (tokens/ui.tsx) and the tool rows' `OptButton` are thin wrappers over it.
- Rule: one primary per view, the action that finishes it. A page's opener (New character, New page, New encounter) is a block primary at the top of its list.
- Rule: a current choice that cannot be taken again, such as the form a Druid is in, keeps the existing chosen and disabled look (`CHOSEN_DISABLED` in components/looks.ts: no fill, a `textDisabled` outline and label). Where focus must stay on it, it is `aria-disabled` with a handler that does nothing, not native `disabled`, which would drop focus. No new look.
- Drift: L17. A pair of actions on one thing wears its icons alike.

### 2.3 Icon buttons and icons

- Exists: `IconButton` at 44 px with the tooltip, the vocabulary of docs/design-v1-icons.md 2.2, and its rules 3.1.
- Rule unchanged. One addition, for L11 only: a tool row's slot may give an icon its compact form when the row cannot hold the words, as section 3.4 says.

### 2.4 Chips and tags

- Exists: `Chip` chooses or filters (pill, 44 px, the pressed look when chosen). `Tag` states (pill, 13 px, a tone). No drift found.
- Rule: a thing a tap acts on is never a tag. So "Companion of Thorn" leaves the tags and becomes a link in the header's kind line (2.11).

### 2.5 Rows

- Exists: `Row` (title, detail, leading disk, trailing slot), card rows where the row is a button, `RowList` with lines between.
- Rule: a row that opens a thing in its place shows a chevron right at its end and opens a subpage. A row that unfolds under itself (`expanded`) is for a short body, such as a companion's stat block in its character's list. A character's details are long, so its row opens a page (L5).

### 2.6 Folds and groups

Three levels, one look each, chevron first everywhere:

| Level | Component | Look | Where |
|---|---|---|---|
| A part of a panel or a page | `Group` (components/Panel.tsx) | 48 px row, chevron, name at 16 px weight 700, summary at the right while folded, an action after it, a line above | the token panel, and now the character's page (3.1) |
| A part inside a group, a dialog or a short panel | `Section` with `fold` | 13 px capitals label with the chevron before it, a summary after | Dice's Skills, Request a roll's What players see, the Library's starter packs, and now the monster filters (L9) |
| An item in a list | `Row` with `expanded` | the row's own look, chevron at its end | a companion's stat blocks, the Characters list today |

Folds remember their state per device where a panel opens often (`panelFolds.ts`), and nowhere else. The Outliner's groups and the Scenes panel's folders draw their own headers inside their lists, in the `Group` look, and stay: the Outliner's list is virtualized and its headers must be rows of it.

### 2.7 Sections and headers

- Exists: `Section` and `SectionLabel` (13 px capitals, muted, a danger tone), `SheetHeader` (56 px in a sheet, 44 px `compact` in the side panel), and `usePanelHeader` for a subpage, whose back button says where it goes.
- Rule: a panel that shows one thing in its place names it in the header and goes back with "Back to ...". It never draws its own heading and Cancel or Done in the body (L4). A form keeps its Cancel at its foot, beside its main button, as a dialog's footer does.

### 2.8 Sheets and dialogs

- Exists: `Sheet` (from the foot on a phone upright, at the right on a phone sideways), `Dialog` (`fill` or `sheet` on a phone, `sm`, `md` or `lg` on a computer).
- Rule, new for L7: a bottom sheet is never wider than a `md` dialog, 560 layout px, and centers over the map. The dock row on its top edge (docs/design-v1-visual.md 3.2.1) takes the sheet's width and place. A phone, under 560 layout px wide, sees no change.

### 2.9 Empty, loading and error states

- Exists: `Empty` (one sentence and at most one button), `Loading` after 200 ms, `Notice` for what floats or lasts, `ErrorText` for a field or a form.
- Rule: a load that failed says what failed and what still works, in one line, as an alert, with Try again (`retry`) where trying again can succeed, or Reload where only a reload can (a chunk after an update). The icon list's muted alert line is the model (images/IconsTab.tsx:49-55). It becomes `components/LoadFailed.tsx`, and the Library and the stamp picker take it (L8). `SrdLoadFailed`'s inline form takes the same line in place of its red text and keeps its Reload, with Reload's wait for pending changes and its reopen after the reload. Its other form, a danger `Notice` where the failure stands in a whole panel's place (the SRD monster list), stays: there it is the panel's state, as a panel's own load failure is.

### 2.10 Numbers and units

- Exists: AC on its shield, Speed after the footprints, "PP" for Passive Perception, "Init" for Initiative, the elevation as "↑20 ft", HP as "18/24" with temporary HP as "+5" in the ally blue, a true minus for modifiers, "ft" after a space. Each quick number is one image to a screen reader, named in full ("Passive Perception 12").
- Rule: these units read the same wherever a creature's numbers are summed up: the token panel's header, the character's header, and the token window's summary line, which keeps HP in its words since it leads the HP entry under it (L6). A stat block keeps its own words: it reads as the book does.

### 2.11 New: a creature's header

`features/tokens/CreatureHeader.tsx`, taken out of the token panel's `NameBlock` and `Thumbnail` (TokenPanel.tsx:239-280), so the token panel and the character's page open alike:

```
 (pic)  Thorn                                  name, 18 px weight 700, wraps
        Level 5 character · Medium (5 ft)      the kind line, 13 px muted
        [Hidden from players]                  tags, as today
        [16]  👣 30 ft   PP 14   Init +0  Sheet the quick numbers
```

- **The picture**: 48 px, ringed in the disposition's color, decoration. A companion's carries its character's portrait as a 20 px disk at its lower right, inside a 2 px ring of the surface's color (3.3).
- **The kind line** says what the creature is, then its size, from one pure function, `kindLine()` in `features/tokens/creatureKind.ts`:

| Creature | Kind line |
|---|---|
| Player character with a level | "Level 5 character · Medium (5 ft)" |
| Player character with no level | "Character · Medium (5 ft)" |
| A character in Wild Shape (the viewer's copy holds it) | "Level 5 character in Wild Shape as Brown Bear · Large (10 ft)" |
| A character in another shape, such as Polymorph | "Level 5 character in the shape of Brown Bear · Large (10 ft)" |
| Companion | "Companion of Thorn · Medium (5 ft)": the first part a quiet link that opens Thorn's page, where the viewer may open it, else text |
| Monster or NPC whose CR the viewer's copy holds | "Monster, CR 1/4 · Small (5 ft)" or "NPC, CR 2 · Medium (5 ft)" |
| Monster or NPC otherwise | "Monster · Small (5 ft)" |
| Object | "Object · Medium (5 ft)" |

The shapes take `shapeNote`'s words for each kind (features/pcstats/shape.ts), and a character with no level reads "Character in the shape of ...". "Companion of Thorn" is always its own element, a link or plain text, with exactly those words, so `e2e/combat.e2e.ts:1119` still finds it. A custom size keeps today's "10 by 15 ft".

## 3. The project owner's call-outs

### 3.1 A character's details, grouped as the token panel is

**The problem** (L1, L4, L5). The card the Characters panel opens is the token panel before its regrouping: every section open, in a list, with a different header, under its row in the list.

**Options.**

- **A. The token panel's parts on a page of its own (recommended).** The character's details become a subpage of the Characters panel, named by the character, with "Back to Characters". It opens with the creature's header (2.11), then the same `Group`s the token panel uses, remembered per device as the token panel's are. Its own content stays its own: no Position, Sight, range rings or token settings, which belong to a token on a map.
- **B. One component for both.** Draw the character through the token panel's `TokenDetails` with a character for a subject. Rejected: most of that panel's parts are a token's (position, sight, rings, other images, disposition, layer), so each would branch on the subject, the panel's order and fold tests would split in two, and `e2e/tokenpanel.e2e.ts` would churn for no change a user sees.
- **C. Groups in place.** Wrap the card's sections in `Group`s and keep it under its row. The cheapest, but the card stays a 2,000 px disclosure inside a list, with its own header and its title "Characters".

**The page (A).**

```
 <  Thorn                                    ×   the subpage header: Back to Characters
 (T)  Thorn
      Level 5 character · Medium (5 ft)
      [16]  👣 30 ft   PP 14   Init +0  Sheet
 [Place my token]   or "Thorn is on the map."   the DM's: Place a token
 > Stat block                 [Take a shape]    folded: "Level 5, PB +3"
 v Combat          HP 18/24 +5 · 2 conditions   Hit Points, Conditions, Rest
 v Companions                         Wolf      the list, Add a companion, Stat blocks (1)
 > Notes                              1 note    On the card, For DMs only (the DM)
 > Image                                        Change image, Crop, Remove
 > Stats                                        Name, Size (the DM), Level, AC, Speeds, Hovers,
                                                Initiative, Passive Perception, Senses, Sheet link
 > Played by                          Thorn     the DM's: who plays it
   REMOVE                                       Delete Thorn, or the shared note
```

- **Order**, by use as the token panel's: the header, the stat block (3.2), Combat, Companions, Notes, then setup folded at the foot. Companions sits after Combat: a player opens the page for companions more often than to edit its numbers (docs/design-v1-combat-flow.md 3.7.5), and it stays open by default, so it is one short scroll from the top.
- **`cardGroups(input)`** in `panelOrder.ts`, beside `panelGroups`, a pure function: which groups show for the DM, a player who plays it, and with or without a block, companions or notes.
- **Folds** live in the token panel's store (`panelFolds.ts`). The page shares one key with the token panel, `statBlock` in the `own` relation, so a character's block opens or folds alike in both places and opens by default from 900 x 600. Its other groups get keys of their own, `page.combat`, `page.companions`, `page.notes`, `page.image`, `page.stats` and `page.owners`, since fold keys hold no creature: shared, a DM folding Combat on a character would fold Combat on every monster in the next fight (7.2). Combat and Companions start open, the rest folded.
- **Empty groups are not drawn**: Notes with nothing to read and no right to write, Played by for a player, Companions for a viewer who may add none and sees none.
- **Which page is open** lives in a Room-scoped slot, `characterPageSlot` in `features/tokens/characterPage.ts` (new, lane 1's), as `journalSlot` holds the open journal page. So it survives the remount when the width crosses 900 px, and the header's "Companion of Thorn" link sets it and opens Characters through the panel API (`ui.openPanel("characters")`).
- **A player with one character** lands on its page, as the card opens for them today. Back shows the list with "The party" under it.
- **Focus**: opening a page focuses its heading, as a journal page does. Back returns focus to the character's row (`data-opener`). A delete returns to the list and keeps today's hand-off to the next row (`useDeleteHandOff`). A refused delete leaves the page open, and focus lands on its heading, since the refusal can take Delete away (the DM shared the character meanwhile).
- **The forms** (L4): New character, Add a companion and a character's stat blocks become subpages through `usePanelHeader`: "New character" with "Back to Characters", "Add a companion for Thorn" and "Thorn's stat blocks" with "Back to Thorn". A form with typed changes arms Back as "Discard changes?", as the encounter editor does. Cancel moves from the heading's row to the form's foot, beside its main button, and with typed changes it asks "Discard changes?" as Back does. The stat blocks page is a list, not a form: it has Back only, and its Done goes. The headings keep their words, now in the subpage header.
- **Stats** (L14): Walk Speed, then a row for each other speed that is set, then "Other speeds" as a `Section` fold, folded, holding the rest and Hovers. The token panel's Stats group shares `StatsFields`, so it gains the same.

Heights today, from the dev room with the card open: 1,919 px for Thorn's player on a 390 phone, 2,652 for the DM. With A, measured from today's parts, Thorn's page is about 1,190 px for his player with Combat and Companions open (the header 96, the actions row 52, Stat block 49, Combat about 550, Companions about 130, three folded rows, Remove 163). The sheet's first screen holds the header, the Stat block row and Hit Points, where today it holds the companions and the picture's buttons.

### 3.2 The stat block near the top

**The problem** (L2). The card puts the character's stat block after Rest. The token panel puts it right under the header.

**Options.**

- **A. Right under the header, folded by the token panel's rule (recommended).** The `Stat block` group follows the header and the actions row, open by default from 900 x 600, folded on a phone, where a block of one to three screens would push Hit Points out of view. Its folded summary says what it holds, so it reads without opening (3.3).
- **B. Under the header and always open.** Rejected: on a phone the block takes the first one to three screens, and Combat moves below it.
- **C. Pinned to the page's top while scrolling.** Rejected: a sticky block over the sheet's body costs a phone a third of its sheet.

### 3.3 Telling a companion from its character

**The problem** (L3). Both panels draw the same header in the same ally ring, the same Stat block row and the same ability grid. The one mark, the "Companion of Thorn" tag, is small and muted, in the line with the size.

**Options.**

- **A. Name what it is, in the header and the stat block's row (recommended).**
  - The kind line (2.11) says "Level 5 character" or "Companion of Thorn" on the line under the name, in the same place on every creature, and the companion's is a link to its character's page.
  - The companion's picture carries its character's portrait at its corner, so the tie reads before the words.
  - The `Stat block` row's folded summary names its source:
    - A character with a block: "Level 5, PB +3", or "Level not set" with no level. With no block: "None yet", as today. Known forms add "4 known forms" after either.
    - A character in a shape: "Wild Shape: Brown Bear", or "Shape: Brown Bear" for another shape.
    - A companion's or a monster's linked block: its name and CR, "Wolf, CR 1/4". An SRD block still loading, or one that failed, shows its name alone (`srdTitle`, which needs no load).
    - Open, the character's block starts "Level 5, PB +3" and the companion's with its title and type line, as today.
- **B. A tint or stripe of its own.** Give a companion's header or block a colored edge. Rejected: color means a status, a disposition or a member here (the visual design's principle 1), and a color beside an ally ring would read as one of those.
- **C. Keep a companion's block on its character's page only.** Rejected: it takes the block from the companion's panel and its action bar's "Stat block", which players use mid-fight.

The portrait badge shows in the panel's header only. The board keeps its token rings and badges as they are (7.5).

### 3.4 The known item: the DM's Ruler at 360 px

**The problem** (L11). Shared (98 px), Keep (60.6), Clear (86) and "Kept (2)" (94) need 350.6 px with their gaps, and a 360 px phone's row has 344. The fit's step 1 already takes every compact form, so Kept goes behind ⋯ by step 2 (docs/design-v1-tool-options.md 6.3).

**Options.**

- **A. Clear's compact form is its eraser alone (recommended).** Clear's slot gains a compact form, the `eraser` icon at 44 px, named "Clear" with its tooltip and long-press name, taken only in step 1 when the row cannot hold the words. The row needs 308.6 px, so every control stays in view at 344. It bends icons rule 3.1.2 (icon plus words on touch) for one control at one width, where the other choice hides a control.
- **B. Clear goes behind ⋯ before Kept.** Swap their priorities. No new form, but the live ruler's Clear, used after every measure the DM shows players, takes two taps on these phones.
- **C. Leave it**, as the tool options follow-up decided. The kept rulers stay one more tap away on every 360 px phone, a common Android width.

## 4. The fixes

Eight lanes, each a builder in its own workspace. No lane changes a protocol, an op, stored data or a snapshot, and no feature is removed. Every lane starts from the stacked tip after paste and known forms merge (section 5), since lanes 1, 4 and 7 touch files those two change.

- **Files.** Each lane owns the files its row names. Two e2e files are shared by line range, not sequenced: lane 1 edits `tokenpanel.e2e.ts:1766-1780` and `size.e2e.ts:556-570`, lane 2 edits `tokenpanel.e2e.ts` at 594, 1155 and 1324, and lane 3 adds its tablet case to `size.e2e.ts` outside lane 1's range. So the hunks never meet and all eight lanes run in parallel. Lane 7 runs `size.e2e.ts` and edits none of it.
- **Docs.** No lane edits FEATURES.md or docs/dm-guide.md. Each lane lists the edits it needs in its report, and one docs commit after the lanes merge makes them all (4.2).

| Lane | Fixes | Commits | Files it owns |
|---|---|---|---|
| 1. Creature pages | L1 to L5, L14 (3.1 to 3.3) | `refactor(tokens): the creature header out of the token panel`, `feat(tokens): the kind line and a companion's portrait badge`, `feat(tokens): the stat block's folded summary names its source`, `feat(characters): a character's details as a page of groups`, `feat(characters): the panel's forms as subpages`, `feat(tokens): other speeds fold under Walk` | features/tokens/CreatureHeader.tsx, creatureKind.ts, characterPage.ts (all new) and their tests, panels/TokenPanel.tsx, tokens/CharacterCard.tsx, CharactersPanel.tsx, CompanionsSection.tsx, CompanionBlocks.tsx, StatBlockSection.tsx, StatsSection.tsx, panelOrder.ts, panelFolds.ts and their tests, pcstats/PcStatBlock.tsx, e2e/characters.e2e.ts, companions.e2e.ts, pcstats.e2e.ts, splitpanel.e2e.ts, and the ranges above |
| 2. Summary units | L6 | `fix(tokens): the token window's summary draws the quick numbers' units` | features/tokens/StatSummary.tsx, QuickNumbers.tsx, statSummary.ts and its test, its lines of e2e/tokenpanel.e2e.ts |
| 3. Sheets on tablets | L7 | `fix(sheets): a bottom sheet is no wider than a medium dialog`, `fix(room): the dock row follows the sheet` | components/Sheet.tsx, components/sheetCap.ts and its test, pages/RoomDock.tsx, e2e/fold.e2e.ts, its case in e2e/size.e2e.ts |
| 4. Load failures | L8 | `feat(ui): one look for a load that failed`, `fix(images): the library's failure offers Try again` | components/LoadFailed.tsx (new) and its test, features/monsters/SrdLoadFailed.tsx, features/images/IconsTab.tsx, LibraryGrid.tsx, library.ts, features/builder/stamps/StampPicker.tsx, one new step in e2e/pdf.e2e.ts |
| 5. Folds and form groups | L9, L12 | `refactor(ui): dialog groups are sections`, `fix(monsters): the filters fold like every other fold` | features/rolls/RequestSheet.tsx, features/pcstats/PcStatsEditor.tsx, features/monsters/MonsterEditor.tsx, features/tokens/MonsterFilters.tsx |
| 6. Pages | L10, L17 | `fix(pages): Join and Claim open under the crest`, `fix(ui): Share wears its icon beside Copy link` | pages/Join.tsx, pages/Claim.tsx, pages/Home.tsx, features/dm/controls.tsx |
| 7. Panel details | L13, L15, L16, L18 | `fix(ui): a field's hint runs under its whole row`, `fix(images): the sources sit in a grid of threes`, `fix(monsters): CR moves into the place card's first line`, `fix(encounter): the alerts column says when it scrolls` | components/Field.tsx, features/images/ImagePicker.tsx, features/tokens/MonstersPanel.tsx, features/encounter/InitiativeStrip.tsx |
| 8. Ruler | L11 (3.4) | `fix(ruler): Clear's compact form is its eraser` | features/measure/RulerTool.tsx, features/measure/controls.tsx (OptButton's compact icon), client/pages/optionsLayout.test.ts, e2e/options.e2e.ts |

Notes per lane:

- **Lane 1** is the largest and runs as one builder, since its parts share the header, the folds and the page. Its commits land in the order listed. It migrates every e2e line its page and subpages break:
  - `characters.e2e.ts:134-135` and `companions.e2e.ts:196` read a row's `aria-expanded` or click another character's row, which a page hides. They open a character through Back and its row instead.
  - `tokenpanel.e2e.ts:1766-1780` reads Thorn's row, which a player with one character no longer sees, and clicks Add or Change image, which moves into the folded Image group.
  - `splitpanel.e2e.ts:398` and `:858` wait on "Character name", which moves into the folded Stats group.
  - `size.e2e.ts:556-570` and the Done clicks at `companions.e2e.ts:380`, `:679`, `:941`, `:982` and `:1025` press Done, which becomes "Back to Thorn".
  - `companions.e2e.ts:975` and `:1021` find the stat blocks page by a heading inside `[data-pane-body]`, and the heading moves into the subpage header, outside the body.
  - New steps cover the page a player with one character lands on.
- **Lane 2**: `VitalsLine` draws Speed and Passive Perception with the units `QuickNumbers` exports, and keeps HP and AC as they are. "More stats" follows. Its three `tokenpanel.e2e.ts` checks read the units' names instead of the bar's text.
- **Lane 3**: the sheet's cap gains a width, `min(100%, layout.dialog.md)`, centered with the safe areas kept. The landscape sheet and the side panel do not change. `fold.e2e.ts` checks the dock row's edges match the sheet's at 820 x 1180, and `size.e2e.ts` gains that size with no sideways scroll.
- **Lane 4**: `useLibrary` gains `retry()`. `LoadFailed` takes the words and `retry` or `reload`, and draws IconsTab's line: `role="alert"`, muted text, the button at the right. Its step in `pdf.e2e.ts`, which opens the Library, fails the assets list (`api.listAssets`, a GET) with `page.route`, checks that the images already on the map stay usable, presses Try again, sees the loading line, and lets the retry succeed.
- **Lane 5**: the local `Group`s of RequestSheet, PcStatsEditor and MonsterEditor become `Section` with `divider={false}`. MonsterFilters' `Group` is already a `Section` with its line and stays. Its `Fold` becomes `Section` with `fold`, its "2 on" tag in the summary slot (4.1).
- **Lane 6**: `SecretLink`'s Share takes the `share` icon, so the DM panel's links (Access.tsx, TableDisplay.tsx) change with it, unedited. Home's DM link Share takes it too.
- **Lane 7**: a field row's hint moves out of its `<label>` to run under the whole row (`flexBasis: 100%`), tied to its control with `aria-describedby`. In the app no row names its control through `htmlFor` and also has a hint (only the kit page does), so no accessible name changes. The alerts column's existing `ScrollForMore`, shown today only over a docked token window (`stacked !== null && clipped`, InitiativeStrip.tsx:986), shows whenever the column is `clipped`, with `SHADOW_ROOM`'s bottom padding as its `inset`.

### 4.1 Names and roles that change

Everything not listed keeps its role and accessible name.

| Control | Today | After | e2e |
|---|---|---|---|
| A character's row | a disclosure button, `aria-expanded` | a button that opens the character's page, with a chevron right | lane 1 migrates the helpers (4, lane 1's notes) |
| The character's page | none | a subpage header, its title the character's name, Back named "Back to Characters" | lane 1 adds the steps |
| New character, Add a companion, a character's stat blocks | an h3 in the body with Cancel or Done beside it | the subpage header's title with Back. The forms' Cancel at their foot, the list's Done gone | lane 1 migrates the Done clicks and the heading filters |
| "Companion of Thorn" in the token panel | a tag's text | its own element with the same words: a link button where the viewer may open the character, else text | none: combat.e2e.ts:1119 finds the text |
| The token window's Speed and Passive Perception | text "Speed 30 ft", "Passive Perception 9" | images named "Speed 30 ft" and "Passive Perception 9", drawn as the footprints with "30 ft", and "PP 9" | lane 2's three checks |
| The Ruler's Clear at 360 px | button "Clear", its eraser and its word, with the kept rulers' chip behind ⋯ | button "Clear", its eraser alone, with the chip in the row | none |
| The monster filters' folds | disclosure buttons named with their count ("Movement 2 on"), chevron last | named by the title alone ("Movement"), the count as the fold's summary, chevron first | none: no e2e names them |
| The Join page's room name | an h1 under a "Room" line | the same h1 in the crest's header, the room ID under it | none |

### 4.2 The docs commit

After the lanes merge, one commit makes the FEATURES.md and docs/dm-guide.md edits the lanes listed, and the "Changed by docs/design-v1-look-pass.md" lines in docs/design-v1-pc-stats.md 7.1, docs/design-v1-companion-stat-blocks.md 6.4 and docs/design-v1-token-panel-groups.md. A character's "card" becomes its "page" wherever the words mean the details: dm-guide.md lines 791, 797, 812, 822 and 1003, and FEATURES.md lines 60, 270, 322, 324, 327 and 328.

## 5. What is in flight

Two designs are being built on other lanes, and their notes land with them, so neither file is at this tip. They are prerequisites: the look pass's lanes start after both merge. This pass does not redesign them. Their new UI follows the system as below.

- **Pasting images** (docs/design-v1-paste.md). "Paste an image" is a secondary `Button` at `sm` in the row of its entry's file control, words only, as the icons design kept paste. The paste box is drawn with `fieldStyle()`: 44 px, 16 px text, the `bg` fill and the `controlBorder` outline, with its line under it as `Help`. "Use the pasted image" is the one `Dialog` in `sheet` mode, its choices as card `Row`s with a title and a detail line, none of them a primary. A refusal or an empty clipboard shows as `ErrorText` under its entry, "The clipboard held 3 images" as `Help`, and every wait as the entry's own busy button and `Loading`. It changes ImagePicker.tsx and StampPicker.tsx, which lanes 7 and 4 touch after it.
- **A Druid's known forms** (docs/design-v1-known-forms.md). The "Known forms" section inside the Stat block group is a `Section`, so its label is a 13 px capitals h4 under the group's row, with Change as a secondary `sm` button in its action slot. The forms are `sm` buttons that act, not chips. The current form is pressed and cannot be taken again, so it takes the `CHOSEN_DISABLED` look through `aria-disabled` with a handler that does nothing, keeping focus where it is (2.2). `Row`'s new `pressed` takes the chosen look (accent tint and border) with a check in its leading slot. Marks are muted `Tag`s. The folded summary "4 known forms" joins lane 1's summary (3.3). It changes PcStatBlock.tsx, which lane 1 touches after it.

## 6. Tests

**Unit** (node:test, beside the code):

- `creatureKind.test.ts` (lane 1): every row of the kind line's table, Wild Shape and another shape, a character with no level and one with no block, a CR the viewer's copy lacks, and a custom size. The Stat block summary's every case of 3.3, both shapes and an SRD block not loaded included.
- `panelOrder.test.ts` (lane 1): `cardGroups` for the DM, a player who plays the character alone, a shared character, no block, a block, companions and none, and that each part shows exactly once.
- `panelFolds.test.ts` (lane 1): the page's keys and their defaults (Combat and Companions open), that folding the page's Combat leaves the token panel's Combat as it was, and that `statBlock` is the one key both read.
- `statSummary.test.ts` (lane 2): the window's units equal the header's for the same creature, each named in full.
- `sheetCap.test.ts` (lane 3): the width cap at 820, 744 and 600 layout px, none at 560 and under, none in landscape.
- `LoadFailed` markup through `renderToStaticMarkup` (lane 4): an alert, its words, Try again with the `retry` icon.
- `optionsLayout.test.ts` (lane 8): the DM's Ruler with two kept rulers keeps every slot inline at 344 and 343 with Clear compact, and at 374 keeps Clear's words.

**e2e** (touched files only, plus `reach` for every lane): the layout files that already guard these screens are `size`, `layout`, `reach`, `reach-player-100`, `reach-player-130`, the `options` files and `fold`.

| Lane | Files |
|---|---|
| 1 | characters (the page opens and goes back, a player with one character lands on it, focus on open, Back, delete and a refused delete, no sideways scroll at 320 px and at 130%), companions (the kind line and the link to the character's page, the forms' Back and Cancel), pcstats (the stat block's row lines up with Combat's on the page as in the token panel), and the files it migrates: splitpanel, size, tokenpanel. Then reach |
| 2 | tokenpanel, reach |
| 3 | fold, size, reach |
| 4 | pdf (the Library's forced failure and its retry), reach |
| 5 | tools (Request a roll), reach |
| 6 | smoke (join and claim), reach |
| 7 | size (run, not edited: its image picker case covers the grid), reach |
| 8 | options, reach |

**Guide screenshots to retake** once lanes 1 and 2 merge: `pc-stats.webp` (Thorn's card becomes his page), `companion.webp` (Add a companion as a subpage), `action-bar.webp` and `boss.webp` (the window's summary units). The words change in the docs commit (4.2).

## 7. Decided by the coordinator

Asking the project owner was off. The coordinator decided each question after round 1:

1. **A character's details open as a page of their own**, "Back to Characters", rather than under its row (3.1 A). It matches journal pages, monsters and encounters, names the sheet by the character, and keeps a DM's list short.
2. **The page shares only the stat block's fold with the token panel.** Its other groups keep folds of their own, since a fold key names no creature and a DM is the `own` viewer of every monster: a shared Combat fold would fold every monster's Combat in the next fight (3.1).
3. **On a tablet held upright, panels stay bottom sheets, capped at 560 px and centered** (2.8). It changes one width and keeps every fold and dock rule of portrait.
4. **The DM's Ruler on a 360 px phone gives Clear its eraser alone**, only where the words do not fit (3.4 A), so every ruler control stays in view.
5. **A companion's picture carries its character's portrait in its panel only.** The board's badges are full, and the tracker already lists a companion under its character.
6. **Hovers stays a 16 px Switch**, as every switch names its setting. Switch.tsx changes nowhere.
