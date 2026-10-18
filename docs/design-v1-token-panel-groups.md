# raccoon-vtt v1: the Token panel grouped by use

Status: built, with the dice UI pass the project owner took on 2026-10-17 (docs/design-v1-dice-ui.md 12). Part of the dice UI pass (docs/design-v1-dice-ui.md, which holds the shared rules this document uses: its section 3) and the icon pass (docs/design-v1-icons.md).

The project owner, 2026-10-17: "the token panel could also use a pass to cleanup. the ac/speed/passive perception and anything else that goes there should probably go at the top by name/size, the hp/conditions/range rings/rest should probably have their own drop down, as should notes. ill let you come up with exact intricacies but there's a lot there that could be collapsible (though the more used ones should start open)". And then: "not all of those have to be their own collapsible section, they can be grouped for stuff that is combat relevant vs notes".

Screenshots: `screenshots/dice-ui/audit/` (`*-token-*`, before) and `.../proposal/` (`*-token-*`, after), at 1280 x 800, 390 x 844, 375 x 667, 844 x 390 and 390 x 844 at 130%, for the DM on a goblin and on Thorn, and a player on Thorn and on a goblin.

## 1. What the audit found

Ranked by what it costs at the table.

1. **The numbers asked for most are buried.** AC, speed and Passive Perception sit inside the stat block's header, under its fold, a screen below the name on a phone (`p-token-player-thorn-01`). A player asking "what's my AC" scrolls past the picture's four buttons first.
2. **The picture's buttons take two rows** (Change image, Add another image, Crop, Remove: 100 px on a phone) at the top of a panel opened mostly mid-fight.
3. **Everything is open.** A DM's goblin is 2,845 px of panel on a computer (five heights of the side panel) and 1,892 px on a phone (four heights of the sheet): Hit points, Conditions, Position, Range rings, Notes (three fields), Rest and Sight each draw a full section. A player's own character is 1,558 px on a phone. With the groups: 2,301, 1,344 and 1,142 px (the dice doc's Appendix A), and the first screen holds the name, the quick numbers, the stat block's row and Hit points.
4. **Two folds look like sections.** Stats, Token settings and Owners fold behind 13 px capitals labels, the same look as the open sections' labels, so a reader cannot tell which labels open something.

## 2. The new order

The panel is a header, then groups by use, then setup. The order inside a group is today's ranking (docs/design-v1-token-panel.md 3.5, `panelOrder.ts`), so nothing moves relative to its neighbors.

| Part | Holds | Folded summary | DM | A player, own creature | A player, another creature |
|---|---|---|---|---|---|
| Header | Picture, name, size and tags, quick numbers | never folds | shown | shown | shown |
| Stat block | The block, or "Add a stat block" and "Take a shape" | none: the quick numbers moved up | open from 900 x 600 up, as today | as today | as today (it shows only where `statBlockShown` allows) |
| Combat | Hit points, Conditions, Range rings, Rest | "3/7 HP · 2 conditions · rings 30 ft" | open | open | open |
| Notes | For everyone, On the card, For DMs only | "2 notes", "None yet" | folded | folded | open, when a note for everyone exists |
| Position | Elevation and facing, Sight | "Elevation 30 ft, facing 90°", "On the ground" | folded | folded | not drawn: its elevation is a quick number |
| Image | Change image, other images, Crop, Remove | none | folded | folded | not drawn: nothing to change |
| Stats, Token settings, Companion, Owners | as today | Owners keeps its names | folded | folded | not drawn, as today |
| Remove | Delete this token | | shown | | |

Why these groups:

- **Combat** holds what changes in a fight, the owner's list. Rest sits there because it changes HP and spends dice, and the owner named it.
- **Notes** is read, not changed, mid-fight. A player looking at another creature sees only the DM's note "for everyone", the reason to open it for them.
- **Position** joins elevation and facing with Sight, both setup-like and rarely touched at the table. Elevation is also a quick number, so folding it hides nothing a player needs to read.
- **Image** moves the four picture buttons out of the top. The picture itself stays at the top as the header's 48 px thumbnail.

## 3. The header

```
 (G)  Goblin 1
      Medium (5 ft)  [Hidden from players]
      [13]  👣 30 ft   PP 12   Init +2   ↑20 ft
```

- **Picture**: 48 px at the left, the image field's preview (`ImagePreview`), ringed in the disposition's color, decoration (`aria-hidden`): the name is the heading.
- **Name**: 18 px weight 700, wrapping, as today. Size and tags under it, as today.
- **Quick numbers** (`QuickNumbers.tsx`): one wrapping line of unbreakable units, `space(3)` apart. Each is one image to a screen reader with its full words, and the same words are its tooltip:
  - AC on its shield (`AcBadge`, "Armor Class 13").
  - Speed after the footprints (`speed`, docs/design-v1-icons.md 2.2): "30 ft", "30 ft, fly 60 ft" ("Speed 30 ft, fly 60 ft").
  - "PP 12" ("Passive Perception 12"). The word stays: an eye alone reads as vision or "shown to players" on a phone (icons doc 3.1 rule 2).
  - "Init +2" ("Initiative +2"), new here: the tracker's roll uses it, and the DM asked for it often in play.
  - The elevation when off the ground, "↑20 ft", as the token's badge on the map (`elevationBadge`).
  - The sheet link, "Sheet" and its `external` icon, 44 px tall, where the actor has one.
- **Who sees what**: exactly what `vitals()` gives each viewer today (`statSummary.ts`): AC, speed and PP only where the viewer's copy holds them, so a player looking at a monster sees its elevation and nothing it hides. Init follows the same rule (`initBonus` on the viewer's copy).
- **Room**: on a 390 px phone the line holds all five at 100% and wraps once at 130%.

## 4. The group's look

`Group` in `components/Panel.tsx`:

- A 48 px row: a chevron (`chevronRight` or `chevronDown`, muted, 16 px), the name at 16 px weight 700 in text color, and while folded a one-line summary at the right, 13 px muted, cut with an ellipsis. The whole row is the disclosure button (`aria-expanded`), named by the group's name alone, so the name never changes with its state.
- An **action** slot after the button on the same row, outside the disclosure: "Take a shape", "Attach a stat block".
- A 1 px line above each group. **Inside a group, sections part by `space(4)` with no line**, and keep their 13 px capitals labels ("HIT POINTS"), so the two levels never look alike. `Section` reads this from context, so no section's code changes.
- A group that never folds (a block with nothing to fold) is the same row with no chevron.
- Stats, Token settings, Owners and the stat block take the same look, so every fold in the panel is one thing to learn.

## 5. Remembered per device

- The folds stay in `rvtt.tokenPanelFolds` (`panelFolds.ts`), one device's choice, never sent to the room. New keys: `combat`, `notes`, `position`, `image`. A key never tapped follows its default.
- **By relation.** A player's tap on another creature's Notes must not fold their own character's. Combat, Notes and the stat block are keyed by relation (`panelRelation`, `relationKey`): `own` (the DM, or an owner) and `other`, as `notes` and `other.notes`. Another creature's Notes starts open: it shows only with the DM's note for everyone.
- "View as a player" reads the folds and never writes them, as today.
- A request that opens the stat block (docs/design-v1-token-panel.md 3.4) still opens it whatever the fold says.

## 6. What must not change

- Every control stays, in the same section, with its name. Folded controls are not drawn, as today's folds, so a field being typed in commits before its group folds (the fold focuses itself first, `FoldLabel`'s rule).
- The section headings stay headings with the same words ("Hit points", "Conditions"), so `e2e/tokenpanel.e2e.ts` and the other suites that find a section by its heading keep working. The groups add headings "Combat", "Notes", "Position", "Image" one level up.
- Combat starts open on every layout, so HP and conditions are where they are today on first use.
- 44 px targets: the group row is 48 px.

## 7. Edge cases

| Case | Outcome |
|---|---|
| An object (a chest) | Header without speed, PP or Init. Combat holds Hit points only. No Rest, as today |
| A hidden token (DM) | The "Hidden from players" tag in the header, as today |
| A player looking at a monster with hidden HP and no notes | Header (name, size, elevation), Combat with Conditions only, nothing else |
| A companion | Its Companion fold beside Owners, as today, in the group look |
| A name of 80 characters | Wraps beside the picture, the numbers under it |
| 130% at 375 x 667 | The quick numbers wrap to two lines. Group rows stay 48 px |
| A group with nothing to show | Not drawn (Notes for a player with no note, Position for another's creature) |
| A shape (Wild Shape) | "Take a shape" sits on the stat block's row. The shape's block and "Rolls now" inside, as today |

## 8. Tests

- `panelOrder.test.ts`: the pure `panelGroups(input)` returns the groups and their sections per role, for the DM, an owner, another player, an object and a companion, and places every section exactly once.
- `panelFolds.test.ts`: the new keys' defaults (Combat open everywhere, the rest folded), and the relation split.
- `QuickNumbers.test.ts`: the units per viewer, from `vitals()`'s items, each unit's full name, and the sheet link.
- e2e (touched files only, plus `reach`): `tokenpanel.e2e.ts` (open a group, fold it, the summary's words, the quick numbers on a phone and a computer), `size.e2e.ts` (no sideways scroll at 320 px and 130%).

## 9. Build plan

One part, after the dice UI part's Panel.tsx commit (Group): QuickNumbers and the header, then the groups and their folds, then the relation keys, then FEATURES.md ("The Token panel groups what a fight changes, and keeps AC, speed and Passive Perception under the name").
